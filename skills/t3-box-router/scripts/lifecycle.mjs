/**
 * t3-box-router lifecycle: on-demand and ephemeral boxes.
 *
 *   ownership   A bringUp hook may confirm it started the box (hooks.parseStartedMarker). The acquire that leases
 *               that box to the same run records it in the lease as startedByRouter. Absent, ambiguous or "no"
 *               confirmation means not owned, and an unowned box is never torn down.
 *   identity    Labels are config names and may be reassigned. Ownership is bound to the environmentId the
 *               bringUp claim recorded: adoption needs that id to match the label's environment in config and in
 *               the lease, and stores it in lease.startedEnvironments; release tears down only while config still
 *               maps the label to it. A missing (legacy) or different id fails closed: the box is left running.
 *               Quietness checks match other leases, slots and hook claims by environmentId as well as by label,
 *               and a transfer hook runs only when the slot was booked on the environment the label names now.
 *   tearDown    At release --run, an owned on-demand or ephemeral box with a tearDown hook is stopped only when
 *               no other run leases it, no live slot (any run) is on it, and no bring-up, tear-down or keep-alive
 *               hook runs there. Those checks, dropping the lease and writing the claim happen in one transaction,
 *               and the claim (state.bringUp[label], hook "tearDown") blocks place and acquire on that box until
 *               the hook finishes or its deadline passes. Finishing expires the box's facts.
 *   keepAlive   keep-alive --run renews the run's lease and runs each leased box's keepAlive hook, one at a time
 *               per box (state.lifecycle.keepAlive). A box with a keep-alive running is not torn down.
 *   handoff     handoff and fetch run the user's own transfer hooks for a live slot, so uncommitted work can move
 * / fetch      directly. place adds booleans and command text (never argv) to a placement whose box has them.
 *
 * Pure planners take state and return the next state; the orchestrators at the bottom take their I/O
 * (transaction, newId, runHook, hookArgvProblem) as arguments. Hook output is never returned or stored: results
 * carry only an outcome, an exit code or signal, timings and, for bringUp, the reduced started boolean.
 */

import { activeBringUp, MACHINE_KINDS } from "./engine.mjs";
import { finishBringUp } from "./cli.mjs";

