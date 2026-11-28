#!/usr/bin/env node
/**
 * t3-box-router CLI (Node 18+, no dependencies). Chooses the machine a T3 task runs on.
 *
 * This file orchestrates commands: it parses and validates flags, reads stdin, refreshes T3 link facts and runs
 * bring-up hooks outside the state lock, then makes each decision inside one store transaction.
 *   store.mjs   config, the state lock, atomic writes and pruning
 *   facts.mjs   T3 observations: normalizing agent records, the t3 CLI refresh, discovery
 *   engine.mjs  pure decisions for place, done, report, cooldown, acquire, release, list, doctor and the rest
 *   cli.mjs     parsing, validation, the Level 0 policy line and the pure parts of bring-up
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
import {
  UsageError,
  parseArgv,
  checkKnownLabels,
  helpPayload,
  branchNameProblem,
  canonicalRepoKey,
  renderPolicyLine,
  observationRecordsProblem,
  expireFactsBefore,
  activeSlotCount,
  bringUpCandidates,
  acquireShortfall,
  isValidLabel,
  ts,
} from "./cli.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOME = path.resolve(process.env.T3_BOXES_HOME || path.join(os.homedir(), ".t3", "boxes"));
const MAX_STDIN_BYTES = 16 * 1024 * 1024;

// Bring-up bounds. A hook gets one argument vector and one timeout; the router never retries it on its own.
const BRINGUP_DEFAULT_TIMEOUT_MS = 120_000;
const BRINGUP_MAX_TIMEOUT_MS = 600_000;
const BRINGUP_RETRY_MINUTES = 10;
const BRINGUP_BUSY_EXIT = 75; // EX_TEMPFAIL: the hook's own idle check found the box busy.
const BRINGUP_KILL_GRACE_MS = 5_000;

// Commands whose decision depends on link freshness. The t3 CLI refresh (when available) runs before them.
const REFRESH_COMMANDS = new Set(["place", "acquire", "list", "doctor", "register-payload"]);
const REPO_COMMANDS = new Set(["place", "acquire", "list", "doctor", "register-payload", "policy-line"]);

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

function parseJsonInput(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} on stdin is not valid JSON: ${errorMessage(e)}`);
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Store wrappers

// A copy of the current (pruned) state, taken under the lock and used only outside it.
async function snapshot(config) {
  return store.transaction(HOME, config, (state, now) => ({ state, result: { ok: true, state: structuredClone(state), now } }));
}

function snapshotOrError(snap) {
  if (snap && snap.ok === true && snap.state) return null;
  return snap && typeof snap === "object" ? snap : { ok: false, error: "Could not read router state." };
}

// Read link facts through the t3 CLI, outside the lock. Facts are optional evidence: a failed refresh leaves the
// engine to ask the agent for observations.
async function refreshPatch(config, state) {
  try {
    return (await facts.refreshFacts(config, state, Date.now())) || null;
  } catch (e) {
    return { __error: errorMessage(e) };
  }
}

function cleanPatch(patch) {
  if (!patch || patch.__error) return null;
  return patch;
}

// One transaction: merge refreshed facts onto the latest observations, then decide.
async function decideWith(command, { config, options, repo, patch }) {
  return store.transaction(HOME, config, (state, now) => {
    const merged = facts.mergeFactPatch(config, state, cleanPatch(patch), now);
    return engine.decide(command, { config, state: merged, options, repo, now, newId });
  });
}

// ----------------------------------------------------------------------------------------------------------------
// Bring-up hook (acquire only)
//
// Safety rules:
//   - Never under the state lock. Candidates come from a snapshot; the hook, its timeout and the refresh after
//     it all run outside the lock.
//   - One hook per box at a time, across processes: an O_EXCL claim file per label. A concurrent acquire, or a
//     place racing it, never starts a second hook; a stale claim (dead process or past its deadline) is replaced.
//   - Not on retry: an attempt within BRINGUP_RETRY_MINUTES is not repeated, so an agent retrying while it reads
//     facts does not restart the box again. Pending facts (needsObservation) never trigger a hook at all.
//   - Not while the router holds a slot there, and that is not enough: slots are advisory and expire, so the hook
//     must run the operator's own idle check before restarting T3 and exit 75 when the box is busy.
//   - Only the configured argument vector, no shell, output discarded (it could carry tokens).
//   - Afterwards every fact about the box observed before the hook finished is expired, links are re-read, and
//     the acquisition is decided again on fresh evidence.

const bringUpDir = () => path.join(HOME, "bringup");
function safeLabel(label) {
  if (!isValidLabel(label)) throw new Error(`Invalid machine label ${JSON.stringify(label)} for a bring-up file.`);
  return label;
}
const claimPath = (label) => path.join(bringUpDir(), `${safeLabel(label)}.lock`);
const recordPath = (label) => path.join(bringUpDir(), `${safeLabel(label)}.json`);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(p, obj) {
  const tmp = `${p}.${process.pid}.${newId()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// A claim is live while its process runs and its deadline has not passed. An empty claim is one being written
// right now, unless it is old (its writer died between create and write).
function claimIsLive(p) {
  const cur = readJsonFile(p);
  if (!cur) {
    try {
      return Date.now() - fs.statSync(p).mtimeMs < 60_000;
    } catch {
      return false;
    }
  }
  return pidAlive(cur.pid) && Number(cur.deadline) > Date.now();
}

function liveClaim(label) {
  return fs.existsSync(claimPath(label)) && claimIsLive(claimPath(label));
}

// Move a stale claim aside atomically. If what we moved turns out to be a fresh claim another process wrote in
// the meantime, put it back (link fails if yet another claim exists, which then stands).
function breakStaleClaim(p) {
  const stale = readJsonFile(p);
  const aside = `${p}.stale.${process.pid}.${newId()}`;
  try {
    fs.renameSync(p, aside);
  } catch {
    return;
  }
  const moved = readJsonFile(aside);
  if (moved && stale && moved.token !== stale.token) {
    try {
      fs.linkSync(aside, p);
    } catch {
      // Another claim exists now; it stands.
    }
  }
  fs.rmSync(aside, { force: true });
}

// Returns a release function, or null when another live process holds the claim.
function claimBringUp(label, deadlineMs) {
  fs.mkdirSync(bringUpDir(), { recursive: true, mode: 0o700 });
  const p = claimPath(label);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, "wx", 0o600);
      const token = newId();
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now(), deadline: deadlineMs }));
      fs.closeSync(fd);
      return () => {
        const cur = readJsonFile(p);
        if (cur?.token === token) fs.rmSync(p, { force: true });
      };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      if (claimIsLive(p)) return null;
      breakStaleClaim(p);
    }
  }
  return null;
}

function hookTimeoutMs(config, machine) {
  const raw = Number(machine.bringUpTimeoutMs ?? config.defaults?.bringUpTimeoutMs ?? BRINGUP_DEFAULT_TIMEOUT_MS);
  return Math.min(BRINGUP_MAX_TIMEOUT_MS, Math.max(1000, Number.isFinite(raw) ? raw : BRINGUP_DEFAULT_TIMEOUT_MS));
}

function hookArgvProblem(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string" || !a || a.includes("\0"))) {
    return "bringUp must be a non-empty argument vector of strings.";
  }
  if (!path.isAbsolute(argv[0])) return "bringUp's command must be an absolute path.";
  try {
    fs.accessSync(argv[0], fs.constants.X_OK);
  } catch {
    return `bringUp's command ${argv[0]} is missing or not executable.`;
  }
  return null;
}

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
    let timedOut = false;
    let killTimer = null;
    const stop = (sig) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), BRINGUP_KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ outcome: "failed", detail: `Could not start: ${e.code || errorMessage(e)}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) return resolve({ outcome: "timeout", detail: `No exit within ${timeoutMs} ms; stopped.` });
      if (code === 0) return resolve({ outcome: "up", detail: "Hook exited 0." });
      if (code === BRINGUP_BUSY_EXIT) {
        return resolve({ outcome: "refused-busy", detail: "The hook's idle check found the box busy (exit 75). Nothing was restarted." });
      }
      resolve({ outcome: "failed", detail: signal ? `Hook ended by ${signal}.` : `Hook exited ${code}.` });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}

async function bringUpOne({ config, label, run, retryMs }) {
  const machine = config.machines[label];
  const problem = hookArgvProblem(machine.bringUp);
  if (problem) return { label, outcome: "skipped", detail: problem, ran: false };

  const last = readJsonFile(recordPath(label));
  if (last && Number(last.finishedAt) > Date.now() - retryMs) {
    return {
      label,
      outcome: "recent",
      detail: `A bring-up finished at ${new Date(last.finishedAt).toISOString()} (${last.outcome}). Not repeated within ${retryMs / 60000} minutes; observe facts and retry, or report the box.`,
      ran: false,
    };
  }

  const timeoutMs = hookTimeoutMs(config, machine);
  const release = claimBringUp(label, Date.now() + timeoutMs + BRINGUP_KILL_GRACE_MS + 30_000);
  if (!release) return { label, outcome: "in-progress", detail: "Another router call is bringing this box up. Retry acquire after it finishes.", ran: false };

  try {
    // Re-check under the claim against current state: the box may have come back, or a slot may have been
    // booked there, since the candidate snapshot.
    const snap = await snapshot(config);
    if (snapshotOrError(snap)) return { label, outcome: "skipped", detail: "Could not re-read router state.", ran: false };
    const obs = snap.state.observations?.[label];
    const link = obs?.environmentId === machine.environmentId ? obs.link : null;
    if (link && ts(link.validUntil) > snap.now && link.value?.status === "reachable") {
      return { label, outcome: "skipped", detail: "The box is reachable again.", ran: false };
    }
    const held = activeSlotCount(snap.state, label, snap.now);
    if (held) return { label, outcome: "skipped", detail: `${held} router slot(s) are held there now. Refusing to restart.`, ran: false };

    const startedAt = Date.now();
    const input = {
      hook: "bringUp",
      label,
      environmentId: machine.environmentId,
      run: run ?? null,
      routerActiveSlots: 0,
      requireIdleCheck: true,
      note: "The router holds no slot on this box, which does not prove it is idle. Run your own idle check before restarting T3 and exit 75 if the box is busy.",
    };
    const res = await runHook(machine.bringUp, input, timeoutMs);
    const finishedAt = Date.now();
    try {
      writeJsonFile(recordPath(label), { startedAt, finishedAt, outcome: res.outcome });
    } catch {
      // The record only throttles retries; the claim already kept this attempt exclusive.
    }
    return { label, ...res, ran: res.outcome !== "refused-busy", finishedAt };
  } finally {
    release();
  }
}

async function acquireWithBringUp({ config, options, repo }) {
  let snap = await snapshot(config);
  const snapErr = snapshotOrError(snap);
  if (snapErr) return snapErr;
  let patch = await refreshPatch(config, snap.state);
  let result = await decideWith("acquire", { config, options, repo, patch });

  const shortfall = acquireShortfall(result, options.count);
  if (!shortfall) return result;
  const hooked = Object.values(config.machines || {}).some((m) => Array.isArray(m?.bringUp) && m.bringUp.length);
  if (!hooked) return result;

  snap = await snapshot(config);
  if (snapshotOrError(snap)) return result;
  const leased = new Set((Array.isArray(result?.machines) ? result.machines : []).map((m) => m?.label));
  const { candidates, skipped } = bringUpCandidates({ config, state: snap.state, options, repo, now: snap.now, exclude: leased });
  const report = skipped.map((s) => ({ label: s.label, outcome: "skipped", detail: s.reason }));
  if (!candidates.length) return report.length ? withBringUp(result, report) : result;

  const retryMs = (Number(config.defaults?.bringUpRetryMinutes) || BRINGUP_RETRY_MINUTES) * 60000;
  const runs = await Promise.all(
    candidates.slice(0, shortfall).map((c) =>
      bringUpOne({ config, label: c.label, run: options.run, retryMs }).catch((e) => ({ label: c.label, outcome: "failed", detail: errorMessage(e), ran: false })),
    ),
  );
  for (const r of runs) report.push({ label: r.label, outcome: r.outcome, detail: r.detail });

  const ran = runs.filter((r) => r.ran);
  if (!ran.length) return withBringUp(result, report);

  // Facts observed before the hook finished no longer describe the box. Expire them, re-read links, decide again.
  const cutoff = Math.max(...ran.map((r) => r.finishedAt || Date.now()));
  const after = await store.transaction(HOME, config, (state) => {
    const next = expireFactsBefore(state, ran.map((r) => r.label), cutoff);
    return { state: next, result: { ok: true, state: structuredClone(next), now: Date.now() } };
  });
  if (snapshotOrError(after)) return withBringUp(result, report);
  patch = await refreshPatch(config, after.state);
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
  return store.transaction(HOME, config, (state, now) => {
    const accepted = facts.applyObservationsDetailed(config, state, records, now);
    return { state: accepted.state, result: { ok: true, updated: accepted.updated } };
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
  const result = await decideWith(command, { config, options, repo, patch });
  return command === "place" ? warnBringUpInProgress(result) : result;
}

// A place can land on a box whose bring-up hook is still running only when fresh facts already say the box is
// reachable. Tell the caller, so a failed dispatch there is reported as failed, not as a lost machine.
function warnBringUpInProgress(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.ok !== true) return result;
  const placements = Array.isArray(result.placements) ? result.placements : [result];
  const labels = [...new Set(placements.map((p) => p?.placement?.label).filter((l) => l && l !== "local"))];
  const busy = labels.filter((l) => {
    try {
      return liveClaim(l);
    } catch {
      return false;
    }
  });
  if (!busy.length) return result;
  const warnings = [...(Array.isArray(result.warnings) ? result.warnings : [])];
  for (const l of busy) warnings.push(`${l} is being brought up by a concurrent acquire. If dispatch there fails, return the slot with done --outcome failed and place again.`);
  return { ...result, warnings };
}

main(process.argv.slice(2)).then(emit, (e) => {
  emit(e.result ?? { ok: false, error: errorMessage(e), ...(e instanceof UsageError ? { usage: true } : {}) });
});
