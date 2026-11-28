#!/usr/bin/env node
/**
 * t3-box-router CLI (Node 18+, no dependencies). Chooses the machine a T3 task runs on.
 *
 * This file orchestrates commands: it parses and validates flags, reads stdin, refreshes T3 link facts and runs
 * bring-up hooks outside the state lock, then makes each decision inside one store transaction. Every
 * transaction first finalizes bring-up claims past their deadline (reapBringUps).
 *   store.mjs   config, the state lock, atomic writes and pruning
 *   facts.mjs   T3 observations: normalizing agent records, the t3 CLI refresh, discovery
 *   engine.mjs  pure decisions for place, done, report, cooldown, acquire, release, list, doctor and the rest
 *   cli.mjs     parsing, validation, the Level 0 policy line and the pure parts of bring-up
 *   profile.mjs machine profiles, apply-probe merging, the discovered-links cache and unprofiledBoxes
 *   probe.mjs   the self-contained, read-only hardware and toolchain probe
 *
 * Every command prints one JSON object and exits 0 exactly when ok is true. register-payload prints the bare
 * swarm registration array on success.
 */

import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "./store.mjs";
import * as facts from "./facts.mjs";
import * as engine from "./engine.mjs";
import * as profile from "./profile.mjs";
import { probeMachine } from "./probe.mjs";
import {
  UsageError,
  parseArgv,
  checkKnownLabels,
  helpPayload,
  branchNameProblem,
  canonicalRepoKey,
  renderPolicyLine,
  observationRecordsProblem,
  planBringUps,
  finishBringUp,
  reapBringUps,
  acquireShortfall,
  ts,
} from "./cli.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOME = path.resolve(process.env.T3_BOXES_HOME || path.join(os.homedir(), ".t3", "boxes"));
const MAX_STDIN_BYTES = 16 * 1024 * 1024;

// Bring-up bounds. A hook gets one argument vector and one timeout; the router never retries it on its own.
const BRINGUP_BUSY_EXIT = 75; // EX_TEMPFAIL: the hook's own idle check found the box busy.
const BRINGUP_KILL_GRACE_MS = 5_000; // SIGTERM to SIGKILL
const BRINGUP_BACKSTOP_MS = 2_000; // SIGKILL to giving up on the exit event
// A claim's deadline: the timeout, both grace periods and a margin. Past it, any transaction finalizes the claim.
const BRINGUP_CLAIM_MARGIN_MS = 10_000;

// Commands whose decision depends on link freshness. The t3 CLI refresh (when available) runs before them.
const REFRESH_COMMANDS = new Set(["place", "acquire", "list", "doctor", "register-payload"]);
const REPO_COMMANDS = new Set(["place", "acquire", "list", "doctor", "register-payload", "policy-line"]);
// Commands whose result reports linked boxes without a fresh profile (informational, never blocking).
const PROFILE_REPORT_COMMANDS = new Set(["place", "acquire", "list"]);

function emit(result) {
  const ok = Array.isArray(result) || result?.ok === true;
  process.stdout.write(JSON.stringify(result ?? { ok: false, error: "No result." }, null, 2) + "\n");
  process.exitCode = ok ? 0 : 1;
}

const newId = () => crypto.randomBytes(12).toString("hex");

function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

// ----------------------------------------------------------------------------------------------------------------
// Process helpers (all run outside the state lock)

function currentRepoKey() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return canonicalRepoKey(url);
  } catch {
    return null;
  }
}

// Branch names end up in a shell line the worker runs on the box. Check our own rules (charset and the ref
// format rules), then ask git when it is installed. A missing git leaves the stricter local check in force.
function checkBranchFlags(options) {
  for (const flag of ["base", "branch"]) {
    const name = options[flag];
    if (name === undefined) continue;
    const problem = branchNameProblem(name);
    if (problem) throw new UsageError(`--${flag} ${JSON.stringify(name)} ${problem}.`);
    try {
      execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore", timeout: 5000 });
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      throw new UsageError(`--${flag} ${JSON.stringify(name)} is not a valid branch name (git check-ref-format --branch).`);
    }
  }
}