export const LIFECYCLE_KINDS = Object.freeze(["on-demand", "ephemeral"]);
export const LIFECYCLE_HOOKS = Object.freeze(["tearDown", "keepAlive", "handoff", "fetch"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600_000;
const HOUR = 3_600_000;

const ts = (v) => (typeof v === "number" ? v : v == null ? NaN : Date.parse(v));
const iso = (ms) => new Date(ms).toISOString();
const arr = (v) => (Array.isArray(v) ? v : []);
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const machineOf = (config, label) => (hasOwn(config?.machines, label) ? config.machines[label] : null);
const hasHook = (m, hook) => Array.isArray(m?.[hook]) && m[hook].length > 0;
const kindOf = (m) => (MACHINE_KINDS.includes(m?.kind) ? m.kind : "always-on");

/** Timeout for a tearDown, keepAlive, handoff or fetch hook: machine, then defaults, clamped. */
export function lifecycleTimeoutMs(config, machine) {
  const raw = Number(machine?.hookTimeoutMs ?? config?.defaults?.hookTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number.isFinite(raw) ? raw : DEFAULT_TIMEOUT_MS));
}

const isEnvId = (v) => typeof v === "string" && v.length > 0;
const envValues = (map) => (map && typeof map === "object" ? Object.values(map) : []);

// A record touches a box when it names the box's environment, or, naming none (legacy), carries its label.
const touches = (rec, recLabel, label, env) => (isEnvId(rec?.environmentId) ? rec.environmentId === env : recLabel === label);

function activeKeepAlive(state, label, now, env = null) {
  for (const [l, k] of Object.entries(state?.lifecycle?.keepAlive || {})) {
    if (!k || typeof k !== "object" || !(ts(k.deadline) > now)) continue;
    if (l === label || (env != null && touches(k, l, label, env))) return k;
  }
  return null;
}

function liveSlots(state, label, now, env = null) {
  return Object.values(state?.slots || {}).filter(
    (s) => ts(s?.expiresAt) > now && (s.label === label || (env != null && touches(s, s.label, label, env))),
  ).length;
}

function otherLeases(state, label, run, now, env = null) {
  return Object.entries(state?.leases || {})
    .filter(([r, l]) => r !== run && ts(l?.expiresAt) > now && (arr(l.machines).includes(label) || (env != null && envValues(l.environments).includes(env))))
    .map(([r]) => r)
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------
// Ownership

/**
 * After an acquire decision for `run`, record as startedByRouter every leased box whose last bringUp, for this
 * same run, exited 0 and confirmed it started the box, and that no lease has adopted yet. The bringUp record's
 * environmentId must match the label's environment in config and in the lease; it is stored, as the binding
 * release checks, in lease.startedEnvironments. A record without one (written before the binding) is never
 * adopted. Pure. Returns { state, adopted }.
 */
export function adoptStarted(state, run, now, config) {
  const lease = state?.leases?.[run];
  if (!lease || !(ts(lease.expiresAt) > now) || !config) return { state, adopted: [] };
  const owned = new Set(arr(lease.startedByRouter));
  const bound = { ...(lease.startedEnvironments && typeof lease.startedEnvironments === "object" ? lease.startedEnvironments : {}) };
  const adopted = [];
  let bringUp = state.bringUp;
  for (const label of arr(lease.machines)) {
    const b = state.bringUp?.[label];
    if (!b || typeof b !== "object" || (b.hook ?? "bringUp") !== "bringUp") continue;
    if (b.finishedAt == null || b.outcome !== "up" || b.started !== true || b.run !== run || b.adoptedAt != null) continue;
    const env = machineOf(config, label)?.environmentId;
    if (!isEnvId(b.environmentId) || b.environmentId !== env || lease.environments?.[label] !== env) continue;
    owned.add(label);
    bound[label] = env;
    adopted.push(label);
    bringUp = { ...bringUp, [label]: { ...b, adoptedAt: iso(now) } };
  }
  if (!adopted.length) return { state, adopted };
  const leases = { ...state.leases, [run]: { ...lease, startedByRouter: [...owned].sort(), startedEnvironments: bound } };
  return { state: { ...state, leases, bringUp }, adopted: adopted.sort() };
}

/** Wrap an engine acquire decision ({state, result}) with adoption, in the same transaction. */
export function adoptAfterAcquire(out, run, now, config) {
  if (!out || !out.result || out.result.ok !== true || typeof run !== "string") return out;
  const { state, adopted } = adoptStarted(out.state, run, now, config);
  if (!adopted.length) return out;
  return { state, result: { ...out.result, startedByRouter: state.leases[run].startedByRouter.slice() } };
}

// ---------------------------------------------------------------------------------------------------------------
// tearDown at release

/**
 * Decide a release and plan its tear-downs in one step, inside a single transaction.
 *   decideRelease  (state) -> engine release decision { state, result }
 *   unusable       Map label -> problem, for tearDown hooks that failed the file check made before the transaction
 *   makeClaim      (label) -> claim record { id, run, pid, startedAt, deadline }
 *   keep           true skips every tear-down (release --keep)
 * Returns { state, result, claimed: [{label, claim}] }. result.tearDown is present only when the lease held a box
 * with a tearDown hook, so an always-on release keeps its { ok, run, stopped, kept } shape.
 */
export function planRelease({ config, state, run, now, decideRelease, unusable = new Map(), makeClaim, keep = false }) {
  const before = state?.leases?.[run];
  const out = decideRelease(state);
  if (!out?.result || out.result.ok !== true || !before) return { ...out, claimed: [] };
  const owned = new Set(arr(before.startedByRouter));
  const bound = before.startedEnvironments && typeof before.startedEnvironments === "object" ? before.startedEnvironments : {};
  const leaseLive = ts(before.expiresAt) > now;
  let next = out.state;
  const report = [];
  const claimed = [];
  for (const label of arr(before.machines).slice().sort()) {
    const m = machineOf(config, label);
    if (!hasHook(m, "tearDown")) continue;
    const skip = (detail) => report.push({ label, outcome: "skipped", detail });
    if (!LIFECYCLE_KINDS.includes(kindOf(m))) {
      skip(`${label} is ${kindOf(m)}; the router never stops it.`);
      continue;
    }
    if (keep) {
      skip("Kept: release --keep.");
      continue;
    }
    if (!leaseLive) {
      skip("The lease had lapsed, so this run no longer owns the box. Stop it yourself if nothing uses it.");
      continue;
    }
    if (!owned.has(label)) {
      skip("Not started by the router for this run (no confirmed bringUp start). Left running.");
      continue;
    }
    // Ownership is bound to the environment the bring-up started, not to the label.
    const env = m.environmentId;
    if (!isEnvId(bound[label])) {
      skip("The ownership record names no environment (recorded before environment binding), so the router cannot prove it started this box. Left running.");
      continue;
    }
    if (bound[label] !== env) {
      skip(`${label} now names a different environment than the one this run's bring-up started. Left running; stop the original box yourself if nothing uses it.`);
      continue;
    }
    const others = otherLeases(next, label, run, now, env);
    if (others.length) {
      skip(`Still leased to run${others.length > 1 ? "s" : ""} ${others.join(", ")}. Left running.`);
      continue;
    }
    const slots = liveSlots(next, label, now, env);
    if (slots) {
      skip(`${slots} live slot(s) on the box. Release them with done first; the box was left running.`);
      continue;
    }
    const running = activeBringUp(next, label, now, env);
    if (running) {
      skip(`A ${running.hook ?? "bringUp"} hook is running there (deadline ${iso(ts(running.deadline))}). Left running.`);
      continue;
    }
    if (activeKeepAlive(next, label, now, env)) {
      skip("A keepAlive hook is running there. Left running.");
      continue;
    }
    if (unusable.has(label)) {
      skip(unusable.get(label));
      continue;
    }
    const claim = { ...makeClaim(label), hook: "tearDown", environmentId: env };
    next = { ...next, bringUp: { ...(next.bringUp || {}), [label]: claim } };
    claimed.push({ label, claim });
  }
  const result = report.length || claimed.length ? { ...out.result, tearDown: report } : out.result;
  return { state: next, result, claimed };
}

/** Lift tear-down claims and expire each box's facts (finishBringUp), then settle stopped and kept. Pure. */
export function finishTearDowns(state, runs) {
  let next = state;
  for (const r of runs) next = finishBringUp(next, r.label, r.claimId, r.outcome === "up" ? "stopped" : r.outcome, r.finishedAt);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// keepAlive

/**
 * Renew run's lease and claim keep-alives for its leased boxes that have a keepAlive hook. Pure.
 * Returns { state, result, claimed } or an error result when the run holds no lease.
 */
export function planKeepAlive({ config, state, run, now, unusable = new Map(), makeClaim }) {
  const lease = state?.leases?.[run];
  if (!lease || !(ts(lease.expiresAt) > now)) {
    return { state, result: { ok: false, error: `No active lease for run ${run}. Acquire boxes first.` }, claimed: [] };
  }
  const hours = Number(config?.defaults?.leaseTtlHours) > 0 ? Number(config.defaults.leaseTtlHours) : 24;
  const expiresAt = iso(Math.max(ts(lease.expiresAt), now + hours * HOUR));
  let next = { ...state, leases: { ...state.leases, [run]: { ...lease, expiresAt } } };
  const report = [];
  const claimed = [];
  for (const label of arr(lease.machines).slice().sort()) {
    const m = machineOf(config, label);
    if (!hasHook(m, "keepAlive")) continue;
    const skip = (detail, outcome = "skipped") => report.push({ label, outcome, detail });
    if (lease.environments?.[label] !== m.environmentId) {
      skip("The leased environment cannot be confirmed for this label.");
      continue;
    }
    const running = activeBringUp(next, label, now, m.environmentId);
    if (running) {
      skip(`A ${running.hook ?? "bringUp"} hook is running there.`);
      continue;
    }
    if (activeKeepAlive(next, label, now, m.environmentId)) {
      skip("A keepAlive hook is already running there.", "in-progress");
      continue;
    }
    if (unusable.has(label)) {
      skip(unusable.get(label));
      continue;
    }
    const claim = makeClaim(label);
    const lifecycle = { ...(next.lifecycle || {}) };
    lifecycle.keepAlive = { ...(lifecycle.keepAlive || {}), [label]: claim };
    next = { ...next, lifecycle };
    claimed.push({ label, claim });
  }
  return { state: next, result: { ok: true, run, expiresAt, keepAlive: report }, claimed };
}

/** Drop finished keep-alive claims (only the ones this call made). Pure. */
export function finishKeepAlives(state, runs) {
  const ka = { ...(state?.lifecycle?.keepAlive || {}) };
  let changed = false;
  for (const r of runs) {
    if (ka[r.label]?.id === r.claimId) {
      delete ka[r.label];
      changed = true;
    }
  }
  if (!changed) return state;
  if (!Object.keys(ka).length) {
    const { lifecycle: _drop, ...rest } = state;
    return rest;
  }
  return { ...state, lifecycle: { ...(state.lifecycle || {}), keepAlive: ka } };
}

// ---------------------------------------------------------------------------------------------------------------
// handoff / fetch metadata

/** What a placement tells its caller about the box's user-owned transfer hooks. Never the argv itself. */
export function transferInfo(config, label, slotId) {
  const m = machineOf(config, label);
  const handoff = hasHook(m, "handoff");
  const fetch = hasHook(m, "fetch");
  if (!handoff && !fetch) return null;
  const commands = [];
  if (handoff) commands.push(`box-router handoff --slot ${slotId} [--base <branch>] [--branch <worker-branch>]`);
  if (fetch) commands.push(`box-router fetch --slot ${slotId} [--branch <worker-branch>]`);
  return {
    mode: "user-hook",
    handoff,
    fetch,
    commands,
    note: "The user's own hooks can move uncommitted work to this box and back directly. They are optional: the committed Git handoff in briefAddendum still applies.",
  };
}

/** Add transfer metadata to a place result (single or batch). Pure. */
export function annotatePlacement(config, result) {
  if (!result || typeof result !== "object" || result.ok !== true) return result;
  const add = (p) => {
    if (!p?.placement?.remote) return p;
    const info = transferInfo(config, p.placement.label, p.placement.slot?.id);
    return info ? { ...p, placement: { ...p.placement, transfer: info } } : p;
  };
  if (Array.isArray(result.placements)) return { ...result, placements: result.placements.map(add) };
  return add(result);
}

/** Validate a transfer request against a state snapshot. Returns { slot, machine } or { error }. */
export function transferTarget(config, state, slotId, hook, now) {
  const slot = state?.slots?.[slotId];
  if (!slot || !(ts(slot.expiresAt) > now)) return { error: `Slot ${slotId} is not live. Place first; transfers need a booked box.` };
  if (slot.label === "local") return { error: `Slot ${slotId} is local; there is nothing to transfer.` };
  const m = machineOf(config, slot.label);
  if (!m) return { error: `Slot ${slotId} is on ${slot.label}, which is no longer configured.` };
  if (!hasHook(m, hook)) return { error: `${slot.label} has no ${hook} hook. Use the committed Git handoff instead.` };
  // The hook acts on the label's environment now; it must be the one the slot was booked on.
  if (!isEnvId(slot.environmentId)) {
    return { error: `Slot ${slotId} names no environment (placed before environment binding). Place again to transfer.` };
  }
  if (slot.environmentId !== m.environmentId) {
    return { error: `Slot ${slotId} was booked on another environment than ${slot.label} names now. Refusing to transfer; place again.` };
  }
  return { slot, machine: m };
}

// ---------------------------------------------------------------------------------------------------------------
// doctor

/** Lifecycle facts for doctor: kind and hook health per box that has any. */
export function doctorLifecycle(config, hookArgvProblem) {
  const out = [];
  for (const [label, m] of Object.entries(config?.machines || {})) {
    const hooks = LIFECYCLE_HOOKS.filter((h) => m?.[h] !== undefined);
    const kind = kindOf(m);
    if (!hooks.length && kind === "always-on") continue;
    const entry = { label, kind, timeoutMs: lifecycleTimeoutMs(config, m), hooks: {} };
    for (const h of hooks) {
      const problem = hookArgvProblem(m[h], h);
      entry.hooks[h] = problem ? { ok: false, problem } : { ok: true };
    }
    if (kind !== "always-on" && !hooks.includes("tearDown")) entry.note = "No tearDown hook: release never stops this box.";
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestrators (I/O injected)

/**
 * Hook result without anything the hook wrote: outcome, exit code or signal, and the router's own detail line.
 */
export function publicHookResult(r) {
  const out = { outcome: r.outcome, detail: r.detail };
  if (r.exitCode !== undefined) out.exitCode = r.exitCode;
  if (r.signal !== undefined) out.signal = r.signal;
  return out;
}

function fileChecks(config, labels, hook, hookArgvProblem) {
  const unusable = new Map();
  for (const label of labels) {
    const m = machineOf(config, label);
    if (!hasHook(m, hook)) continue;
    const problem = hookArgvProblem(m[hook], hook);
    if (problem) unusable.set(label, problem);
  }
  return unusable;
}

function makeClaimer(deps, config, run, now) {
  return (label) => ({
    id: deps.newId(),
    environmentId: machineOf(config, label)?.environmentId ?? null,
    run: run ?? null,
    pid: process.pid,
    startedAt: iso(now),
    deadline: iso(deps.claimDeadline(now, lifecycleTimeoutMs(config, machineOf(config, label)))),
  });
}

/**
 * release --run with tear-downs. deps: { transaction(fn), decide(state, now), newId, runHook, hookArgvProblem,
 * claimDeadline }. Returns the release result.
 */
export async function releaseWithTearDown(deps, { config, options }) {
  const run = options.run;
  const unusable = fileChecks(config, Object.keys(config?.machines || {}), "tearDown", deps.hookArgvProblem);
  const plan = await deps.transaction((state, now) => {
    const p = planRelease({
      config,
      state,
      run,
      now,
      keep: options.keep === true,
      unusable,
      decideRelease: (s) => deps.decide(s, now),
      makeClaim: makeClaimer(deps, config, run, now),
    });
    return { state: p.state, result: p.result?.ok === true ? { ...p.result, __claimed: p.claimed } : p.result };
  });
  if (!plan || typeof plan !== "object" || plan.ok !== true) return plan;
  const { __claimed: claimed = [], ...result } = plan;
  if (!claimed.length) return result;

  const runs = await Promise.all(
    claimed.map(async ({ label, claim }) => {
      const m = config.machines[label];
      const timeoutMs = lifecycleTimeoutMs(config, m);
      const input = {
        hook: "tearDown",
        label,
        environmentId: claim.environmentId,
        kind: kindOf(m),
        run,
        timeoutMs,
        routerActiveSlots: 0,
        requireIdleCheck: true,
        note: "The router started this box for this run, and no lease or slot holds it now. That does not prove it is idle: run your own idle check before stopping it and exit 75 if it is busy.",
      };
      let r;
      try {
        r = await deps.runHook(m.tearDown, input, timeoutMs, { name: "tearDown", label, idleCheck: true });
      } catch (e) {
        r = { outcome: "failed", detail: e instanceof Error ? e.message : String(e) };
      }
      return { label, claimId: claim.id, startedAt: claim.startedAt, timeoutMs, finishedAt: Date.now(), ...publicHookResult(r) };
    }),
  );
  const finished = await deps.transaction((state) => ({ state: finishTearDowns(state, runs), result: { ok: true } }));
  const stopped = runs.filter((r) => r.outcome === "up").map((r) => r.label);
  const tearDown = [...result.tearDown];
  for (const { claimId, finishedAt, ...r } of runs) {
    tearDown.push({
      ...r,
      outcome: r.outcome === "up" ? "stopped" : r.outcome,
      finishedAt: iso(finishedAt),
      ...(finished?.ok === true ? {} : { warning: `Could not record the outcome: ${finished?.error}. The claim lapses at its deadline.` }),
    });
  }
  const all = new Set([...result.kept, ...result.stopped]);
  return {
    ...result,
    stopped: [...new Set([...result.stopped, ...stopped])].sort(),
    kept: [...all].filter((l) => !stopped.includes(l)).sort(),
    tearDown: tearDown.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
  };
}

/** keep-alive --run. deps as for releaseWithTearDown, without decide. */
export async function keepAlive(deps, { config, options }) {
  const run = options.run;
  const unusable = fileChecks(config, Object.keys(config?.machines || {}), "keepAlive", deps.hookArgvProblem);
  const plan = await deps.transaction((state, now) => {
    const p = planKeepAlive({ config, state, run, now, unusable, makeClaim: makeClaimer(deps, config, run, now) });
    return { state: p.state, result: p.result.ok ? { ...p.result, __claimed: p.claimed } : p.result };
  });
  if (!plan || typeof plan !== "object" || plan.ok !== true) return plan;
  const { __claimed: claimed = [], ...result } = plan;
  if (!claimed.length) return result;
  const runs = await Promise.all(
    claimed.map(async ({ label, claim }) => {
      const m = config.machines[label];
      const timeoutMs = lifecycleTimeoutMs(config, m);
      const input = { hook: "keepAlive", label, environmentId: m.environmentId, kind: kindOf(m), run, leaseExpiresAt: result.expiresAt, timeoutMs };
      let r;
      try {
        r = await deps.runHook(m.keepAlive, input, timeoutMs, { name: "keepAlive", label, idleCheck: false });
      } catch (e) {
        r = { outcome: "failed", detail: e instanceof Error ? e.message : String(e) };
      }
      return { label, claimId: claim.id, startedAt: claim.startedAt, timeoutMs, finishedAt: Date.now(), ...publicHookResult(r) };
    }),
  );
  await deps.transaction((state) => ({ state: finishKeepAlives(state, runs), result: { ok: true } }));
  const report = [...result.keepAlive];
  for (const { claimId, finishedAt, ...r } of runs) report.push({ ...r, outcome: r.outcome === "up" ? "ok" : r.outcome, finishedAt: iso(finishedAt) });
  return { ...result, keepAlive: report.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)) };
}

/**
 * handoff or fetch for a live slot. deps: { snapshot() -> {state, now} | error, runHook, hookArgvProblem, cwd }.
 * ok is true only when the hook exited 0.
 */
export async function transfer(deps, { config, options, hook, repo = null }) {
  const snap = await deps.snapshot();
  if (!snap || snap.ok !== true || !snap.state) return snap && typeof snap === "object" ? snap : { ok: false, error: "Could not read router state." };
  const target = transferTarget(config, snap.state, options.slot, hook, snap.now);
  if (target.error) return { ok: false, slot: options.slot, error: target.error };
  const { slot, machine } = target;
  const problem = deps.hookArgvProblem(machine[hook], hook);
  if (problem) return { ok: false, slot: options.slot, label: slot.label, hook, error: problem };
  const timeoutMs = lifecycleTimeoutMs(config, machine);
  const input = {
    hook,
    label: slot.label,
    environmentId: machine.environmentId,
    kind: kindOf(machine),
    slot: options.slot,
    run: slot.run ?? null,
    repo: slot.repo ?? repo ?? null,
    cwd: deps.cwd,
    worktreeRoot: machine.worktreeRoot ?? "~/work",
    base: options.base ?? null,
    branch: options.branch ?? null,
    timeoutMs,
    note: "User-owned transfer of uncommitted work. Never send secrets; the router keeps no copy of what moves.",
  };
  let r;
  try {
    r = await deps.runHook(machine[hook], input, timeoutMs, { name: hook, label: slot.label, idleCheck: false });
  } catch (e) {
    r = { outcome: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
  const pub = publicHookResult(r);
  return { ok: r.outcome === "up", slot: options.slot, label: slot.label, hook, timeoutMs, ...pub, outcome: r.outcome === "up" ? "ok" : r.outcome };
}
