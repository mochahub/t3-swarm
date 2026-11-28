import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseDuration, pruneExpired, validateConfig, DEFAULTS, LINK_MISSING_STATUS } from '../../skills/t3-box-router/scripts/engine.mjs';

const NOW = Date.UTC(2030, 0, 1, 10);
const MIN = 60_000;
const HOUR = 60 * MIN;
const REPO = 'github.com/owner/repo';
const iso = (ms) => new Date(ms).toISOString();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function mkConfig({ local = {}, machines, repos, defaults } = {}) {
  return {
    version: 1,
    defaults: { ...DEFAULTS, ...(defaults ?? {}) },
    local: { tags: ['macos', 'arm64', 'ios-sim', 'xcode'], priority: 0, maxConcurrent: 4, exclusive: ['ios-sim'], ...local },
    machines: machines ?? {
      'home-box': {
        kind: 'always-on',
        environmentId: 'env-home',
        tags: ['linux', 'gpu', 'ram-32g', 'godot'],
        priority: 10,
        maxConcurrent: 6,
        exclusive: ['gpu'],
        worktreeRoot: '~/work',
      },
    },
    repos: repos ?? {},
  };
}

function box(environmentId, extra = {}) {
  return { kind: 'always-on', environmentId, tags: ['linux'], priority: 10, maxConcurrent: 2, exclusive: [], worktreeRoot: '~/work', ...extra };
}

function envelope(value, { at = NOW - MIN, ttl = 15 * MIN } = {}) {
  return { source: 'agent', observedAt: iso(at), validUntil: iso(at + ttl), value };
}

function freshObs(environmentId, { link = {}, providers = ['codex-1'], projects = { [REPO]: `proj-${environmentId}` }, probe, at } = {}) {
  const obs = {
    environmentId,
    link: envelope({ status: 'reachable', access: 'full-access', expiresAt: iso(NOW + 30 * 24 * HOUR), lastError: null, ...link }, { at }),
  };
  if (providers !== null) obs.providers = envelope(providers, { at, ttl: 24 * HOUR });
  if (projects !== null) obs.projects = envelope(projects, { at, ttl: 24 * HOUR });
  if (probe !== undefined) obs.probe = envelope(probe, { at });
  return obs;
}

function mkState(observations = {}, extra = {}) {
  return { version: 1, observations, health: {}, leases: {}, slots: {}, ...extra };
}

const warmState = () => mkState({ 'home-box': freshObs('env-home') });

/** Run decide with frozen inputs and a counter newId. Error results must leave state deep-equal to the input. */
function run(command, { config = mkConfig(), state = warmState(), options = {}, repo = REPO, now = NOW, ids } = {}) {
  const before = structuredClone(state);
  deepFreeze(config);
  deepFreeze(state);
  deepFreeze(options);
  const counter = ids ?? { n: 0 };
  const out = decide(command, { config, state, options, repo, now, newId: () => `s${++counter.n}` });
  assert.deepEqual(state, before, 'input state must not change');
  if (!Array.isArray(out.result) && out.result.ok === false) assert.deepEqual(out.state, before, 'error leaves state unchanged');
  return { ...out, ids: counter };
}

function slot(label, extra = {}) {
  return { label, run: null, repo: REPO, exclusive: [], placedAt: iso(NOW - MIN), expiresAt: iso(NOW + HOUR), ...extra };
}

