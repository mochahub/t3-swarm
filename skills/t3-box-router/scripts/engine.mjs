// t3-box-router Phase 1 decision engine.
//
// Pure functions only: no file system, network, shell, clock or randomness. The CLI loads config (with defaults
// merged), loads and prunes state under its lock, then calls `decide` and writes the returned state.
//
// See docs/t3-box-router/SPEC.md sections 3–8 for the contracts implemented here.

export const RESERVED_LABELS = new Set(['local', 'box']);
export const OBSERVATION_TOOLS = Object.freeze(['t3_environment_links', 'orchestrator_capabilities', 't3_project_list']);
export const OBSERVE_COMMAND = 'box-router observe';

export const DEFAULTS = Object.freeze({
  minLinkHours: 24,
  linkTtlMinutes: 15,
  factTtlHours: 24,
  slotTtlMinutes: 180,
  leaseTtlHours: 24,
  cooldownMinutes: 30,
  affinityTtlMinutes: 120,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const OUTCOMES = new Set(['ok', 'failed', 'unreachable']);
const PHASE2_MACHINE_FIELDS = ['weight', 'ssh', 'renew', 'bringUp', 'checks'];
const PHASE2_REPO_FIELDS = ['priority', 'maxConcurrent', 'allowWorktreeScripts'];

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const iso = (ms) => new Date(ms).toISOString();
const toMs = (value) => {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
const arr = (value) => (Array.isArray(value) ? value : []);
const uniq = (values) => [...new Set(values)];
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

/** Parse a duration: a number of milliseconds, or a string like `90s`, `30m`, `2h`, `1d`, `500ms`. */
export function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: MINUTE, h: HOUR, d: 24 * HOUR }[m[2]];
  const ms = Math.round(Number(m[1]) * unit);
  return ms > 0 ? ms : null;
}

function defaultsOf(config) {
  return { ...DEFAULTS, ...(config?.defaults ?? {}) };
}

function normalizeState(state) {
  const s = state ? structuredClone(state) : {};
  return {
    ...s,
    version: s.version ?? 1,
    observations: s.observations ?? {},
    health: s.health ?? {},
    leases: s.leases ?? {},
    slots: s.slots ?? {},
  };
}

/**
 * Remove expired slots, leases and observation envelopes. Persistence normally does this before `decide`; the
 * engine also ignores expired entries on its own, so calling this is optional.
 */
export function pruneExpired(state, now) {
  const s = normalizeState(state);
  for (const [id, slot] of Object.entries(s.slots)) if (!(toMs(slot?.expiresAt) > now)) delete s.slots[id];
  for (const [run, lease] of Object.entries(s.leases)) if (!(toMs(lease?.expiresAt) > now)) delete s.leases[run];
  for (const [label, obs] of Object.entries(s.observations)) {
    for (const kind of ['link', 'providers', 'projects', 'probe']) {
      if (obs?.[kind] && !(toMs(obs[kind].validUntil) > now)) delete obs[kind];
    }
    if (obs && !['link', 'providers', 'projects', 'probe'].some((k) => obs[k])) delete s.observations[label];
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Inventory

/** All machines, local first, as normalized descriptors. */
function inventory(config) {
  const local = config?.local ?? {};
  const machines = [
    {
      label: 'local',
      remote: false,
      kind: 'local',
      tags: arr(local.tags),
      priority: Number.isFinite(local.priority) ? local.priority : 0,
      maxConcurrent: isPositiveInt(local.maxConcurrent) ? local.maxConcurrent : 1,
      exclusive: arr(local.exclusive),
    },
  ];
  for (const [label, m] of Object.entries(config?.machines ?? {})) {
    machines.push({
      label,
      remote: true,
      kind: m?.kind ?? 'always-on',
      environmentId: m?.environmentId ?? null,
      url: m?.url ?? null,
      tags: arr(m?.tags),
      priority: Number.isFinite(m?.priority) ? m.priority : 0,
      maxConcurrent: isPositiveInt(m?.maxConcurrent) ? m.maxConcurrent : 1,
      exclusive: arr(m?.exclusive),
      worktreeRoot: m?.worktreeRoot ?? '~/work',
    });
  }
  return machines;
}

function activeSlots(state, now) {
  return Object.entries(state.slots)
    .filter(([, slot]) => toMs(slot?.expiresAt) > now)
    .map(([id, slot]) => ({ id, ...slot }));
}

function activeLease(state, run, now) {
  const lease = run != null ? state.leases[run] : null;
  return lease && toMs(lease.expiresAt) > now ? lease : null;
}

function heldBy(state, label, now) {
  return Object.entries(state.leases)
    .filter(([, lease]) => toMs(lease?.expiresAt) > now && arr(lease.machines).includes(label))
    .map(([run]) => run)
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------
// Observations and health

/** Return the fresh observation envelope of `kind` for a remote machine, or null when missing or stale. */
function freshFact(config, state, machine, kind, now) {
  const obs = state.observations[machine.label];
  if (!obs) return null;
  if (machine.environmentId && obs.environmentId && obs.environmentId !== machine.environmentId) return null;
  const env = obs[kind];
  if (!env) return null;
  const d = defaultsOf(config);
  const ttl = kind === 'providers' || kind === 'projects' ? d.factTtlHours * HOUR : d.linkTtlMinutes * MINUTE;
  const validUntil = toMs(env.validUntil);
  const observedAt = toMs(env.observedAt);
  let deadline = validUntil ?? (observedAt != null ? observedAt + ttl : null);
  if (deadline != null && observedAt != null) deadline = Math.min(deadline, observedAt + ttl);
  return deadline != null && deadline > now ? env : null;
}

function healthRecord(state, label) {
  const h = state.health[label] ?? {};
  return { failures: h.failures ?? 0, cooldownUntil: h.cooldownUntil ?? null, lastFailureAt: h.lastFailureAt ?? null };
}

function coolingUntil(state, label, now) {
  const until = toMs(healthRecord(state, label).cooldownUntil);
  return until != null && until > now ? until : null;
}

/** Link facts reduced to a verdict: `ok`, or a rejection with the derived machine state. */
function linkVerdict(config, link, now) {
  const d = defaultsOf(config);
  const v = link.value ?? {};
  const expiresAt = toMs(v.expiresAt);
  if (v.status === 'missing' || v.status === 'unlinked' || (expiresAt != null && expiresAt <= now)) {
    return { state: 'unlinked', reason: 'Link is missing or expired. Ask the user to link this box.' };
  }
  if (v.status !== 'reachable') {
    const err = v.lastError ? ` (${String(v.lastError).slice(0, 120)})` : '';
    return { state: 'cooling', reason: `Link status is ${v.status ?? 'unknown'}${err}, not reachable.` };
  }
  if (expiresAt != null && expiresAt - now < d.minLinkHours * HOUR) {
    return { state: 'unlinked', reason: `Link expires within ${d.minLinkHours} hours (at ${iso(expiresAt)}). Renew it.` };
  }
  if (v.access === 'read-only') return { state: 'ready', reason: 'Link access is read-only.' };
  return null;
}

/**
 * Derive a machine's health state, most restrictive first:
 * unlinked, cooling, unknown, recovering, degraded, ready.
 */
function deriveHealth(config, state, machine, repo, now) {
  if (!machine.remote) return { state: 'ready', notes: [] };
  const notes = [];
  const link = freshFact(config, state, machine, 'link', now);
  const lv = link ? linkVerdict(config, link, now) : null;
  if (lv?.state === 'unlinked') return { state: 'unlinked', notes: [lv.reason] };
  const cd = coolingUntil(state, machine.label, now);
  if (cd != null) return { state: 'cooling', notes: [`Cooling down until ${iso(cd)}.`] };
  if (lv?.state === 'cooling') return { state: 'cooling', notes: [lv.reason] };
  const missing = missingFacts(config, state, machine, repo, now);
  if (missing.length) return { state: 'unknown', notes: [`No fresh observation of ${missing.join(', ')}.`] };
  const h = healthRecord(state, machine.label);
  if (h.failures > 0) return { state: 'recovering', notes: ['Recovering after an outage: one slot at a time.'] };
  const probe = freshFact(config, state, machine, 'probe', now);
  if (probe && probe.value === false) {
    notes.push('Degraded: the HTTPS probe failed while the T3 link is reachable.');
    return { state: 'degraded', notes };
  }
  return { state: 'ready', notes };
}

function missingFacts(config, state, machine, repo, now) {
  const missing = [];
  if (!freshFact(config, state, machine, 'link', now)) missing.push('link');
  if (!freshFact(config, state, machine, 'providers', now)) missing.push('providers');
  if (repo != null && !freshFact(config, state, machine, 'projects', now)) missing.push('projects');
  return missing;
}

function observationCalls(machine, missing) {
  const calls = [];
  if (missing.includes('link')) calls.push({ tool: 't3_environment_links', args: {} });
  if (missing.includes('providers')) {
    calls.push({ tool: 'orchestrator_capabilities', args: { environmentId: machine.environmentId } });
  }
  if (missing.includes('projects')) calls.push({ tool: 't3_project_list', args: { environmentId: machine.environmentId } });
  return calls;
}

function mergeCalls(groups) {
  const seen = new Set();
  const calls = [];
  for (const call of groups.flat()) {
    const key = `${call.tool}:${call.args.environmentId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(call);
  }
  // Link read first: it is cheap and the only one a Lead is authorized to make.
  return calls.sort((a, b) => OBSERVATION_TOOLS.indexOf(a.tool) - OBSERVATION_TOOLS.indexOf(b.tool));
}

function needsObservationResult(pending) {
  return {
    ok: false,
    error: 'Fresh observations are needed before booking.',
    needsObservation: { calls: mergeCalls(pending.map((p) => p.calls)), observe: OBSERVE_COMMAND },
    pending: pending.map((p) => ({ label: p.machine.label, missing: p.missing })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Candidate evaluation shared by place, acquire, register-payload, list and doctor

/**
 * Evaluate one machine. Returns `{status: 'eligible'|'pending'|'rejected', reason?, missing?, calls?, providers?,
 * projectId?, health}`. Known facts are checked first; a machine is `pending` only when every known fact passes
 * and some required fact is missing.
 *
 * ctx: { config, state, repo, now, needs, provider, allowed (Set|null), run (string|null),
 *        checkLease, checkCapacity, slots (active slots, possibly simulated), placeName }
 */
function evaluate(ctx, machine) {
  const { config, state, repo, now } = ctx;
  const health = deriveHealth(config, state, machine, repo, now);
  const reject = (reason) => ({ status: 'rejected', reason, health });

  if (ctx.allowed && !ctx.allowed.has(machine.label)) return reject(ctx.allowedReason ?? 'Excluded by placement restriction.');
  if (ctx.deny?.has(machine.label)) return reject('Denied for this repo by config.');
  if (machine.remote && machine.kind !== 'always-on') {
    return reject(`Machine kind ${machine.kind} is not supported in Phase 1.`);
  }
  if (machine.remote && ctx.checkLease) {
    const lease = activeLease(state, ctx.run, now);
    if (!lease || !arr(lease.machines).includes(machine.label)) return reject(`Not leased to run ${ctx.run}.`);
  }
  const missingTags = ctx.needs.filter((t) => !machine.tags.includes(t));
  if (missingTags.length) {
    return reject(`Missing required tag${missingTags.length > 1 ? 's' : ''} ${missingTags.join(', ')}.`);
  }

  let providers;
  let projectId;
  const missing = [];
  if (machine.remote) {
    const cd = coolingUntil(state, machine.label, now);
    if (cd != null) return reject(`Cooling down until ${iso(cd)}.`);

    const link = freshFact(config, state, machine, 'link', now);
    if (link) {
      const lv = linkVerdict(config, link, now);
      if (lv) return reject(lv.reason);
    } else missing.push('link');

    const prov = freshFact(config, state, machine, 'providers', now);
    if (prov) {
      providers = arr(prov.value);
      if (!providers.length) return reject('No provider can run a child task there.');
      if (ctx.provider && !providers.includes(ctx.provider)) return reject(`Provider ${ctx.provider} cannot run there.`);
    } else missing.push('providers');

    if (repo == null) return reject('No repository key; a remote placement needs a project for this repo.');
    const proj = freshFact(config, state, machine, 'projects', now);
    if (proj) {
      projectId = proj.value?.[repo] ?? proj.value?.[String(repo).toLowerCase()];
      if (!projectId) {
        return reject(`No project observed for ${repo}. Read t3_project_list once more before concluding it is absent.`);
      }
    } else missing.push('projects');
  }

  if (ctx.checkCapacity) {
    const mine = ctx.slots.filter((s) => s.label === machine.label);
    if (mine.length >= machine.maxConcurrent) {
      return reject(`No free slot (${mine.length} of ${machine.maxConcurrent} in use).`);
    }
    const heldExclusive = new Set(mine.flatMap((s) => arr(s.exclusive)));
    const clash = ctx.needs.filter((t) => machine.exclusive.includes(t) && heldExclusive.has(t));
    if (clash.length) return reject(`Exclusive tag ${clash.join(', ')} is in use.`);
    if (health.state === 'recovering' && mine.length >= 1) {
      return reject('Recovering after an outage: one slot at a time, and one is in use.');
    }
  }

  if (missing.length) {
    return { status: 'pending', missing, calls: observationCalls(machine, missing), health, reason: `Needs a fresh observation of ${missing.join(', ')}.` };
  }
  return { status: 'eligible', providers, projectId, health };
}

// ---------------------------------------------------------------------------------------------------------------
// Request resolution (needs, pins, restrictions)

function resolveRequest(command, config, options, repo) {
  const machines = inventory(config);
  const labels = new Set(machines.map((m) => m.label));
  const repoRules = (repo != null && config?.repos?.[repo]) || {};
  const needs = uniq([...arr(options.needs), ...arr(repoRules.needs)]);
  const prefers = uniq([...arr(options.prefers), ...arr(repoRules.prefers)]);
  const deny = new Set(arr(repoRules.deny));

  if (options.count !== undefined && !isPositiveInt(options.count)) return { error: 'count must be a positive integer.' };
  for (const [name, value] of [['base', options.base], ['branch', options.branch]]) {
    if (value != null && (typeof value !== 'string' || !SAFE_REF.test(value) || value.startsWith('-'))) {
      return { error: `--${name} contains characters outside A-Z a-z 0-9 . _ / -.` };
    }
  }

  const selector = (sel, source) => {
    if (sel == null) return { set: null };
    if (sel === 'local') return { set: new Set(['local']) };
    if (sel === 'box') return { set: new Set(machines.filter((m) => m.remote).map((m) => m.label)) };
    if (!labels.has(sel)) return { error: `Unknown machine label ${sel} in ${source}.` };
    return { set: new Set([sel]) };
  };
  const place = selector(options.place, '--place');
  if (place.error) return { error: place.error };
  const pin = selector(repoRules.pin, `repos["${repo}"].pin`);
  if (pin.error) return { error: pin.error };

  let allowed = null;
  let allowedReason;
  if (place.set && pin.set) {
    allowed = new Set([...place.set].filter((l) => pin.set.has(l)));
    if (!allowed.size) return { error: `Conflicting pins: --place ${options.place} and repo pin ${repoRules.pin}.` };
    allowedReason = `Excluded by --place ${options.place} and repo pin ${repoRules.pin}.`;
  } else if (place.set) {
    allowed = place.set;
    allowedReason = `Not selected by --place ${options.place}.`;
  } else if (pin.set) {
    allowed = pin.set;
    allowedReason = `Repo pin is ${repoRules.pin}.`;
  }
  if (command === 'acquire') {
    // Leases are for remote boxes only.
    const remote = new Set(machines.filter((m) => m.remote).map((m) => m.label));
    allowed = new Set([...(allowed ?? remote)].filter((l) => remote.has(l)));
  }
  return { machines, needs, prefers, deny, allowed, allowedReason, repoRules };
}

// ---------------------------------------------------------------------------------------------------------------
// place

function compareInTier(prefers, loadOf) {
  return (a, b) => {
    const pa = prefers.filter((t) => a.tags.includes(t)).length;
    const pb = prefers.filter((t) => b.tags.includes(t)).length;
    if (pa !== pb) return pb - pa;
    const la = loadOf(a);
    const lb = loadOf(b);
    if (la !== lb) return la - lb;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  };
}

/**
 * Simulate up to `count` bookings. Each step evaluates every machine against the simulated slot list, picks the
 * highest priority tier among eligible (and, when `optimistic`, pending) machines, then orders within the tier.
 */
function simulate(baseCtx, machines, prefers, count, optimistic) {
  const slots = [...baseCtx.slots];
  const picks = [];
  let lastEval = new Map();
  for (let i = 0; i < count; i++) {
    const ctx = { ...baseCtx, slots };
    lastEval = new Map(machines.map((m) => [m.label, evaluate(ctx, m)]));
    const usable = machines.filter((m) => {
      const s = lastEval.get(m.label).status;
      return s === 'eligible' || (optimistic && s === 'pending');
    });
    if (!usable.length) break;
    const top = Math.max(...usable.map((m) => m.priority));
    const tier = usable.filter((m) => m.priority === top);
    const loadOf = (m) => slots.filter((s) => s.label === m.label).length / m.maxConcurrent;
    tier.sort(compareInTier(prefers, loadOf));
    const winner = tier[0];
    const ev = lastEval.get(winner.label);
    picks.push({ machine: winner, evaluation: ev, evals: lastEval, tier });
    slots.push({ label: winner.label, exclusive: baseCtx.needs.filter((t) => winner.exclusive.includes(t)) });
  }
  // Final evaluation explains why no further placement was possible.
  const finalEval = new Map(machines.map((m) => [m.label, evaluate({ ...baseCtx, slots }, m)]));
  return { picks, finalEval };
}

function skippedFor(machines, evals, winner) {
  const out = [];
  for (const m of machines) {
    if (winner && m.label === winner.label) continue;
    const ev = evals.get(m.label);
    if (ev.status === 'rejected' || ev.status === 'pending') out.push({ label: m.label, reason: ev.reason });
    else if (winner && m.priority < winner.priority) {
      out.push({ label: m.label, reason: `Lower priority tier (${m.priority} < ${winner.priority}).` });
    } else if (winner) {
      out.push({ label: m.label, reason: `Same priority tier; ordered after ${winner.label} by preferred tags, load or label.` });
    }
  }
  return out;
}

function whyFor(pick, initialEval, machines, needs) {
  const { machine, evaluation } = pick;
  const fullHigher = machines.filter(
    (m) =>
      m.priority > machine.priority &&
      initialEval.get(m.label)?.status === 'eligible' &&
      pick.evals.get(m.label)?.status === 'rejected',
  );
  let why;
  if (fullHigher.length) {
    const names = fullHigher.map((m) => m.label).join(', ');
    why = `${names} ${fullHigher.length > 1 ? 'are' : 'is'} full. ${machine.remote ? machine.label : 'Local'} is the next tier with a free slot.`;
  } else if (!machine.remote && needs.length) {
    why = `Local provides ${needs.join(', ')} and has a free slot.`;
  } else {
    why = 'Highest eligible priority tier with a free slot.';
  }
  const note = evaluation.health.state === 'degraded' || evaluation.health.state === 'recovering' ? evaluation.health.notes[0] : null;
  return note ? `${why} ${note}` : why;
}

function briefFor(machine, options, repoRules, multi) {
  if (!machine.remote) return "Run on the caller's machine. Use the caller's local checkout instructions.";
  const worker = !multi && options.branch ? options.branch : '<worker-branch>';
  const base = options.base ?? '<branch>';
  const root = String(machine.worktreeRoot ?? '~/work').replace(/\/+$/, '');
  if (repoRules.worktreeCommand) {
    return `Run on ${machine.label}. In its project checkout, run git fetch origin, then create your worktree for branch ${worker} from origin/${base} with the repo's trusted worktree command ${repoRules.worktreeCommand}. Work there, then push your branch to origin.`;
  }
  return `Run on ${machine.label}. In its project checkout, run git fetch origin && git worktree add ${root}/${worker} -b ${worker} origin/${base}. Work there, then push your branch to origin.`;
}

function decidePlace(config, state, options, repo, now, newId) {
  const req = resolveRequest('place', config, options, repo);
  if (req.error) return { state, result: fail(req.error) };
  const run = options.run ?? null;
  const baseCtx = {
    config, state, repo, now,
    needs: req.needs,
    provider: options.provider ?? null,
    allowed: req.allowed,
    allowedReason: req.allowedReason,
    deny: req.deny,
    run,
    checkLease: run != null,
    checkCapacity: true,
    slots: activeSlots(state, now),
  };
  const batch = options.count !== undefined;
  const count = batch ? options.count : 1;

  // Optimistic pass: if a machine with missing facts would be picked, those facts could change the answer.
  const optimistic = simulate(baseCtx, req.machines, req.prefers, count, true);
  const pending = optimistic.picks.filter((p) => p.evaluation.status === 'pending');
  if (pending.length) {
    const seen = new Set();
    const uniquePending = pending
      .filter((p) => !seen.has(p.machine.label) && seen.add(p.machine.label))
      .map((p) => ({ machine: p.machine, missing: p.evaluation.missing, calls: p.evaluation.calls }));
    return { state, result: needsObservationResult(uniquePending) };
  }

  const { picks, finalEval } = simulate(baseCtx, req.machines, req.prefers, count, false);
  if (!picks.length) {
    return { state, result: fail('No eligible machine.', { skipped: skippedFor(req.machines, finalEval, null) }) };
  }

  const next = structuredClone(state);
  const d = defaultsOf(config);
  const initialEval = picks[0].evals;
  const multi = picks.length > 1;
  const placements = picks.map((pick) => {
    const { machine, evaluation } = pick;
    const id = newId();
    const expiresAt = iso(now + d.slotTtlMinutes * MINUTE);
    next.slots[id] = {
      label: machine.label,
      run,
      repo: repo ?? null,
      exclusive: req.needs.filter((t) => machine.exclusive.includes(t)),
      placedAt: iso(now),
      expiresAt,
    };
    const placement = { label: machine.label, remote: machine.remote };
    if (machine.remote) placement.providers = options.provider ? [options.provider] : evaluation.providers;
    placement.slot = { id, expiresAt };
    placement.why = whyFor(pick, initialEval, req.machines, req.needs);
    if (!batch) placement.skipped = skippedFor(req.machines, pick.evals, machine);
    return {
      target: machine.remote ? { environmentId: machine.environmentId, projectId: evaluation.projectId } : {},
      placement,
      briefAddendum: briefFor(machine, options, req.repoRules, multi),
    };
  });

  if (run != null && next.leases[run] && toMs(next.leases[run].expiresAt) > now) {
    next.leases[run] = { ...next.leases[run], expiresAt: iso(now + d.leaseTtlHours * HOUR) };
  }

  if (!batch) return { state: next, result: { ok: true, ...placements[0] } };
  const result = { ok: true, placements };
  if (placements.length < count) {
    result.shortfall = count - placements.length;
    result.skipped = req.machines.map((m) => ({ label: m.label, reason: finalEval.get(m.label).reason ?? 'Not eligible.' }));
  }
  return { state: next, result };
}

// ---------------------------------------------------------------------------------------------------------------
// done, report, cooldown, clear-cooldown

function applyOutage(next, config, label, minCooldown, now) {
  const d = defaultsOf(config);
  const h = healthRecord(next, label);
  const duration = Math.max(d.cooldownMinutes * MINUTE, Number.isFinite(minCooldown) ? minCooldown : 0);
  const existing = toMs(h.cooldownUntil);
  const until = Math.max(existing ?? 0, now + duration);
  next.health[label] = { failures: h.failures + 1, cooldownUntil: iso(until), lastFailureAt: iso(now) };
  const released = [];
  for (const [id, slot] of Object.entries(next.slots)) {
    if (slot?.label === label) {
      delete next.slots[id];
      released.push(id);
    }
  }
  return { cooldownUntil: iso(until), releasedSlots: released.sort() };
}

function remoteLabel(config, label) {
  if (typeof label !== 'string' || !label) return { error: 'A machine label is required.' };
  if (label === 'local') return { error: 'local is the caller machine and has no machine health record.' };
  if (!config?.machines?.[label]) return { error: `Unknown machine label ${label}.` };
  return { label };
}

function decideDone(config, state, options, now) {
  const slotId = options.slot;
  const outcome = options.outcome;
  if (typeof slotId !== 'string' || !slotId) return { state, result: fail('--slot is required.') };
  if (!OUTCOMES.has(outcome)) return { state, result: fail('--outcome must be ok, failed or unreachable.') };
  if (options.minCooldown !== undefined && !(Number.isFinite(options.minCooldown) && options.minCooldown > 0)) {
    return { state, result: fail('--min-cooldown must be a positive duration.') };
  }
  const slot = state.slots[slotId];
  const live = slot && toMs(slot.expiresAt) > now;
  if (!live) {
    // Already released or expired: harmless, and it cannot clear or set health on its own.
    if (!slot) return { state, result: { ok: true, slot: slotId, released: false } };
    const next = structuredClone(state);
    delete next.slots[slotId];
    return { state: next, result: { ok: true, slot: slotId, released: false } };
  }
  const next = structuredClone(state);
  const result = { ok: true, slot: slotId, released: true, label: slot.label, outcome };
  if (outcome === 'unreachable' && slot.label !== 'local') {
    Object.assign(result, applyOutage(next, config, slot.label, options.minCooldown, now));
    return { state: next, result };
  }
  delete next.slots[slotId];
  if (outcome === 'ok' && slot.label !== 'local') {
    const h = healthRecord(next, slot.label);
    const lastFailure = toMs(h.lastFailureAt);
    const placedAt = toMs(slot.placedAt);
    const cooling = coolingUntil(next, slot.label, now) != null;
    if (h.failures > 0 && !cooling && (lastFailure == null || (placedAt != null && placedAt > lastFailure))) {
      next.health[slot.label] = { ...h, failures: 0, cooldownUntil: null };
      result.recovered = true;
    }
  }
  return { state: next, result };
}

function decideReport(config, state, options, now) {
  const [labelArg, event] = arr(options.args);
  const r = remoteLabel(config, labelArg);
  if (r.error) return { state, result: fail(r.error) };
  if (event !== 'unreachable') return { state, result: fail('Usage: report <label> unreachable [--min-cooldown <duration>].') };
  if (options.minCooldown !== undefined && !(Number.isFinite(options.minCooldown) && options.minCooldown > 0)) {
    return { state, result: fail('--min-cooldown must be a positive duration.') };
  }
  const next = structuredClone(state);
  const out = applyOutage(next, config, r.label, options.minCooldown, now);
  return { state: next, result: { ok: true, label: r.label, state: 'cooling', ...out } };
}

function decideCooldown(config, state, options, now) {
  const [labelArg, durationArg] = arr(options.args);
  const r = remoteLabel(config, labelArg);
  if (r.error) return { state, result: fail(r.error) };
  const duration = parseDuration(durationArg);
  if (duration == null) return { state, result: fail('Usage: cooldown <label> <duration>, for example 30m or 2h.') };
  const next = structuredClone(state);
  const h = healthRecord(next, r.label);
  // A manual cooldown sets a deadline but never shortens one, and does not count as a failure.
  const until = Math.max(toMs(h.cooldownUntil) ?? 0, now + duration);
  next.health[r.label] = { ...h, cooldownUntil: iso(until) };
  return { state: next, result: { ok: true, label: r.label, cooldownUntil: iso(until) } };
}

function decideClearCooldown(config, state, options) {
  const [labelArg] = arr(options.args);
  const r = remoteLabel(config, labelArg);
  if (r.error) return { state, result: fail(r.error) };
  const next = structuredClone(state);
  const h = healthRecord(next, r.label);
  const changed = h.failures !== 0 || h.cooldownUntil != null;
  if (next.health[r.label]) next.health[r.label] = { ...h, failures: 0, cooldownUntil: null };
  return { state: next, result: { ok: true, label: r.label, cleared: changed } };
}

// ---------------------------------------------------------------------------------------------------------------
// acquire, release, register-payload

function decideAcquire(config, state, options, repo, now) {
  const run = options.run;
  if (typeof run !== 'string' || !run) return { state, result: fail('--run is required.') };
  const req = resolveRequest('acquire', config, options, repo);
  if (req.error) return { state, result: fail(req.error) };
  const count = options.count ?? 1;
  const ctx = {
    config, state, repo, now,
    needs: req.needs,
    provider: options.provider ?? null,
    allowed: req.allowed,
    allowedReason: req.allowedReason ?? 'Not a remote box.',
    deny: req.deny,
    run,
    checkLease: false,
    checkCapacity: false,
    slots: [],
  };
  const remotes = req.machines.filter((m) => m.remote);
  const evals = new Map(remotes.map((m) => [m.label, evaluate(ctx, m)]));
  const current = activeLease(state, run, now);
  const held = new Set(current ? arr(current.machines) : []);
  const group = (m) => (held.has(m.label) ? 0 : heldBy(state, m.label, now).length === 0 ? 1 : 2);
  const order = (a, b) =>
    group(a) - group(b) || b.priority - a.priority || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

  const usable = remotes.filter((m) => ['eligible', 'pending'].includes(evals.get(m.label).status)).sort(order);
  // Keep every currently held usable box; add others only up to the requested count.
  const chosen = [];
  for (const m of usable) {
    if (held.has(m.label) || chosen.length < count) chosen.push(m);
  }
  const pending = chosen.filter((m) => evals.get(m.label).status === 'pending');
  if (pending.length) {
    return {
      state,
      result: needsObservationResult(pending.map((m) => ({ machine: m, missing: evals.get(m.label).missing, calls: evals.get(m.label).calls }))),
    };
  }
  const errors = remotes
    .filter((m) => evals.get(m.label).status === 'rejected')
    .map((m) => `${m.label}: ${evals.get(m.label).reason}`);
  if (!chosen.length) {
    return { state, result: { ok: false, error: 'No eligible box.', machines: [], errors, shortfall: count } };
  }
  const d = defaultsOf(config);
  const next = structuredClone(state);
  next.leases[run] = { machines: chosen.map((m) => m.label), expiresAt: iso(now + d.leaseTtlHours * HOUR) };
  const result = {
    ok: true,
    machines: chosen.map((m) => ({ label: m.label, environmentId: m.environmentId })),
    errors: chosen.length < count ? errors : [],
  };
  if (chosen.length < count) {
    result.shortfall = count - chosen.length;
    if (!result.errors.length) result.errors = [`Only ${chosen.length} eligible box${chosen.length > 1 ? 'es' : ''} matched.`];
  }
  result.expiresAt = next.leases[run].expiresAt;
  return { state: next, result };
}

function decideRelease(config, state, options) {
  const run = options.run;
  if (typeof run !== 'string' || !run) return { state, result: fail('--run is required.') };
  const lease = state.leases[run];
  if (!lease) return { state, result: { ok: true, run, stopped: [], kept: [] } };
  const next = structuredClone(state);
  delete next.leases[run];
  return { state: next, result: { ok: true, run, stopped: [], kept: arr(lease.machines).slice().sort() } };
}

function decideRegisterPayload(config, state, options, repo, now) {
  const run = options.run;
  if (typeof run !== 'string' || !run) return { state, result: fail('--run is required.') };
  if (options.clear === true) return { state, result: [] };
  const lease = activeLease(state, run, now);
  if (!lease) return { state, result: fail(`No active lease for run ${run}. Renew it with acquire first.`) };
  const ctx = {
    config, state, repo, now,
    needs: [],
    provider: null,
    allowed: null,
    deny: new Set(),
    run,
    checkLease: true,
    checkCapacity: false,
    slots: [],
  };
  const byLabel = new Map(inventory(config).map((m) => [m.label, m]));
  const leased = arr(lease.machines).map((l) => byLabel.get(l)).filter((m) => m?.remote);
  const evals = leased.map((m) => ({ m, ev: evaluate(ctx, m) }));
  const pending = evals.filter((e) => e.ev.status === 'pending');
  if (pending.length) {
    return { state, result: needsObservationResult(pending.map((e) => ({ machine: e.m, missing: e.ev.missing, calls: e.ev.calls }))) };
  }
  const usable = evals.filter((e) => e.ev.status === 'eligible');
  if (!usable.length) {
    return {
      state,
      result: fail(`No usable leased box for run ${run}.`, { errors: evals.map((e) => `${e.m.label}: ${e.ev.reason}`) }),
    };
  }
  const payload = usable
    .map(({ m }) => {
      const obs = state.observations[m.label];
      return {
        label: m.label,
        environmentId: m.environmentId,
        providers: arr(obs.providers.value).slice(),
        projects: { ...(obs.projects?.value ?? {}) },
      };
    })
    .sort((a, b) => (a.label < b.label ? -1 : 1));
  return { state, result: payload };
}

// ---------------------------------------------------------------------------------------------------------------
// list, doctor

function decideList(config, state, repo, now) {
  const slots = activeSlots(state, now);
  const machines = inventory(config).map((m) => {
    const health = deriveHealth(config, state, m, repo, now);
    const entry = { label: m.label };
    if (m.remote) entry.environmentId = m.environmentId;
    Object.assign(entry, {
      state: health.state,
      heldBy: m.remote ? heldBy(state, m.label, now) : [],
      tags: m.tags.slice(),
      priority: m.priority,
      maxConcurrent: m.maxConcurrent,
      activeSlots: slots.filter((s) => s.label === m.label).length,
    });
    if (health.notes.length) entry.notes = health.notes;
    const cd = coolingUntil(state, m.label, now);
    if (cd != null) entry.cooldownUntil = iso(cd);
    return entry;
  });
  const leases = Object.entries(state.leases)
    .filter(([, l]) => toMs(l?.expiresAt) > now)
    .map(([run, l]) => ({ run, machines: arr(l.machines).slice(), expiresAt: l.expiresAt }))
    .sort((a, b) => (a.run < b.run ? -1 : 1));
  const slotList = slots
    .map((s) => ({ id: s.id, label: s.label, run: s.run ?? null, repo: s.repo ?? null, exclusive: arr(s.exclusive), placedAt: s.placedAt, expiresAt: s.expiresAt }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { state, result: { ok: true, machines, leases, slots: slotList } };
}

/** Validate a merged config. Returns `{ errors, warnings }` with human-readable strings. */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== 'object') return { errors: ['Config is not an object.'], warnings };
  if (config.version !== undefined && config.version !== 1) errors.push(`Unsupported config version ${config.version}.`);
  const d = defaultsOf(config);
  for (const [k, v] of Object.entries(d)) if (!(typeof v === 'number' && v > 0)) errors.push(`defaults.${k} must be a positive number.`);
  if (config.allowProjectOverride) warnings.push('allowProjectOverride is a Phase 2 feature and is inactive.');

  const checkEntry = (label, m, where) => {
    if (m.tags !== undefined && !Array.isArray(m.tags)) errors.push(`${where}.tags must be an array.`);
    if (m.priority !== undefined && !Number.isFinite(m.priority)) errors.push(`${where}.priority must be a number.`);
    if (!isPositiveInt(m.maxConcurrent)) errors.push(`${where}.maxConcurrent must be a positive integer.`);
    if (m.exclusive !== undefined && !Array.isArray(m.exclusive)) errors.push(`${where}.exclusive must be an array.`);
    for (const t of arr(m.exclusive)) if (!arr(m.tags).includes(t)) warnings.push(`${where}.exclusive tag ${t} is not in its tags.`);
    if (label !== 'local') for (const f of PHASE2_MACHINE_FIELDS) if (m[f] !== undefined) warnings.push(`${where}.${f} is a Phase 2 field and is inactive.`);
    if (label === 'local' && m.weight !== undefined) warnings.push(`${where}.weight is a Phase 2 field and is inactive.`);
  };
  checkEntry('local', config.local ?? {}, 'local');

  const envIds = new Map();
  for (const [label, m] of Object.entries(config.machines ?? {})) {
    const where = `machines.${label}`;
    if (RESERVED_LABELS.has(label)) errors.push(`${label} is reserved and cannot name a remote machine.`);
    if (!m || typeof m !== 'object') {
      errors.push(`${where} must be an object.`);
      continue;
    }
    const kind = m.kind ?? 'always-on';
    if (kind === 'ephemeral') warnings.push(`${where} is ephemeral, a Phase 4 kind; it is never placed in Phase 1.`);
    else if (kind !== 'always-on') errors.push(`${where}.kind must be always-on.`);
    if (kind === 'always-on' && (typeof m.environmentId !== 'string' || !m.environmentId)) errors.push(`${where}.environmentId is required.`);
    if (m.environmentId) {
      if (envIds.has(m.environmentId)) errors.push(`${where}.environmentId duplicates machines.${envIds.get(m.environmentId)}.`);
      else envIds.set(m.environmentId, label);
    }
    if (m.url !== undefined && !/^https:\/\//.test(String(m.url))) errors.push(`${where}.url must be an https URL.`);
    checkEntry(label, m, where);
  }

  const labels = new Set(['local', ...Object.keys(config.machines ?? {})]);
  for (const [key, r] of Object.entries(config.repos ?? {})) {
    const where = `repos["${key}"]`;
    if (key !== key.toLowerCase()) warnings.push(`${where} key is not lowercase; canonical repo keys are lowercased.`);
    for (const f of ['needs', 'prefers', 'deny']) if (r?.[f] !== undefined && !Array.isArray(r[f])) errors.push(`${where}.${f} must be an array.`);
    for (const l of arr(r?.deny)) if (!labels.has(l)) warnings.push(`${where}.deny names unknown machine ${l}.`);
    if (r?.pin !== undefined && r.pin !== 'box' && !labels.has(r.pin)) errors.push(`${where}.pin names unknown machine ${r.pin}.`);
    for (const f of PHASE2_REPO_FIELDS) if (r?.[f] !== undefined) warnings.push(`${where}.${f} is a Phase 2 field and is inactive.`);
  }
  return { errors, warnings };
}

function decideDoctor(config, state, repo, now) {
  const { errors, warnings } = validateConfig(config);
  const machines = [];
  const pending = [];
  for (const m of inventory(config)) {
    const health = deriveHealth(config, state, m, repo, now);
    const issues = [...health.notes];
    if (m.remote) {
      const missing = missingFacts(config, state, m, repo, now);
      if (missing.length && m.environmentId) pending.push({ machine: m, missing, calls: observationCalls(m, missing) });
      const prov = freshFact(config, state, m, 'providers', now);
      if (prov && !arr(prov.value).length) issues.push('No provider can run a child task there.');
      const proj = freshFact(config, state, m, 'projects', now);
      if (proj && repo != null && !proj.value?.[repo]) issues.push(`No project observed for ${repo}.`);
      if (repo == null) issues.push('No repository key; remote placement needs a project for the current repo.');
    }
    machines.push({ label: m.label, state: health.state, issues: uniq(issues) });
  }
  const result = { ok: errors.length === 0, errors, warnings, machines };
  if (pending.length) result.needsObservation = { calls: mergeCalls(pending.map((p) => p.calls)), observe: OBSERVE_COMMAND };
  return { state, result };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point

/**
 * Decide one router command without side effects.
 *
 * @param {string} command One of place, done, report, cooldown, clear-cooldown, acquire, release, register-payload,
 *   list, doctor.
 * @param {object} input
 * @param {object} input.config Merged config (defaults applied by the loader).
 * @param {object} input.state Router state, already pruned of expired entries by persistence.
 * @param {object} input.options Parsed camelCase switches plus `args` (positionals). `count` is absent or a positive
 *   integer, `needs`/`prefers` are arrays, `minCooldown` is milliseconds, `clear` is boolean.
 * @param {string|null} input.repo Canonical repo key (lowercased) or null.
 * @param {number} input.now Epoch milliseconds.
 * @param {() => string} input.newId Slot ID generator; called once per booked slot and nowhere else.
 * @returns {{state: object, result: object|Array}} The next state (a fresh object; inputs are never mutated) and the
 *   command result. Every result is a `{ ok, ... }` object, except a successful `register-payload`, whose result is
 *   the bare swarm registration array: derive its exit code from `Array.isArray(result) || result.ok`.
 */
export function decide(command, { config, state, options = {}, repo = null, now, newId } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('decide: now must be epoch milliseconds.');
  const s = normalizeState(state);
  const opts = options ?? {};
  switch (command) {
    case 'place':
      if (typeof newId !== 'function') throw new TypeError('decide: newId is required for place.');
      return decidePlace(config, s, opts, repo, now, newId);
    case 'done':
      return decideDone(config, s, opts, now);
    case 'report':
      return decideReport(config, s, opts, now);
    case 'cooldown':
      return decideCooldown(config, s, opts, now);
    case 'clear-cooldown':
      return decideClearCooldown(config, s, opts);
    case 'acquire':
      return decideAcquire(config, s, opts, repo, now);
    case 'release':
      return decideRelease(config, s, opts);
    case 'register-payload':
      return decideRegisterPayload(config, s, opts, repo, now);
    case 'list':
      return decideList(config, s, repo, now);
    case 'doctor':
      return decideDoctor(config, s, repo, now);
    default:
      return { state: s, result: fail(`Unknown command ${command}.`) };
  }
}