// Read stdin to the end. With idleMs, give up when nothing arrives in that time (for optional input on a pipe
// that may never close). Returns the text, or "" when stdin is a terminal.
function readStdin({ idleMs = 0 } = {}) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let timer = null;
    const finish = (fn) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      process.stdin.pause();
      fn();
    };
    const arm = () => {
      if (!idleMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))), idleMs);
    };
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size > MAX_STDIN_BYTES) return finish(() => reject(new UsageError("stdin is larger than 16 MiB.")));
      chunks.push(c);
      arm();
    });
    process.stdin.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    process.stdin.on("error", (e) => finish(() => reject(e)));
    arm();
  });
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function parseJsonInput(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} on stdin is not valid JSON: ${errorMessage(e)}`);
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Store wrappers

// Every state transaction goes through here, so a bring-up claim past its deadline is finalized (and its box's
// facts expired) before anything else reads the state.
async function transaction(config, fn) {
  return store.transaction(HOME, config, (loaded, now) => {
    const state = reapBringUps(loaded, now);
    const out = fn(state, now);
    return out && typeof out === "object" && out.state === undefined ? { ...out, state } : out;
  });
}

// A copy of the current (pruned) state, taken under the lock and used only outside it.
async function snapshot(config) {
  return transaction(config, (state, now) => ({ state, result: { ok: true, state: structuredClone(state), now } }));
}

function snapshotOrError(snap) {
  if (snap && snap.ok === true && snap.state) return null;
  return snap && typeof snap === "object" ? snap : { ok: false, error: "Could not read router state." };
}

// Read link facts through the t3 CLI, outside the lock. Facts are optional evidence: a failed refresh leaves the
// engine to ask the agent for observations. The same read also refreshes the discovered-links cache (every link,
// configured or not) when that is stale; it rides in the patch under profile.DISCOVERY_PATCH_KEY, which can never
// be a machine label, so mergeFactPatch ignores it.
async function refreshPatch(config, state) {
  try {
    const now = Date.now();
    const links = profile.discoveryStale(state, now) ? "read" : "keep";
    const detail = await facts.refreshFactsDetailed(config, state, now, { links });
    const patch = detail.patch || {};
    if (Array.isArray(detail.t3?.links)) {
      patch[profile.DISCOVERY_PATCH_KEY] = profile.discoveryEnvelope("t3-cli", detail.t3.links, now, linkTtlMs(config));
    }
    return patch;
  } catch (e) {
    return { __error: errorMessage(e) };
  }
}

function linkTtlMs(config) {
  return (Number(config.defaults?.linkTtlMinutes) || store.DEFAULTS.linkTtlMinutes) * 60_000;
}

function cleanPatch(patch) {
  if (!patch || patch.__error) return null;
  return patch;
}

// One transaction: merge refreshed facts onto the latest observations, then decide. place, acquire and list also
// report linked boxes without a fresh profile; that never changes the decision or ok.
async function decideWith(command, { config, options, repo, patch }) {
  return transaction(config, (state, now) => {
    const clean = cleanPatch(patch);
    let merged = facts.mergeFactPatch(config, state, clean, now);
    if (clean?.[profile.DISCOVERY_PATCH_KEY]) merged = profile.recordDiscovered(merged, clean[profile.DISCOVERY_PATCH_KEY]);
    const out = engine.decide(command, { config, state: merged, options, repo, now, newId });
    const result = out?.result;
    if (!PROFILE_REPORT_COMMANDS.has(command) || !result || typeof result !== "object" || Array.isArray(result)) return out;
    const unprofiledBoxes = profile.unprofiledBoxes({ config, state: out.state ?? merged, now, proposeLabel: facts.proposeLabel });
    return { ...out, result: { ...result, unprofiledBoxes } };
  });
}

// ----------------------------------------------------------------------------------------------------------------
// Bring-up hook (acquire only)
//
// Safety rules:
//   - One claim per box, held in state.json. Choosing candidates, checking slots, cooldown, a running hook and
//     the retry window, and writing the claim happen in one transaction, so concurrent acquires never start a
//     second hook and a concurrent place never books past the check. While the claim stands, the engine gives
//     no slot or lease on that box.
//   - Never under the state lock: the executable check, the hook, its timeout and the link refresh after it all
//     run between transactions.
//   - Only on fresh evidence that the box is linked but down (cli.bringUpCandidates). A missing or expiring link,
//     an unknown status, a cooling box, held slots and pending facts never start a hook.
//   - Not on retry: an attempt that finished within bringUpRetryMinutes is not repeated, so an agent retrying
//     while it reads facts does not restart the box again.
//   - Slots are advisory and expire, so holding none is not proof the box is idle: the hook must run the
//     operator's own idle check before restarting T3 and exit 75 when the box is busy.
//   - Only the configured argument vector, no shell, output discarded (it could carry tokens). Its own process
//     group, stopped with SIGTERM then SIGKILL at the timeout. A process that leaves that group (setsid) escapes.
//   - Finishing lifts the claim and expires every fact about the box observed before the hook finished, in one
//     transaction; links are then re-read and the acquisition decided again on fresh evidence. A claim whose
//     router died is finalized the same way by the first transaction after its deadline.

function hookTimeoutMs(config, machine) {
  const raw = Number(machine.bringUpTimeoutMs ?? config.defaults?.bringUpTimeoutMs ?? store.BRINGUP_LIMITS.defaultTimeoutMs);
  const { minTimeoutMs, maxTimeoutMs, defaultTimeoutMs } = store.BRINGUP_LIMITS;
  return Math.min(maxTimeoutMs, Math.max(minTimeoutMs, Number.isFinite(raw) ? raw : defaultTimeoutMs));
}

function retryWindowMs(config) {
  const m = Number(config.defaults?.bringUpRetryMinutes);
  return (m > 0 ? m : store.BRINGUP_LIMITS.defaultRetryMinutes) * 60_000;
}

function hookArgvProblem(argv) {
  const shape = store.bringUpArgvProblem(argv);
  if (shape) return shape;
  try {
    if (!fs.statSync(argv[0]).isFile()) return `bringUp[0] ${argv[0]} is not a file.`;
    fs.accessSync(argv[0], fs.constants.X_OK);
  } catch {
    return `bringUp[0] ${argv[0]} is missing or not executable.`;
  }
  return null;
}

// Process groups of hooks still running. If the router itself is told to stop (a caller's command timeout sends
// SIGTERM, SIGINT or SIGHUP), it kills these groups before exiting, so a hook never outlives its router unless
// the router is SIGKILLed. The claim then lapses at its deadline and the reaper expires the box's facts.
const liveHookGroups = new Set();
const STOP_SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 };
function onStopSignal(sig) {
  for (const pgid of liveHookGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  process.exit(128 + STOP_SIGNALS[sig]);
}
function trackHookGroup(pgid) {
  if (process.platform === "win32" || !pgid) return;
  if (!liveHookGroups.size) for (const sig of Object.keys(STOP_SIGNALS)) process.on(sig, onStopSignal);
  liveHookGroups.add(pgid);
}
function untrackHookGroup(pgid) {
  if (!liveHookGroups.delete(pgid) || liveHookGroups.size) return;
  for (const sig of Object.keys(STOP_SIGNALS)) process.off(sig, onStopSignal);
}

// Run the hook to completion or its bound. Resolves { outcome, detail, exitCode?, signal? }; never rejects.
function runHook(argv, input, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, T3_BOXES_HOOK: "bringUp", T3_BOXES_IDLE_CHECK: "required", T3_BOXES_LABEL: input.label },
        shell: false,
        // Its own process group, so a timeout stops everything the hook started, not just the hook.
        detached: process.platform !== "win32",
      });
    } catch (e) {
      return resolve({ outcome: "failed", detail: `Could not start: ${errorMessage(e)}` });
    }
    let settled = false;
    let timedOut = false;
    const timers = [];
    trackHookGroup(child.pid);
    const settle = (r) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      untrackHookGroup(child.pid);
      try {
        child.stdin?.destroy();
        child.unref();
      } catch {
        // already closed
      }
      resolve(r);
    };
    const stop = (sig) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop("SIGTERM");
        timers.push(
          setTimeout(() => {
            stop("SIGKILL");
            timers.push(
              setTimeout(
                () => settle({ outcome: "timeout", detail: `No exit within ${timeoutMs} ms; sent SIGTERM, then SIGKILL, and stopped waiting.` }),
                BRINGUP_BACKSTOP_MS,
              ),
            );
          }, BRINGUP_KILL_GRACE_MS),
        );
      }, timeoutMs),
    );
    child.on("error", (e) => settle({ outcome: "failed", detail: `Could not start: ${e.code || errorMessage(e)}` }));
    child.on("exit", (code, signal) => {
      if (timedOut) {
        // Whatever the hook left in its group is stopped too; a service it started before the timeout is not
        // trusted to be in a known state.
        stop("SIGKILL");
        return settle({ outcome: "timeout", detail: `No exit within ${timeoutMs} ms; stopped.`, ...(signal ? { signal } : { exitCode: code }) });
      }
      if (code === 0) return settle({ outcome: "up", detail: "Hook exited 0.", exitCode: 0 });
      if (code === BRINGUP_BUSY_EXIT) {
        return settle({ outcome: "refused-busy", detail: "The hook's idle check found the box busy (exit 75). Nothing was restarted.", exitCode: code });
      }
      settle({ outcome: "failed", detail: signal ? `Hook ended by ${signal}.` : `Hook exited ${code}.`, ...(signal ? { signal } : { exitCode: code }) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}

async function runClaimed(config, { label, claim }, run) {
  const machine = config.machines[label];
  const timeoutMs = hookTimeoutMs(config, machine);
  const input = {
    hook: "bringUp",
    label,
    environmentId: machine.environmentId,
    run: run ?? null,
    timeoutMs,
    routerActiveSlots: 0,
    requireIdleCheck: true,
    note: "The router holds no slot on this box, which does not prove it is idle. Run your own idle check before restarting T3 and exit 75 if the box is busy.",
  };
  const res = await runHook(machine.bringUp, input, timeoutMs);
  return { label, claimId: claim.id, startedAt: claim.startedAt, timeoutMs, ...res, finishedAt: Date.now() };
}

async function acquireWithBringUp({ config, options, repo }) {
  const snap = await snapshot(config);
  const snapErr = snapshotOrError(snap);
  if (snapErr) return snapErr;
  let patch = await refreshPatch(config, snap.state);
  let result = await decideWith("acquire", { config, options, repo, patch });

  const shortfall = acquireShortfall(result, options.count);
  if (!shortfall) return result;
  const hooked = Object.entries(config.machines || {}).filter(([, m]) => Array.isArray(m?.bringUp) && m.bringUp.length);
  if (!hooked.length) return result;

  // File checks first, outside the lock.
  const unusable = new Map();
  for (const [label, m] of hooked) {
    const problem = hookArgvProblem(m.bringUp);
    if (problem) unusable.set(label, problem);
  }
  const leased = new Set((Array.isArray(result?.machines) ? result.machines : []).map((m) => m?.label));
  const plan = await transaction(config, (state, now) => {
    const planned = planBringUps({
      config,
      state,
      options,
      repo,
      now,
      exclude: leased,
      retryMs: retryWindowMs(config),
      limit: shortfall,
      unusable,
      makeClaim: (label) => ({
        id: newId(),
        run: options.run ?? null,
        pid: process.pid,
        startedAt: new Date(now).toISOString(),
        deadline: new Date(now + hookTimeoutMs(config, config.machines[label]) + BRINGUP_KILL_GRACE_MS + BRINGUP_BACKSTOP_MS + BRINGUP_CLAIM_MARGIN_MS).toISOString(),
      }),
    });
    return { state: planned.state, result: { ok: true, claimed: planned.claimed, report: planned.report } };
  });
  if (!plan || plan.ok !== true) return withBringUp(result, [{ label: null, outcome: "skipped", detail: `Could not plan a bring-up: ${plan?.error ?? "no state"}` }]);
  const report = [...plan.report];
  if (!plan.claimed.length) return report.length ? withBringUp(result, report) : result;

  const runs = await Promise.all(
    plan.claimed.map((c) =>
      runClaimed(config, c, options.run).catch((e) => ({ label: c.label, claimId: c.claim.id, outcome: "failed", detail: errorMessage(e), finishedAt: Date.now() })),
    ),
  );
  // Lift the claims and expire pre-hook facts in one step, so the box is never eligible on old evidence.
  const finished = await transaction(config, (state) => {
    let next = state;
    for (const r of runs) next = finishBringUp(next, r.label, r.claimId, r.outcome, r.finishedAt);
    return { state: next, result: { ok: true, state: structuredClone(next) } };
  });
  for (const r of runs) {
    const { claimId, ...shown } = r;
    report.push({
      ...shown,
      startedAt: r.startedAt ?? null,
      finishedAt: new Date(r.finishedAt).toISOString(),
      ...(finished?.ok === true ? {} : { warning: `Could not record the outcome: ${finished?.error}. The claim lapses at its deadline.` }),
    });
  }
  if (finished?.ok !== true || !runs.some((r) => r.outcome !== "refused-busy")) return withBringUp(result, report);

  // Re-read links (the invalidated ones are stale now) and decide again on fresh evidence.
  patch = await refreshPatch(config, finished.state);
  result = await decideWith("acquire", { config, options, repo, patch });
  return withBringUp(result, report);
}

function withBringUp(result, report) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...result, bringUp: report };
}

// ----------------------------------------------------------------------------------------------------------------
// Commands

async function loadConfigOrError() {
  try {
    return { config: await store.loadConfig(HOME) };
  } catch (e) {
    return { error: { ok: false, error: errorMessage(e), home: HOME, hint: "Run init, then doctor." } };
  }
}

function swarmMaxParallel() {
  const swarmHome = process.env.T3_SWARM_HOME || path.join(os.homedir(), ".t3", "swarm");
  const n = Number(readJsonFile(path.join(swarmHome, "config.json"))?.defaults?.maxParallelWorkers);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

async function cmdObserve(config) {
  const text = await readStdin();
  if (!text.trim()) throw new UsageError("observe expects a JSON array of records on stdin.");
  const records = parseJsonInput(text, "observe input");
  const problem = observationRecordsProblem(records);
  if (problem) return { ok: false, error: problem };
  return transaction(config, (state, now) => {
    const accepted = facts.applyObservationsDetailed(config, state, records, now);
    // A links record also refreshes the discovered-links cache, so boxes linked but not configured show up in
    // unprofiledBoxes without the t3 CLI.
    const next = accepted.links ? profile.recordDiscovered(accepted.state, profile.discoveryEnvelope("agent", accepted.links, now, linkTtlMs(config))) : accepted.state;
    return { state: next, result: { ok: true, updated: accepted.updated } };
  });
}

function cmdProbe(options) {
  return { ok: true, ...probeMachine({ attestations: options.attest || {} }) };
}

// apply-probe: validate the report outside the lock, then re-read the user's raw config.json, merge only the
// profile (or add the new machine), validate the whole result and write it atomically, all inside one state-lock
// transaction so two apply-probe runs never lose each other's write. Errors name fields, never input values.
async function cmdApplyProbe(options) {
  const text = await readStdin();
  if (!text.trim()) throw new UsageError("apply-probe expects the probe report (JSON) on stdin.");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON.parse messages quote the input; do not echo it.
    return { ok: false, error: "The probe report on stdin is not valid JSON." };
  }
  const checked = profile.sanitizeProbe(raw);
  if (!checked.ok) return { ok: false, error: checked.error, fields: checked.fields };
  const loaded = await loadConfigOrError();
  if (loaded.error) return loaded.error;
  const configPath = store.homePaths(HOME).config;
  return transaction(loaded.config, (state, now) => {
    let current;
    try {
      current = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return { result: { ok: false, error: `Could not read ${configPath} as JSON. Run doctor.` } };
    }
    const merged = profile.mergeProbeIntoRawConfig(current, { target: options.target, environmentId: options.environmentId, probe: checked.probe, now });
    if (!merged.ok) return { result: merged };
    const v = store.validateConfig(merged.config);
    if (!v.ok) return { result: { ok: false, error: "The merged config would be invalid; nothing was written.", errors: v.errors } };
    try {
      store.atomicWrite(configPath, store.serialize(merged.config));
    } catch (e) {
      return { result: { ok: false, error: `Failed writing ${configPath}: ${errorMessage(e)}` } };
    }
    const entry = options.target === "local" ? v.config.local : v.config.machines[options.target];
    return {
      result: {
        ok: true,
        label: options.target,
        environmentId: merged.environmentId,
        created: merged.created,
        profile: entry.profile,
        effective: { tags: entry.tags, priority: entry.priority, maxConcurrent: entry.maxConcurrent },
        preserved: merged.preserved,
        ...(checked.ignored ? { ignoredFields: checked.ignored } : {}),
        ...(merged.created ? { next: "Confirm the new box's label, priority, capacity and push access with the user, then run doctor." } : {}),
        warnings: v.warnings,
      },
    };
  });
}

async function cmdDiscover() {
  const loaded = await loadConfigOrError();
  const config = loaded.config ?? { version: 1, defaults: {}, local: {}, machines: {}, repos: {} };
  const text = await readStdin({ idleMs: 1500 });
  let records;
  if (text.trim()) {
    const parsed = parseJsonInput(text, "discover input");
    records = Array.isArray(parsed) ? parsed : [parsed];
    const problem = observationRecordsProblem(records);
    if (problem) return { ok: false, error: problem };
    if (records.some((r) => r.tool !== "t3_environment_links")) return { ok: false, error: "discover reads only t3_environment_links records." };
  }
  return facts.discover(config, records ? { records } : undefined);
}

async function cmdPolicyLine(config, options, repo) {
  const scriptPath = typeof config.scriptPath === "string" && path.isAbsolute(config.scriptPath) ? config.scriptPath : SCRIPT_PATH;
  const maxParallel = options.maxParallel ?? swarmMaxParallel();
  const text = renderPolicyLine({ config, runId: options.run, scriptPath, maxParallel, repo });
  const out = { ok: true, text };
  const snap = await snapshot(config);
  if (!snapshotOrError(snap)) {
    const lease = snap.state.leases?.[options.run];
    if (!lease || !(ts(lease.expiresAt) > snap.now)) {
      out.warnings = [`Run ${options.run} holds no lease. Leads can still place locally; acquire boxes first for remote work.`];
    }
  }
  return out;
}

async function cmdDoctor(config, options, repo, patch) {
  const result = await decideWith("doctor", { config, options, repo, patch });
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const hooks = [];
  for (const [label, m] of Object.entries(config.machines || {})) {
    if (m?.bringUp === undefined) continue;
    const problem = hookArgvProblem(m.bringUp);
    hooks.push({
      label,
      ok: !problem,
      timeoutMs: hookTimeoutMs(config, m),
      retryMinutes: retryWindowMs(config) / 60_000,
      ...(problem ? { problem } : { note: "Runs only at acquire. The hook must run the operator's idle check and exit 75 when busy." }),
    });
  }
  return {
    ...result,
    router: {
      home: HOME,
      scriptPath: SCRIPT_PATH,
      node: process.versions.node,
      repo,
      ...(patch?.__error ? { linkRefreshError: patch.__error } : {}),
      ...(hooks.length ? { bringUp: hooks } : {}),
    },
  };
}

async function main(argv) {
  const { command, options } = parseArgv(argv);
  if (command === "help") return helpPayload(options.args[0]);
  if (command === "init") {
    const text = await readStdin({ idleMs: 1500 });
    return store.init(HOME, text.trim() ? parseJsonInput(text, "Confirmed config") : undefined);
  }
  if (command === "discover") return cmdDiscover();
  if (command === "probe") return cmdProbe(options);
  if (command === "apply-probe") return cmdApplyProbe(options);

  const loaded = await loadConfigOrError();
  if (loaded.error) return loaded.error;
  const { config } = loaded;
  checkKnownLabels(command, options, config);
  checkBranchFlags(options);

  if (command === "observe") return cmdObserve(config);
  const repo = REPO_COMMANDS.has(command) ? currentRepoKey() : null;
  if (command === "policy-line") return cmdPolicyLine(config, options, repo);
  if (command === "acquire") return acquireWithBringUp({ config, options, repo });

  let patch = null;
  if (REFRESH_COMMANDS.has(command)) {
    const snap = await snapshot(config);
    const err = snapshotOrError(snap);
    if (err) return err;
    patch = await refreshPatch(config, snap.state);
  }
  if (command === "doctor") return cmdDoctor(config, options, repo, patch);
  return decideWith(command, { config, options, repo, patch });
}

main(process.argv.slice(2)).then(emit, (e) => {
  emit(e.result ?? { ok: false, error: errorMessage(e), ...(e instanceof UsageError ? { usage: true } : {}) });
});