describe('place: single placement', () => {
  test('remote result has target, providers, slot, why, skipped and brief', () => {
    const { result, state } = run('place', { options: { needs: ['linux'], base: 'main', branch: 'feat-x' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.target, { environmentId: 'env-home', projectId: 'proj-env-home' });
    assert.equal(result.placement.label, 'home-box');
    assert.equal(result.placement.remote, true);
    assert.deepEqual(result.placement.providers, ['codex-1']);
    assert.deepEqual(result.placement.slot, { id: 's1', expiresAt: iso(NOW + 180 * MIN) });
    assert.equal(result.placement.why, 'Highest eligible priority tier with a free slot.');
    assert.deepEqual(result.placement.skipped, [{ label: 'local', reason: 'Missing required tag linux.' }]);
    assert.equal(
      result.briefAddendum,
      'Run on home-box. In its project checkout, run git fetch origin && git worktree add ~/work/feat-x -b feat-x origin/main. Work there, then push your branch to origin.',
    );
    assert.deepEqual(state.slots.s1, {
      label: 'home-box', run: null, repo: REPO, exclusive: [], placedAt: iso(NOW), expiresAt: iso(NOW + 180 * MIN),
    });
  });

  test('local result keeps target empty, omits providers and needs no observations', () => {
    const { result } = run('place', { state: mkState(), options: { needs: ['ios-sim'] } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.target, {});
    assert.equal(result.placement.label, 'local');
    assert.equal(result.placement.remote, false);
    assert.equal('providers' in result.placement, false);
    assert.equal(result.placement.why, 'Local provides ios-sim and has a free slot.');
    assert.deepEqual(result.placement.skipped, [{ label: 'home-box', reason: 'Missing required tag ios-sim.' }]);
    assert.equal(result.briefAddendum, "Run on the caller's machine. Use the caller's local checkout instructions.");
  });

  test('lower tier reported as skipped by priority', () => {
    const { result } = run('place');
    assert.equal(result.placement.label, 'home-box');
    assert.deepEqual(result.placement.skipped, [{ label: 'local', reason: 'Lower priority tier (0 < 10).' }]);
  });

  test('trusted repo worktree command is named in the brief', () => {
    const config = mkConfig({ repos: { [REPO]: { worktreeCommand: './scripts/worktree' } } });
    const { result } = run('place', { config, options: { branch: 'w1', base: 'main' } });
    assert.match(result.briefAddendum, /trusted worktree command \.\/scripts\/worktree/);
    assert.match(result.briefAddendum, /branch w1 from origin\/main/);
  });
});

describe('place: batches, priority, load', () => {
  test('box first until six, then local (batch of seven)', () => {
    const { result, state } = run('place', { options: { count: 7 } });
    assert.equal(result.ok, true);
    const labels = result.placements.map((p) => p.placement.label);
    assert.deepEqual(labels, ['home-box', 'home-box', 'home-box', 'home-box', 'home-box', 'home-box', 'local']);
    assert.equal('shortfall' in result, false);
    assert.equal('skipped' in result, false);
    for (const p of result.placements) {
      assert.equal('ok' in p, false);
      assert.equal('skipped' in p.placement, false);
    }
    assert.equal(result.placements[6].placement.why, 'home-box is full. Local is the next tier with a free slot.');
    assert.equal(Object.keys(state.slots).length, 7);
    assert.deepEqual(result.placements.map((p) => p.placement.slot.id), ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
  });

  test('partial batch is ok with shortfall and top-level skipped', () => {
    const { result } = run('place', { options: { count: 11 } });
    assert.equal(result.ok, true);
    assert.equal(result.placements.length, 10);
    assert.equal(result.shortfall, 1);
    assert.deepEqual(result.skipped, [
      { label: 'local', reason: 'No free slot (4 of 4 in use).' },
      { label: 'home-box', reason: 'No free slot (6 of 6 in use).' },
    ]);
  });

  test('count 1 uses batch shape', () => {
    const { result } = run('place', { options: { count: 1 } });
    assert.equal(result.placements.length, 1);
    assert.equal('target' in result, false);
  });

  test('batch with more than one placement keeps the worker-branch placeholder', () => {
    const { result } = run('place', { options: { count: 2, branch: 'feat', base: 'main' } });
    for (const p of result.placements) assert.match(p.briefAddendum, /<worker-branch> -b <worker-branch> origin\/main/);
  });

  test('capacity is the weight: caps 6 and 2 in one tier fill three to one', () => {
    const config = mkConfig({ machines: { a: box('env-a', { maxConcurrent: 6 }), b: box('env-b', { maxConcurrent: 2 }) } });
    const state = mkState({ a: freshObs('env-a'), b: freshObs('env-b') });
    const { result } = run('place', { config, state, options: { count: 4, needs: ['linux'] } });
    assert.deepEqual(result.placements.map((p) => p.placement.label), ['a', 'b', 'a', 'a']);
    const full = run('place', { config, state, options: { count: 8, needs: ['linux'] } }).result;
    const tally = full.placements.reduce((acc, p) => ({ ...acc, [p.placement.label]: (acc[p.placement.label] ?? 0) + 1 }), {});
    assert.deepEqual(tally, { a: 6, b: 2 });
  });

  test('strict priority: higher tier wins despite higher load', () => {
    const config = mkConfig({ machines: { hi: box('env-hi', { priority: 10, maxConcurrent: 4 }), lo: box('env-lo', { priority: 5, maxConcurrent: 4 }) } });
    const state = mkState(
      { hi: freshObs('env-hi'), lo: freshObs('env-lo') },
      { slots: { x1: slot('hi'), x2: slot('hi'), x3: slot('hi') } },
    );
    const { result } = run('place', { config, state, options: { needs: ['linux'] } });
    assert.equal(result.placement.label, 'hi');
  });

  test('prefers breaks ties within a tier but never across tiers', () => {
    const machines = {
      a: box('env-a', { priority: 10 }),
      b: box('env-b', { priority: 10, tags: ['linux', 'ram-32g'] }),
      c: box('env-c', { priority: 5, tags: ['linux', 'ram-32g', 'gpu'] }),
    };
    const state = mkState({ a: freshObs('env-a'), b: freshObs('env-b'), c: freshObs('env-c') });
    const r1 = run('place', { config: mkConfig({ machines }), state, options: { prefers: ['ram-32g', 'gpu'] } }).result;
    assert.equal(r1.placement.label, 'b');
    const r2 = run('place', { config: mkConfig({ machines }), state }).result;
    assert.equal(r2.placement.label, 'a', 'label order without preferences');
    // b is loaded, but preference still wins inside the tier.
    const loaded = mkState(state.observations, { slots: { x: slot('b') } });
    assert.equal(run('place', { config: mkConfig({ machines }), state: loaded, options: { prefers: ['ram-32g'] } }).result.placement.label, 'b');
  });

  test('lowest load wins within a tier', () => {
    const config = mkConfig({ machines: { a: box('env-a', { maxConcurrent: 4 }), b: box('env-b', { maxConcurrent: 4 }) } });
    const state = mkState({ a: freshObs('env-a'), b: freshObs('env-b') }, { slots: { x: slot('a') } });
    assert.equal(run('place', { config, state }).result.placement.label, 'b');
  });
});

describe('place: filters', () => {
  test('needs ios-sim goes local; full local is a capacity error', () => {
    const slots = Object.fromEntries([1, 2, 3, 4].map((i) => [`l${i}`, slot('local', { repo: null })]));
    const { result } = run('place', { state: mkState({ 'home-box': freshObs('env-home') }, { slots }), options: { needs: ['xcode'] } });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No eligible machine.');
    assert.deepEqual(result.skipped, [
      { label: 'local', reason: 'No free slot (4 of 4 in use).' },
      { label: 'home-box', reason: 'Missing required tag xcode.' },
    ]);
  });

  test('batch with zero booked collapses to the No eligible machine error', () => {
    const slots = Object.fromEntries([1, 2, 3, 4].map((i) => [`l${i}`, slot('local', { repo: null })]));
    const { result } = run('place', { state: mkState({ 'home-box': freshObs('env-home') }, { slots }), options: { count: 2, needs: ['xcode'] } });
    assert.deepEqual(result, {
      ok: false,
      error: 'No eligible machine.',
      skipped: [
        { label: 'local', reason: 'No free slot (4 of 4 in use).' },
        { label: 'home-box', reason: 'Missing required tag xcode.' },
      ],
    });
  });

  test('link recorded as missing derives unlinked and is not re-requested', () => {
    const state = mkState({ 'home-box': freshObs('env-home', { link: { status: LINK_MISSING_STATUS } }) });
    assert.equal(run('list', { state }).result.machines[1].state, 'unlinked');
    const r = run('place', { state }).result;
    assert.equal(r.placement.label, 'local');
    assert.match(r.placement.skipped[0].reason, /missing or expired/);
  });

  test('exclusive gpu: second gpu task rejected, CPU work still uses the box', () => {
    const first = run('place', { options: { needs: ['gpu'] } });
    assert.equal(first.result.placement.label, 'home-box');
    assert.deepEqual(first.state.slots.s1.exclusive, ['gpu']);
    const second = run('place', { state: first.state, options: { needs: ['gpu'] }, ids: first.ids });
    assert.equal(second.result.ok, false);
    assert.deepEqual(second.result.skipped, [
      { label: 'local', reason: 'Missing required tag gpu.' },
      { label: 'home-box', reason: 'Exclusive tag gpu is in use.' },
    ]);
    const cpu = run('place', { state: first.state, options: { needs: ['linux'] }, ids: first.ids });
    assert.equal(cpu.result.placement.label, 'home-box');
    assert.deepEqual(cpu.state.slots.s2.exclusive, []);
  });

  test('exclusive gpu batch books one gpu slot then stops', () => {
    const { result } = run('place', { options: { count: 2, needs: ['gpu'] } });
    assert.equal(result.placements.length, 1);
    assert.equal(result.shortfall, 1);
  });

  const rejectCases = [
    ['non-reachable link', freshObs('env-home', { link: { status: 'offline', lastError: 'timeout' } }), /Link status is offline \(timeout\), not reachable/],
    ['read-only access', freshObs('env-home', { link: { access: 'read-only' } }), /read-only/],
    ['link expiring within minLinkHours', freshObs('env-home', { link: { expiresAt: iso(NOW + 2 * HOUR) } }), /expires within 24 hours/],
    ['expired link', freshObs('env-home', { link: { expiresAt: iso(NOW - HOUR) } }), /missing or expired/],
    ['no providers', freshObs('env-home', { providers: [] }), /No provider can run/],
    ['no project for repo', freshObs('env-home', { projects: { 'github.com/other/repo': 'p' } }), /No project observed for github.com\/owner\/repo/],
  ];
  for (const [name, obs, reason] of rejectCases) {
    test(`remote filtered: ${name}`, () => {
      const { result } = run('place', { state: mkState({ 'home-box': obs }), options: { place: 'box' } });
      assert.equal(result.ok, false);
      assert.equal(result.skipped.find((s) => s.label === 'home-box').reason.match(reason) !== null, true, result.skipped[1].reason);
    });
  }

  test('provider filter applies to remotes only', () => {
    const r = run('place', { options: { provider: 'claude-9' } }).result;
    assert.equal(r.placement.label, 'local');
    assert.match(r.placement.skipped[0].reason, /Provider claude-9 cannot run there/);
    const ok = run('place', { options: { provider: 'codex-1' } }).result;
    assert.equal(ok.placement.label, 'home-box');
    assert.deepEqual(ok.placement.providers, ['codex-1']);
  });

  test('null repo cannot place remotely but can place locally', () => {
    const r = run('place', { repo: null }).result;
    assert.equal(r.placement.label, 'local');
    assert.match(r.placement.skipped[0].reason, /No repository key/);
  });

  test('cooling box is filtered', () => {
    const state = mkState({ 'home-box': freshObs('env-home') }, { health: { 'home-box': { failures: 1, cooldownUntil: iso(NOW + 10 * MIN), lastFailureAt: iso(NOW - 20 * MIN) } } });
    const r = run('place', { state, options: { place: 'box' } }).result;
    assert.equal(r.ok, false);
    assert.match(r.skipped[1].reason, /Cooling down until/);
  });

  test('repo needs, deny and pin', () => {
    const needs = mkConfig({ repos: { [REPO]: { needs: ['ios-sim'] } } });
    assert.equal(run('place', { config: needs }).result.placement.label, 'local');
    const deny = mkConfig({ repos: { [REPO]: { deny: ['home-box'] } } });
    const d = run('place', { config: deny }).result;
    assert.equal(d.placement.label, 'local');
    assert.deepEqual(d.placement.skipped, [{ label: 'home-box', reason: 'Denied for this repo by config.' }]);
    const pin = mkConfig({ repos: { [REPO]: { pin: 'local' } } });
    assert.equal(run('place', { config: pin }).result.placement.label, 'local');
  });

  test('conflicting pins, unknown labels and bad counts fail before changing state', () => {
    const pin = mkConfig({ repos: { [REPO]: { pin: 'home-box' } } });
    assert.match(run('place', { config: pin, options: { place: 'local' } }).result.error, /Conflicting pins/);
    assert.match(run('place', { options: { place: 'nope' } }).result.error, /Unknown machine label nope/);
    for (const count of [0, -1, 1.5]) assert.match(run('place', { options: { count } }).result.error, /positive integer/);
    assert.match(run('place', { options: { branch: 'a;rm -rf' } }).result.error, /--branch/);
    const { ids } = run('place', { options: { place: 'nope' } });
    assert.equal(ids.n, 0, 'no slot ID consumed on error');
  });

  test('ephemeral machines are never placed in Phase 1', () => {
    const config = mkConfig({ machines: { eph: box('env-eph', { kind: 'ephemeral', priority: 99 }) } });
    const r = run('place', { config, state: mkState({ eph: freshObs('env-eph') }) }).result;
    assert.equal(r.placement.label, 'local');
    assert.match(r.placement.skipped[0].reason, /ephemeral is not supported/);
  });
});

describe('place: missing observations', () => {
  test('cold cache returns needsObservation, books nothing, uses no IDs', () => {
    const { result, state, ids } = run('place', { state: mkState() });
    assert.equal(result.ok, false);
    assert.deepEqual(result.needsObservation, {
      calls: [
        { tool: 't3_environment_links', args: {} },
        { tool: 'orchestrator_capabilities', args: { environmentId: 'env-home' } },
        { tool: 't3_project_list', args: { environmentId: 'env-home' } },
      ],
      observe: 'box-router observe',
    });
    assert.deepEqual(state.slots, {});
    assert.equal(ids.n, 0);
  });

  test('only the stale link is requested when facts are fresh', () => {
    const obs = freshObs('env-home', { at: NOW - 20 * MIN }); // link envelope (15 min) stale, facts (24 h) fresh
    const { result } = run('place', { state: mkState({ 'home-box': obs }) });
    assert.deepEqual(result.needsObservation.calls, [{ tool: 't3_environment_links', args: {} }]);
    assert.deepEqual(result.pending, [{ label: 'home-box', missing: ['link'] }]);
  });

  test('validUntil beyond the configured TTL is capped by observedAt + TTL', () => {
    const obs = freshObs('env-home');
    obs.link = { ...obs.link, observedAt: iso(NOW - 30 * MIN), validUntil: iso(NOW + HOUR) };
    assert.ok(run('place', { state: mkState({ 'home-box': obs }) }).result.needsObservation);
  });

  test('environment ID change invalidates observations', () => {
    const state = mkState({ 'home-box': freshObs('env-old') });
    assert.ok(run('place', { state }).result.needsObservation);
  });

  test('pending lower tier does not block when the top tier answers', () => {
    const config = mkConfig({ machines: { hi: box('env-hi', { priority: 10 }), lo: box('env-lo', { priority: 5 }) } });
    const { result } = run('place', { config, state: mkState({ hi: freshObs('env-hi') }) });
    assert.equal(result.placement.label, 'hi');
    assert.deepEqual(result.placement.skipped.find((s) => s.label === 'lo'), {
      label: 'lo', reason: 'Needs a fresh observation of link, providers, projects.',
    });
  });

  test('pending lower tier is requested once the batch overflows into it', () => {
    const config = mkConfig({ machines: { hi: box('env-hi', { priority: 10, maxConcurrent: 1 }), lo: box('env-lo', { priority: 5 }) } });
    const { result } = run('place', { config, state: mkState({ hi: freshObs('env-hi') }), options: { count: 2 } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.pending.map((p) => p.label), ['lo']);
  });

  test('pending box filtered by a known fact is not requested', () => {
    const state = mkState({}, { health: { 'home-box': { failures: 1, cooldownUntil: iso(NOW + HOUR), lastFailureAt: iso(NOW) } } });
    assert.equal(run('place', { state }).result.placement.label, 'local');
  });

  test('explicit local placement bypasses stale remote facts', () => {
    assert.equal(run('place', { state: mkState(), options: { place: 'local' } }).result.placement.label, 'local');
  });
});

describe('TTL and leases', () => {
  test('expired slots do not count against capacity', () => {
    const slots = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`x${i}`, slot('home-box', { expiresAt: iso(NOW - 1) })]));
    const { result } = run('place', { state: mkState({ 'home-box': freshObs('env-home') }, { slots }) });
    assert.equal(result.placement.label, 'home-box');
  });

  test('slot TTL comes from config', () => {
    const { result } = run('place', { config: mkConfig({ defaults: { slotTtlMinutes: 10 } }) });
    assert.equal(result.placement.slot.expiresAt, iso(NOW + 10 * MIN));
  });

  test('acquire leases a ready box; place --run uses the lease and renews it', () => {
    const acq = run('acquire', { options: { run: 'r1', needs: ['linux'] } });
    assert.deepEqual(acq.result, {
      ok: true,
      machines: [{ label: 'home-box', environmentId: 'env-home' }],
      errors: [],
      expiresAt: iso(NOW + 24 * HOUR),
    });
    const later = NOW + 2 * HOUR;
    const state = { ...acq.state, observations: { 'home-box': freshObs('env-home', { at: later - MIN }) } };
    const placed = run('place', { state, options: { run: 'r1' }, now: later });
    assert.equal(placed.result.placement.label, 'home-box');
    assert.equal(placed.state.slots.s1.run, 'r1');
    assert.equal(placed.state.leases.r1.expiresAt, iso(later + 24 * HOUR));
  });

  test('place --run without a lease keeps remote work off unleased boxes', () => {
    const r = run('place', { options: { run: 'r1' } }).result;
    assert.equal(r.placement.label, 'local');
    assert.deepEqual(r.placement.skipped, [{ label: 'home-box', reason: 'Not leased to run r1.' }]);
    const expired = mkState({ 'home-box': freshObs('env-home') }, { leases: { r1: { machines: ['home-box'], expiresAt: iso(NOW - 1) } } });
    const e = run('place', { state: expired, options: { run: 'r1' } });
    assert.equal(e.result.placement.label, 'local');
    assert.equal(e.state.leases.r1.expiresAt, iso(NOW - 1), 'an expired lease is not renewed by place');
  });

  test('acquire on a cold cache asks for observations before leasing', () => {
    const { result, state } = run('acquire', { state: mkState(), options: { run: 'r1' } });
    assert.equal(result.ok, false);
    assert.equal(result.needsObservation.calls.length, 3);
    assert.deepEqual(state.leases, {});
  });

  test('partial acquire returns shortfall and errors; zero is an error', () => {
    const config = mkConfig({ machines: { a: box('env-a'), b: box('env-b') } });
    const state = mkState({ a: freshObs('env-a'), b: freshObs('env-b', { link: { status: 'offline' } }) });
    const { result } = run('acquire', { config, state, options: { run: 'r1', count: 2 } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.machines, [{ label: 'a', environmentId: 'env-a' }]);
    assert.equal(result.shortfall, 1);
    assert.match(result.errors[0], /^b: Link status is offline/);
    const none = run('acquire', { config, state, options: { run: 'r1', needs: ['gpu'] } }).result;
    assert.equal(none.ok, false);
    assert.equal(none.error, 'No eligible box.');
  });

  test('acquire ignores capacity because leases do not reserve slots', () => {
    const slots = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`x${i}`, slot('home-box')]));
    const { result } = run('acquire', { state: mkState({ 'home-box': freshObs('env-home') }, { slots }), options: { run: 'r1' } });
    assert.equal(result.ok, true);
  });

  test('reacquire keeps held boxes, then prefers unheld over shared boxes', () => {
    const config = mkConfig({ machines: { a: box('env-a', { priority: 10 }), b: box('env-b', { priority: 10 }), c: box('env-c', { priority: 1 }) } });
    const obs = { a: freshObs('env-a'), b: freshObs('env-b'), c: freshObs('env-c') };
    const leases = {
      r1: { machines: ['b'], expiresAt: iso(NOW + HOUR) },
      other: { machines: ['a'], expiresAt: iso(NOW + HOUR) },
    };
    const { result, state } = run('acquire', { config, state: mkState(obs, { leases }), options: { run: 'r1', count: 2 } });
    assert.deepEqual(result.machines.map((m) => m.label), ['b', 'c']);
    assert.deepEqual(state.leases.r1.machines, ['b', 'c']);
    assert.deepEqual(state.leases.other.machines, ['a']);
  });

  test('release is idempotent and keeps always-on boxes', () => {
    const state = mkState({}, { leases: { r1: { machines: ['home-box'], expiresAt: iso(NOW + HOUR) } } });
    const first = run('release', { state, options: { run: 'r1' } });
    assert.deepEqual(first.result, { ok: true, run: 'r1', stopped: [], kept: ['home-box'] });
    assert.deepEqual(first.state.leases, {});
    const second = run('release', { state: first.state, options: { run: 'r1' } });
    assert.deepEqual(second.result, { ok: true, run: 'r1', stopped: [], kept: [] });
  });

  test('register-payload emits the raw swarm array from fresh facts', () => {
    const state = mkState({ 'home-box': freshObs('env-home') }, { leases: { r1: { machines: ['home-box'], expiresAt: iso(NOW + HOUR) } } });
    const { result } = run('register-payload', { state, options: { run: 'r1' } });
    assert.deepEqual(result, [{ label: 'home-box', environmentId: 'env-home', providers: ['codex-1'], projects: { [REPO]: 'proj-env-home' } }]);
  });

  test('register-payload filters to usable boxes, errors on lapsed lease, clears on request', () => {
    const config = mkConfig({ machines: { a: box('env-a'), b: box('env-b') } });
    const obs = { a: freshObs('env-a'), b: freshObs('env-b', { link: { status: 'offline' } }) };
    const leased = mkState(obs, { leases: { r1: { machines: ['a', 'b'], expiresAt: iso(NOW + HOUR) } } });
    assert.deepEqual(run('register-payload', { config, state: leased, options: { run: 'r1' } }).result.map((e) => e.label), ['a']);

    const lapsed = mkState(obs, { leases: { r1: { machines: ['a'], expiresAt: iso(NOW - 1) } } });
    const err = run('register-payload', { config, state: lapsed, options: { run: 'r1' } }).result;
    assert.equal(err.ok, false);
    assert.equal(Array.isArray(err), false);
    assert.deepEqual(run('register-payload', { config, state: lapsed, options: { run: 'r1', clear: true } }).result, []);

    const allDown = mkState({ a: freshObs('env-a', { link: { status: 'offline' } }) }, { leases: { r1: { machines: ['a'], expiresAt: iso(NOW + HOUR) } } });
    const zero = run('register-payload', { config, state: allDown, options: { run: 'r1' } }).result;
    assert.equal(zero.ok, false, 'never an empty array without --clear');
  });

  test('register-payload asks for a refresh of stale facts on a leased box', () => {
    const obs = freshObs('env-home', { at: NOW - 25 * HOUR });
    const state = mkState({ 'home-box': obs }, { leases: { r1: { machines: ['home-box'], expiresAt: iso(NOW + HOUR) } } });
    const { result } = run('register-payload', { state, options: { run: 'r1' } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.needsObservation.calls.map((c) => c.tool), ['t3_environment_links', 'orchestrator_capabilities', 't3_project_list']);
  });
});

describe('health', () => {
  test('report frees every slot on the box and sets the cooldown', () => {
    const state = mkState({ 'home-box': freshObs('env-home') }, { slots: { a: slot('home-box'), b: slot('home-box'), c: slot('local') } });
    const { result, state: next } = run('report', { state, options: { args: ['home-box', 'unreachable'] } });
    assert.deepEqual(result, { ok: true, label: 'home-box', state: 'cooling', cooldownUntil: iso(NOW + 30 * MIN), releasedSlots: ['a', 'b'] });
    assert.deepEqual(Object.keys(next.slots), ['c']);
    assert.deepEqual(next.health['home-box'], { failures: 1, cooldownUntil: iso(NOW + 30 * MIN), lastFailureAt: iso(NOW) });
  });

  test('min-cooldown lengthens, and a failure never shortens an existing deadline', () => {
    const long = run('report', { options: { args: ['home-box', 'unreachable'], minCooldown: 2 * HOUR } });
    assert.equal(long.result.cooldownUntil, iso(NOW + 2 * HOUR));
    const again = run('report', { state: long.state, options: { args: ['home-box', 'unreachable'] }, now: NOW + MIN });
    assert.equal(again.result.cooldownUntil, iso(NOW + 2 * HOUR));
    assert.equal(again.state.health['home-box'].failures, 2);
  });

  test('report validates its arguments', () => {
    assert.equal(run('report', { options: { args: ['nope', 'unreachable'] } }).result.ok, false);
    assert.equal(run('report', { options: { args: ['home-box', 'flaky'] } }).result.ok, false);
    assert.equal(run('report', { options: { args: ['local', 'unreachable'] } }).result.ok, false);
  });

  test('done unreachable is report for the slot machine', () => {
    const state = mkState({ 'home-box': freshObs('env-home') }, { slots: { a: slot('home-box'), b: slot('home-box') } });
    const { result, state: next } = run('done', { state, options: { slot: 'a', outcome: 'unreachable', minCooldown: HOUR } });
    assert.equal(result.released, true);
    assert.deepEqual(result.releasedSlots, ['a', 'b']);
    assert.equal(next.health['home-box'].cooldownUntil, iso(NOW + HOUR));
  });

  test('done failed frees the slot without charging health', () => {
    const state = mkState({ 'home-box': freshObs('env-home') }, { slots: { a: slot('home-box') } });
    const { result, state: next } = run('done', { state, options: { slot: 'a', outcome: 'failed' } });
    assert.equal(result.released, true);
    assert.deepEqual(next.slots, {});
    assert.deepEqual(next.health, {});
  });

  test('recovering after cooldown: one slot at a time until done ok clears it', () => {
    const reported = run('report', { options: { args: ['home-box', 'unreachable'] } });
    const later = NOW + 31 * MIN;
    const state = { ...reported.state, observations: { 'home-box': freshObs('env-home', { at: later - MIN }) } };
    const listed = run('list', { state, now: later }).result;
    assert.equal(listed.machines.find((m) => m.label === 'home-box').state, 'recovering');

    const batch = run('place', { state, now: later, options: { count: 2, needs: ['linux'] } });
    assert.equal(batch.result.placements.length, 1);
    assert.match(batch.result.placements[0].placement.why, /Recovering/);
    assert.match(batch.result.skipped.find((s) => s.label === 'home-box').reason, /one slot at a time/);

    const done = run('done', { state: batch.state, now: later + MIN, options: { slot: 's1', outcome: 'ok' } });
    assert.equal(done.result.recovered, true);
    assert.equal(done.state.health['home-box'].failures, 0);
    assert.equal(run('list', { state: done.state, now: later + MIN }).result.machines[1].state, 'ready');
  });

  test('a stale completion cannot clear a newer outage', () => {
    const state = mkState(
      { 'home-box': freshObs('env-home') },
      {
        slots: { old: slot('home-box', { placedAt: iso(NOW - HOUR) }) },
        health: { 'home-box': { failures: 1, cooldownUntil: iso(NOW - MIN), lastFailureAt: iso(NOW - 40 * MIN) } },
      },
    );
    const { result, state: next } = run('done', { state, options: { slot: 'old', outcome: 'ok' } });
    assert.equal(result.released, true);
    assert.equal(result.recovered, undefined);
    assert.equal(next.health['home-box'].failures, 1);
  });

  test('manual cooldown sets a deadline without shortening one; clear-cooldown resets', () => {
    const c = run('cooldown', { options: { args: ['home-box', '2h'] } });
    assert.equal(c.result.cooldownUntil, iso(NOW + 2 * HOUR));
    const shorter = run('cooldown', { state: c.state, options: { args: ['home-box', '5m'] } });
    assert.equal(shorter.result.cooldownUntil, iso(NOW + 2 * HOUR));
    assert.equal(run('place', { state: c.state, options: { place: 'box' } }).result.ok, false);
    const cleared = run('clear-cooldown', { state: c.state, options: { args: ['home-box'] } });
    assert.equal(cleared.result.cleared, true);
    assert.equal(run('place', { state: cleared.state }).result.placement.label, 'home-box');
    assert.equal(run('cooldown', { options: { args: ['home-box', 'soon'] } }).result.ok, false);
  });

  test('clear-cooldown resets the failure streak', () => {
    const reported = run('report', { options: { args: ['home-box', 'unreachable'] } });
    const cleared = run('clear-cooldown', { state: reported.state, options: { args: ['home-box'] } });
    assert.deepEqual(cleared.state.health['home-box'], { failures: 0, cooldownUntil: null, lastFailureAt: iso(NOW) });
    const again = run('clear-cooldown', { state: cleared.state, options: { args: ['home-box'] } });
    assert.equal(again.result.cleared, false);
  });

  test('failed HTTPS probe marks a reachable box degraded but eligible', () => {
    const state = mkState({ 'home-box': freshObs('env-home', { probe: false }) });
    const { result } = run('place', { state });
    assert.equal(result.placement.label, 'home-box');
    assert.match(result.placement.why, /Degraded/);
    assert.equal(run('list', { state }).result.machines[1].state, 'degraded');
    const ok = mkState({ 'home-box': freshObs('env-home', { probe: true }) });
    assert.equal(run('list', { state: ok }).result.machines[1].state, 'ready');
  });

  test('derived states follow the restrictive order', () => {
    const stateOf = (obs, extra) => run('list', { state: mkState(obs ? { 'home-box': obs } : {}, extra) }).result.machines[1].state;
    assert.equal(stateOf(null), 'unknown');
    assert.equal(stateOf(freshObs('env-home', { link: { status: 'offline' } })), 'cooling');
    assert.equal(stateOf(freshObs('env-home', { link: { expiresAt: iso(NOW - 1) } }), {
      health: { 'home-box': { failures: 1, cooldownUntil: iso(NOW + HOUR), lastFailureAt: iso(NOW) } },
    }), 'unlinked');
    assert.equal(stateOf(null, { health: { 'home-box': { failures: 1, cooldownUntil: iso(NOW + HOUR), lastFailureAt: iso(NOW) } } }), 'cooling');
  });

  test('cooldown expiry never overrides a fresh non-reachable link', () => {
    const state = mkState(
      { 'home-box': freshObs('env-home', { link: { status: 'offline' } }) },
      { health: { 'home-box': { failures: 1, cooldownUntil: iso(NOW - MIN), lastFailureAt: iso(NOW - HOUR) } } },
    );
    assert.equal(run('place', { state }).result.placement.label, 'local');
  });
});

describe('idempotency and validation', () => {
  test('done on a released or unknown slot is harmless', () => {
    const placed = run('place');
    const first = run('done', { state: placed.state, options: { slot: 's1', outcome: 'ok' } });
    assert.equal(first.result.released, true);
    const second = run('done', { state: first.state, options: { slot: 's1', outcome: 'ok' } });
    assert.deepEqual(second.result, { ok: true, slot: 's1', released: false });
    assert.deepEqual(second.state, first.state);
    const unreachable = run('done', { state: first.state, options: { slot: 's1', outcome: 'unreachable' } });
    assert.deepEqual(unreachable.state.health, {}, 'stale slot cannot start a cooldown');
  });

  test('done on an expired slot reports released false', () => {
    const state = mkState({}, { slots: { e: slot('home-box', { expiresAt: iso(NOW - 1) }) } });
    assert.equal(run('done', { state, options: { slot: 'e', outcome: 'ok' } }).result.released, false);
  });

  test('done validates slot and outcome', () => {
    assert.equal(run('done', { options: { outcome: 'ok' } }).result.ok, false);
    assert.equal(run('done', { options: { slot: 's1', outcome: 'maybe' } }).result.ok, false);
  });

  test('required --run and unknown commands', () => {
    for (const cmd of ['acquire', 'release', 'register-payload']) assert.equal(run(cmd).result.ok, false);
    assert.equal(run('nope').result.ok, false);
  });

  test('inputs are never mutated across a full sequence', () => {
    // run() deep-freezes every input; any mutation would throw in strict mode.
    const a = run('acquire', { options: { run: 'r1' } });
    const p = run('place', { state: a.state, options: { run: 'r1', count: 3 } });
    const d = run('done', { state: p.state, options: { slot: 's2', outcome: 'ok' } });
    const r = run('report', { state: d.state, options: { args: ['home-box', 'unreachable'] } });
    run('release', { state: r.state, options: { run: 'r1' } });
  });
});

describe('list and doctor', () => {
  test('list reports inventory, health, leases and slots', () => {
    const state = mkState(
      { 'home-box': freshObs('env-home') },
      { leases: { r1: { machines: ['home-box'], expiresAt: iso(NOW + HOUR) } }, slots: { a: slot('home-box', { run: 'r1' }) } },
    );
    const { result } = run('list', { state });
    assert.equal(result.ok, true);
    assert.deepEqual(result.machines[0], {
      label: 'local', state: 'ready', heldBy: [], tags: ['macos', 'arm64', 'ios-sim', 'xcode'], priority: 0, maxConcurrent: 4, activeSlots: 0,
    });
    assert.deepEqual(result.machines[1], {
      label: 'home-box', environmentId: 'env-home', state: 'ready', heldBy: ['r1'], tags: ['linux', 'gpu', 'ram-32g', 'godot'], priority: 10, maxConcurrent: 6, activeSlots: 1,
    });
    assert.deepEqual(result.leases, [{ run: 'r1', machines: ['home-box'], expiresAt: iso(NOW + HOUR) }]);
    assert.equal(result.slots[0].id, 'a');
  });

  test('doctor reports config errors, Phase 2 warnings and missing facts', () => {
    const config = mkConfig({
      machines: {
        box: box('env-1'),
        dup: box('env-1', { weight: 2, url: 'http://x' }),
        bad: { kind: 'always-on', tags: ['linux'], maxConcurrent: 0 },
      },
      repos: { [REPO]: { pin: 'ghost', priority: { dup: 1 } } },
    });
    const { result } = run('doctor', { config, state: mkState() });
    assert.equal(result.ok, false);
    const errors = result.errors.join('\n');
    assert.match(errors, /box is reserved/);
    assert.match(errors, /machines.dup.environmentId duplicates machines.box/);
    assert.match(errors, /machines.bad.environmentId is required/);
    assert.match(errors, /machines.bad.maxConcurrent must be a positive integer/);
    assert.match(errors, /machines.dup.url must be an https URL/);
    assert.match(errors, /pin names unknown machine ghost/);
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /machines.dup.weight is a Phase 2 field/);
    assert.match(warnings, /priority is a Phase 2 field/);
    assert.ok(result.needsObservation.calls.length > 0);
  });

  test('doctor is ok for a valid config with fresh facts', () => {
    const { result } = run('doctor');
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.needsObservation, undefined);
    assert.deepEqual(result.machines.map((m) => m.state), ['ready', 'ready']);
  });

  test('validateConfig on a minimal config', () => {
    assert.deepEqual(validateConfig(mkConfig()), { errors: [], warnings: [] });
  });
});

describe('helpers', () => {
  test('parseDuration', () => {
    assert.equal(parseDuration('30m'), 30 * MIN);
    assert.equal(parseDuration('2h'), 2 * HOUR);
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('1d'), 24 * HOUR);
    assert.equal(parseDuration(5000), 5000);
    assert.equal(parseDuration('0m'), null);
    assert.equal(parseDuration('soon'), null);
  });

  test('pruneExpired drops expired slots, leases and observation envelopes', () => {
    const obs = freshObs('env-home', { at: NOW - 20 * MIN });
    const state = deepFreeze(mkState({ 'home-box': obs }, {
      slots: { live: slot('home-box'), dead: slot('home-box', { expiresAt: iso(NOW - 1) }) },
      leases: { live: { machines: [], expiresAt: iso(NOW + 1) }, dead: { machines: [], expiresAt: iso(NOW - 1) } },
    }));
    const pruned = pruneExpired(state, NOW);
    assert.deepEqual(Object.keys(pruned.slots), ['live']);
    assert.deepEqual(Object.keys(pruned.leases), ['live']);
    assert.equal(pruned.observations['home-box'].link, undefined);
    assert.ok(pruned.observations['home-box'].providers);
  });
});
