import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const router = path.join(root, 'skills/t3-box-router/scripts/box-router.mjs');
const swarm = path.join(root, 'skills/t3-swarm/scripts/swarm.mjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-router-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const boxes = path.join(dir, 'boxes');
  const swarmHome = path.join(dir, 'swarm');
  const bin = path.join(dir, 'bin');
  for (const p of [repo, boxes, swarmHome, bin]) fs.mkdirSync(p);
  // Intercept discovery even on hosts that have a real T3 CLI installed.
  fs.writeFileSync(path.join(bin, 't3'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, T3_BOXES_HOME: boxes, T3_SWARM_HOME: swarmHome, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  function git(...args) {
    const p = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
  }
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-qm', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  fs.writeFileSync(path.join(boxes, 'config.json'), JSON.stringify({
    version: 1, local: { tags: ['macos'], maxConcurrent: 2 },
    machines: { 'home-box': { kind: 'always-on', environmentId: 'env-home', tags: ['linux'], priority: 10, maxConcurrent: 2 } },
  }));
  const swarmConfig = path.join(dir, 'swarm-config.json');
  fs.copyFileSync(path.join(root, 'skills/t3-swarm/references/config.example.json'), swarmConfig);
  function call(script, args, input) {
    const p = spawnSync(process.execPath, [script, ...args], { cwd: repo, env, input, encoding: 'utf8', timeout: 15000 });
    assert.ifError(p.error);
    assert.notEqual(p.status, null, `terminated: ${p.signal}`);
    let json;
    try { json = JSON.parse(p.stdout); } catch { assert.fail(`Invalid JSON for ${args.join(' ')}: ${p.stdout}\n${p.stderr}`); }
    if (!Array.isArray(json)) assert.equal(p.status === 0, json.ok === true, `${args.join(' ')}: ${p.stdout} ${p.stderr}`);
    else assert.equal(p.status, 0);
    return { json, stdout: p.stdout, status: p.status };
  }
  const box = (...args) => call(router, args);
  const sw = (...args) => call(swarm, [...args, '--config', swarmConfig]);
  const observe = () => call(router, ['observe'], JSON.stringify([
    { tool: 't3_environment_links', args: {}, pages: [{ links: [{ environmentId: 'env-home', label: 'home-box', status: 'reachable', access: 'full-access', expiresAt: '2099-01-01T00:00:00Z' }] }] },
    { tool: 'orchestrator_capabilities', args: { environmentId: 'env-home' }, pages: [{ providers: [{ providerInstanceId: 'codex', canRunChildTask: true }] }] },
    { tool: 't3_project_list', args: { environmentId: 'env-home' }, pages: [{ projects: [{ id: 'project-1', repositoryIdentity: { canonicalKey: 'github.com/owner/repo' } }] }] },
  ]));
  return { boxes, box, sw, call, observe };
}

test('Level 0 subprocess contract with the real swarm CLI', (t) => {
  const f = fixture(t);
  const init = f.sw('init', 'contract').json;
  assert.equal(init.ok, true);
  const run = init.runId;
  const cold = f.box('acquire', '--run', run, '--needs', 'linux');
  assert.equal(cold.status, 1);
  assert.ok(cold.json.needsObservation);
  assert.equal(f.observe().json.ok, true);
  const acquired = f.box('acquire', '--run', run, '--count', '1', '--needs', 'linux').json;
  assert.deepEqual(acquired.machines, [{ label: 'home-box', environmentId: 'env-home' }]);
  const payload = f.box('register-payload', '--run', run);
  assert.deepEqual(payload.json, [{ label: 'home-box', environmentId: 'env-home', providers: ['codex'], projects: { 'github.com/owner/repo': 'project-1' } }]);
  assert.match(payload.stdout, /^\s*\[/);
  const registered = f.call(swarm, ['boxes', 'register', '--run', run, '--config', path.join(path.dirname(f.boxes), 'swarm-config.json'), '-'], payload.stdout);
  assert.equal(registered.json.ok, true);
  const policy = f.box('policy-line', '--run', run).json;
  assert.match(policy.text, /Place first, then pick/);
  assert.match(policy.text, /No unpinned swarm picks/);
  const placed = f.box('place', '--run', run, '--needs', 'linux').json;
  assert.equal(placed.placement.label, 'home-box');
  assert.deepEqual(placed.target, { environmentId: 'env-home', projectId: 'project-1' });
  assert.match(placed.briefAddendum, /git fetch origin/);
  const pick = f.sw('pick-worker', 'balanced:medium', '--run', run, '--place', placed.placement.label).json;
  assert.equal(pick.ok, true);
  assert.equal(pick.target.environmentId, 'env-home');
  assert.equal(pick.target.projectId, 'project-1');
  assert.equal(f.box('done', '--slot', placed.placement.slot.id, '--outcome', 'ok').json.released, true);
  const finish = f.sw('finish', run, '--force').json;
  assert.deepEqual(finish.boxes, [{ label: 'home-box', environmentId: 'env-home' }]);
  assert.match(finish.next, /Release/);
  assert.deepEqual(f.box('release', '--run', run).json.kept, ['home-box']);
  assert.deepEqual(f.box('release', '--run', run).json.kept, []);
  assert.equal(f.box('register-payload', '--run', run).status, 1);
  assert.deepEqual(f.box('register-payload', '--run', run, '--clear').json, []);
  // Simulate a lease expiring between CLI invocations without sleeping for its TTL.
  assert.equal(f.box('acquire', '--run', run).json.ok, true);
  const stateFile = path.join(f.boxes, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.leases[run].expiresAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(f.box('register-payload', '--run', run).status, 1);
  assert.deepEqual(f.box('register-payload', '--run', run, '--clear').json, []);
});

test('standalone placement, outage, cooldown and idempotent recovery persist across processes', (t) => {
  const f = fixture(t);
  assert.equal(f.observe().json.ok, true);
  const p = f.box('place', '--needs', 'linux').json;
  assert.equal(p.placement.label, 'home-box');
  assert.equal(f.box('list').json.machines.find(m => m.label === 'home-box').activeSlots, 1);
  const outage = f.box('done', '--slot', p.placement.slot.id, '--outcome', 'unreachable', '--min-cooldown', '1h').json;
  assert.equal(outage.released, true);
  assert.ok(Date.parse(outage.cooldownUntil) >= Date.now() + 59 * 60_000);
  assert.equal(f.box('done', '--slot', p.placement.slot.id, '--outcome', 'unreachable').json.released, false);
  assert.equal(f.box('place', '--place', 'home-box').status, 1);
  const report = f.box('report', 'home-box', 'unreachable', '--min-cooldown', '2h').json;
  assert.ok(Date.parse(report.cooldownUntil) >= Date.now() + 119 * 60_000);
  assert.equal(f.box('clear-cooldown', 'home-box').json.cleared, true);
  assert.equal(f.box('clear-cooldown', 'home-box').json.cleared, false);
  const again = f.box('place', '--place', 'home-box').json;
  assert.equal(again.placement.label, 'home-box');
  assert.equal(f.box('done', '--slot', again.placement.slot.id, '--outcome', 'ok').json.released, true);
  assert.equal(f.box('done', '--slot', again.placement.slot.id, '--outcome', 'ok').json.released, false);
  assert.equal(f.box('list').json.machines.find(m => m.label === 'home-box').activeSlots, 0);
  const bad = f.box('done', '--slot', 'missing', '--outcome', 'wrong');
  assert.equal(bad.status, 1);
  assert.equal(bad.json.ok, false);
});
