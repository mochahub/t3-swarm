import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULTS,
  StoreError,
  emptyState,
  homePaths,
  init,
  inspectConfig,
  loadConfig,
  localPlatformTags,
  pruneState,
  readState,
  transaction,
  validateConfig,
} from "../../skills/t3-box-router/scripts/store.mjs";

const STORE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/t3-box-router/scripts/store.mjs"),
).href;

const NOW = Date.parse("2030-01-01T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-store-"));
  return path.join(dir, "boxes");
}
const mode = (p) => fs.statSync(p).mode & 0o777;

function baseConfig(extra = {}) {
  return {
    version: 1,
    local: { tags: ["ios-sim"], maxConcurrent: 4 },
    machines: {
      "home-box": { environmentId: "env-home", url: "https://home-box.example", tags: ["linux", "gpu"], maxConcurrent: 6, exclusive: ["gpu"] },
      "other-box": { environmentId: "env-other", tags: ["linux"] },
    },
    repos: { "github.com/Owner/Repo": { needs: ["linux"], pin: "home-box" } },
    ...extra,
  };
}

function validConfig(raw = baseConfig()) {
  const v = validateConfig(raw);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return v.config;
}

async function setup(raw = baseConfig()) {
  const home = tmpHome();
  const r = await init(home, raw);
  assert.equal(r.ok, true, JSON.stringify(r));
  return { home, config: loadConfig(home), paths: homePaths(home) };
}

// ------------------------------------------------------------------------------------------------- init

test("init creates a private home with config and empty state", async () => {
  const home = tmpHome();
  const r = await init(home);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.stateCreated, true);
  const p = homePaths(home);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(p.config), 0o600);
  assert.equal(mode(p.state), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.state, "utf8")), emptyState());
  const config = loadConfig(home);
  assert.deepEqual(config.machines, {});
  assert.deepEqual(config.defaults, { ...DEFAULTS });
  for (const t of localPlatformTags()) assert.ok(config.local.tags.includes(t));
});

test("init reports an existing setup and never overwrites it", async () => {
  const { home, paths } = await setup();
  const before = fs.readFileSync(paths.config, "utf8");
  const r = await init(home, { version: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(r.stateExists, true);
  assert.equal(fs.readFileSync(paths.config, "utf8"), before);
});

test("init flags an existing invalid config", async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(homePaths(home).config, "{ nope");
  const r = await init(home);
  assert.equal(r.ok, false);
  assert.equal(r.created, false);
  assert.match(r.error, /invalid/i);
});

test("init refuses an invalid proposed config and writes nothing", async () => {
  const home = tmpHome();
  const r = await init(home, { version: 1, machines: { local: { environmentId: "env-x" } } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /reserved/.test(e)));
  assert.equal(fs.existsSync(home), false);
});

// ------------------------------------------------------------------------------------------------- config

test("loadConfig applies defaults and lowercases repo keys", async () => {
  const { config } = await setup();
  assert.equal(config.defaults.linkTtlMinutes, 15);
  assert.equal(config.defaults.cooldownMinutes, 30);
  assert.equal(config.machines["other-box"].kind, "always-on");
  assert.equal(config.machines["other-box"].priority, 10);
  assert.equal(config.machines["other-box"].maxConcurrent, 2);
  assert.equal(config.machines["other-box"].worktreeRoot, "~/work");
  assert.equal(config.machines["other-box"].renew, "manual");
  assert.deepEqual(config.repos["github.com/owner/repo"].needs, ["linux"]);
  assert.equal(config.allowProjectOverride, false);
  assert.ok(config.local.tags.includes("ios-sim"));
});

test("loadConfig throws a StoreError envelope for a missing or broken config", () => {
  const home = tmpHome();
  assert.throws(() => loadConfig(home), (err) => err instanceof StoreError && err.result.ok === false && err.result.missing === true);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(homePaths(home).config, JSON.stringify({ version: 1, machines: { box: { environmentId: "e" } } }));
  assert.throws(() => loadConfig(home), (err) => err instanceof StoreError && err.result.errors.some((e) => /reserved/.test(e)));
});

test("validateConfig rejects unsafe and inconsistent inventory", () => {
  const cases = [
    [{ machines: { Local: { environmentId: "e1" } } }, /reserved/],
    [{ machines: { a: { environmentId: "e1" }, b: { environmentId: "e1" } } }, /already used/],
    [{ machines: { a: { environmentId: "e1" }, A: { environmentId: "e2" } } }, /collides/],
    [{ machines: { a: { environmentId: "e1", maxConcurrent: 0 } } }, /positive/],
    [{ machines: { a: { environmentId: "e1", maxConcurrent: 1.5 } } }, /integer/],
    [{ machines: { a: { environmentId: "e1", url: "http://a.example" } } }, /https/],
    [{ machines: { a: { environmentId: "e1", url: "https://u:p@a.example" } } }, /credentials/],
    [{ machines: { a: { environmentId: "e1", url: "https://a.example/?token=x" } } }, /query/],
    [{ machines: { a: { environmentId: "e1", worktreeRoot: "~/work;rm -rf" } } }, /worktreeRoot/],
    [{ machines: { a: { environmentId: "e1", worktreeRoot: "~/../etc" } } }, /worktreeRoot/],
    [{ machines: { a: { environmentId: "e1", kind: "ephemeral" } } }, /Phase 4/],
    [{ machines: { a: {} } }, /environmentId/],
    [{ machines: { "bad label": { environmentId: "e1" } } }, /must match/],
    [{ machines: { a: { environmentId: "e1", tags: ["has space"] } } }, /invalid tag/],
    [{ repos: { "github.com/o/r": { pin: "nowhere" } } }, /pin/],
    [{ repos: { "github.com/o/r": {}, "GitHub.com/O/R": {} } }, /duplicates/],
    [{ repos: { "github.com/o/r": { worktreeCommand: "$(evil)" } } }, /worktreeCommand/],
    [{ defaults: { slotTtlMinutes: 0 } }, /positive/],
    [{ defaults: { minLinkHours: -1 } }, /at least 0/],
  ];
  for (const [extra, pattern] of cases) {
    const v = validateConfig({ version: 1, ...extra });
    assert.equal(v.ok, false, `expected failure for ${JSON.stringify(extra)}`);
    assert.ok(v.errors.some((e) => pattern.test(e)), `${JSON.stringify(extra)} -> ${JSON.stringify(v.errors)}`);
  }
  assert.equal(validateConfig({ version: 2 }).ok, false);
  assert.equal(validateConfig([]).ok, false);
  assert.equal(validateConfig({ version: 1, defaults: { minLinkHours: 0 } }).ok, true);
});

test("Phase 2 fields are reported as inactive, not rejected", async () => {
  const raw = baseConfig({ allowProjectOverride: true });
  raw.machines["home-box"].renew = "auto";
  raw.machines["home-box"].checks = [{ tag: "gpu", command: ["/x"], timeoutMs: 3000 }];
  raw.repos["github.com/Owner/Repo"].priority = { "home-box": 10 };
  const { home } = await setup(raw);
  const r = inspectConfig(home);
  assert.equal(r.ok, true);
  for (const f of ["allowProjectOverride", "renew auto", "checks", "priority"]) {
    assert.ok(r.warnings.some((w) => w.includes(f) && /inactive/.test(w)), `${f}: ${JSON.stringify(r.warnings)}`);
  }
});

test("bringUp is a Phase 1 hook: kept verbatim, validated, with its timeout and retry window", async () => {
  const raw = baseConfig({ defaults: { bringUpTimeoutMs: 90_000, bringUpRetryMinutes: 5 } });
  const argv = ["/opt/start box", "--label", "home-box", " spaced "];
  raw.machines["home-box"].bringUp = argv;
  raw.machines["home-box"].bringUpTimeoutMs = 300_000;
  const { home } = await setup(raw);
  const r = inspectConfig(home);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.config.machines["home-box"].bringUp, argv);
  assert.equal(r.config.machines["home-box"].bringUpTimeoutMs, 300_000);
  assert.equal(r.config.defaults.bringUpTimeoutMs, 90_000);
  assert.equal(r.config.defaults.bringUpRetryMinutes, 5);
  assert.equal(validConfig().defaults.bringUpTimeoutMs, undefined, "absent keys stay absent");

  for (const [bringUp, pattern] of [
    [[], /non-empty array/],
    ["/bin/start", /non-empty array/],
    [["relative/start"], /absolute path/],
    [["/bin/start", ""], /non-empty strings/],
    [["/bin/start", "a\0b"], /without NUL/],
    [["/bin/start", 3], /non-empty strings/],
  ]) {
    const bad = baseConfig();
    bad.machines["home-box"].bringUp = bringUp;
    const v = validateConfig(bad);
    assert.equal(v.ok, false, JSON.stringify(bringUp));
    assert.ok(v.errors.some((e) => pattern.test(e)), `${JSON.stringify(bringUp)} -> ${JSON.stringify(v.errors)}`);
  }
  for (const t of [999, 600_001, 1.5, "60000"]) {
    const bad = baseConfig();
    bad.machines["home-box"].bringUp = ["/bin/start"];
    bad.machines["home-box"].bringUpTimeoutMs = t;
    assert.ok(validateConfig(bad).errors.some((e) => /bringUpTimeoutMs/.test(e)), String(t));
  }
});

test("pruneState keeps a running bring-up claim and drops old attempts and unknown labels", () => {
  const config = validConfig(baseConfig({ defaults: { bringUpRetryMinutes: 10 } }));
  const state = {
    ...emptyState(),
    bringUp: {
      "home-box": { id: "a", startedAt: iso(NOW - 60 * MIN), deadline: iso(NOW - MIN) },
      "other-box": { id: "b", startedAt: iso(NOW - 30 * MIN), finishedAt: iso(NOW - 11 * MIN), outcome: "up" },
      ghost: { id: "c", startedAt: iso(NOW), deadline: iso(NOW + MIN) },
    },
  };
  assert.equal(pruneState(config, state, NOW), true);
  assert.deepEqual(Object.keys(state.bringUp), ["home-box"], "an unfinished claim waits for the router to finalize it");
  state.bringUp["other-box"] = { id: "d", startedAt: iso(NOW - 10 * MIN), finishedAt: iso(NOW - 9 * MIN), outcome: "failed" };
  assert.equal(pruneState(config, state, NOW), false);
  assert.ok(state.bringUp["other-box"]);
});

test("inspectConfig warns about loose permissions", async () => {
  const { home, paths } = await setup();
  assert.deepEqual(inspectConfig(home).warnings, []);
  fs.chmodSync(paths.config, 0o644);
  assert.ok(inspectConfig(home).warnings.some((w) => /config\.json is mode 644/.test(w)));
});

// ------------------------------------------------------------------------------------------------- transaction

test("transaction runs fn on pruned state with now, writes atomically and returns its result", async () => {
  const { home, config, paths } = await setup();
  const r = await transaction(
    home,
    config,
    (state, now) => {
      assert.equal(now, NOW);
      state.slots.s1 = { label: "home-box", run: null, repo: null, exclusive: [], placedAt: iso(now), expiresAt: iso(now + 60 * MIN) };
      return { state, result: { ok: true, slot: "s1" } };
    },
    { now: NOW },
  );
  assert.deepEqual(r, { ok: true, slot: "s1" });
  const saved = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  assert.equal(saved.slots.s1.label, "home-box");
  assert.equal(mode(paths.state), 0o600);
  assert.equal(fs.existsSync(paths.lock), false);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".tmp")), []);
});

test("transaction keeps pruned state when fn returns state undefined, and accepts a now function", async () => {
  const { home, config, paths } = await setup();
  fs.writeFileSync(
    paths.state,
    JSON.stringify({ ...emptyState(), slots: { old: { label: "home-box", expiresAt: iso(NOW - MIN) } } }),
  );
  const r = await transaction(home, config, (state) => ({ result: Object.keys(state.slots) }), { now: () => NOW });
  assert.deepEqual(r, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.state, "utf8")).slots, {});
});

test("a throwing fn writes nothing and releases the lock", async () => {
  const { home, config, paths } = await setup();
  const before = fs.readFileSync(paths.state, "utf8");
  await assert.rejects(
    transaction(home, config, (state) => {
      state.slots.x = { label: "home-box", expiresAt: iso(NOW + MIN) };
      throw new Error("boom");
    }, { now: NOW }),
    /boom/,
  );
  assert.equal(fs.readFileSync(paths.state, "utf8"), before);
  assert.equal(fs.existsSync(paths.lock), false);
  const r = await transaction(home, config, () => ({ result: "again" }), { lockTimeoutMs: 200 });
  assert.equal(r, "again");
});

test("an async fn or a malformed return is rejected without writing", async () => {
  const { home, config, paths } = await setup();
  const before = fs.readFileSync(paths.state, "utf8");
  await assert.rejects(transaction(home, config, async (state) => ({ state, result: 1 })), /synchronous/);
  await assert.rejects(transaction(home, config, () => 42), /return \{ state, result \}/);
  await assert.rejects(transaction(home, config, () => ({ state: { version: 9 }, result: 1 })), /invalid state/);
  assert.equal(fs.readFileSync(paths.state, "utf8"), before);
  assert.equal(fs.existsSync(paths.lock), false);
});

test("corrupt state is moved aside once, fn is not called, and the next call starts empty", async () => {
  const { home, config, paths } = await setup();
  fs.writeFileSync(paths.state, "{ this is not json");
  let called = false;
  const r = await transaction(home, config, () => {
    called = true;
    return { result: 1 };
  });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.match(r.corruptPath, /state\.json\.corrupt\.\d+$/);
  assert.equal(fs.readFileSync(r.corruptPath, "utf8"), "{ this is not json");
  assert.equal(fs.existsSync(paths.state), false);
  assert.equal(fs.existsSync(paths.lock), false);
  const fine = await transaction(home, config, (state) => ({ result: state }));
  assert.deepEqual(fine, emptyState());
  assert.ok(fs.existsSync(paths.config), "config is untouched");
});

test("non-object state is corrupt; a newer state version is left untouched", async () => {
  const { home, config, paths } = await setup();
  fs.writeFileSync(paths.state, "[]");
  const r1 = await transaction(home, config, () => ({ result: 1 }));
  assert.equal(r1.ok, false);
  assert.ok(r1.corruptPath);
  fs.writeFileSync(paths.state, JSON.stringify({ version: 2, slots: {} }));
  const r2 = await transaction(home, config, () => ({ result: 1 }));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /unsupported version 2/);
  assert.equal(r2.corruptPath, undefined);
  assert.equal(JSON.parse(fs.readFileSync(paths.state, "utf8")).version, 2);
});

test("a held lock times out with an error instead of a result", async () => {
  const { home, config, paths } = await setup();
  fs.mkdirSync(paths.lock);
  fs.writeFileSync(path.join(paths.lock, `${process.pid}.held`), "");
  let called = false;
  const r = await transaction(home, config, () => {
    called = true;
    return { result: 1 };
  }, { lockTimeoutMs: 150 });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.match(r.error, /lock/i);
  assert.ok(fs.existsSync(paths.lock), "someone else's lock is left in place");
});

test("an old lock with an unreadable owner is broken", async () => {
  const { home, config, paths } = await setup();
  fs.mkdirSync(paths.lock);
  const marker = path.join(paths.lock, "invalid-owner");
  fs.writeFileSync(marker, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(marker, old, old);
  const r = await transaction(home, config, () => ({ result: "got it" }), { lockTimeoutMs: 500 });
  assert.equal(r, "got it");
  assert.equal(fs.existsSync(paths.lock), false);
});

test("a fresh lock whose owner process has exited is broken", async () => {
  const { home, config, paths } = await setup();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.mkdirSync(paths.lock);
  fs.writeFileSync(path.join(paths.lock, `${dead}.gone`), "");
  const r = await transaction(home, config, () => ({ result: "got it" }), { lockTimeoutMs: 500 });
  assert.equal(r, "got it");
});

test("a write failure returns an error, not fn's result", { skip: process.getuid?.() === 0 }, async () => {
  const { home, config, paths } = await setup();
  try {
    const r = await transaction(home, config, (state) => {
      fs.chmodSync(home, 0o500);
      state.slots.s = { label: "home-box", expiresAt: iso(Date.now() + MIN) };
      return { state, result: { ok: true, booked: true } };
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /Failed writing/);
  } finally {
    fs.chmodSync(home, 0o700);
    fs.rmSync(paths.lock, { recursive: true, force: true });
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.state, "utf8")).slots, {});
});

test("concurrent processes recover one abandoned owner and never lose an update", async () => {
  const { home, config, paths } = await setup();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.mkdirSync(paths.lock);
  fs.writeFileSync(path.join(paths.lock, `${dead}.gone`), "");
  const script = `
    const { loadConfig, transaction } = await import(${JSON.stringify(STORE_URL)});
    const home = process.argv[1];
    const config = loadConfig(home);
    for (let i = 0; i < 25; i++) {
      const r = await transaction(home, config, (state) => {
        const c = state.leases.counter || { machines: [], expiresAt: "2999-01-01T00:00:00Z", n: 0 };
        c.n += 1;
        state.leases.counter = c;
        return { state, result: c.n };
      }, { lockTimeoutMs: 20000 });
      if (typeof r !== "number") { console.error(JSON.stringify(r)); process.exit(1); }
    }
  `;
  const runs = Array.from({ length: 4 }, () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, home], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
    }),
  );
  await Promise.all(runs);
  const n = await transaction(home, config, (state) => ({ result: state.leases.counter.n }));
  assert.equal(n, 100);
});

// ------------------------------------------------------------------------------------------------- pruning

test("pruneState drops expired and orphaned entries and keeps live ones", () => {
  const config = validConfig();
  const live = iso(NOW + 10 * MIN);
  const past = iso(NOW - MIN);
  const env = (validUntil) => ({ source: "agent", observedAt: iso(NOW - 5 * MIN), validUntil, value: [] });
  const state = {
    ...emptyState(),
    observations: {
      "home-box": { environmentId: "env-home", link: env(live), providers: env(past), projects: env("garbage"), probe: env(live) },
      "other-box": { environmentId: "env-old-identity", link: env(live) },
      "gone-box": { environmentId: "env-gone", link: env(live) },
    },
    health: {
      "home-box": { failures: 2, cooldownUntil: past, lastFailureAt: iso(NOW - 40 * MIN) },
      local: { failures: 0, cooldownUntil: null, lastFailureAt: null },
      "gone-box": { failures: 1, cooldownUntil: live, lastFailureAt: past },
    },
    slots: {
      keep: { label: "home-box", expiresAt: live },
      keepLocal: { label: "local", expiresAt: live },
      expired: { label: "home-box", expiresAt: past },
      orphan: { label: "gone-box", expiresAt: live },
      badTime: { label: "home-box", expiresAt: "not a date" },
    },
    leases: {
      run1: { machines: ["home-box", "gone-box"], expiresAt: live },
      run2: { machines: ["home-box"], expiresAt: past },
    },
    affinity: { "github.com/o/r": { k1: { label: "home-box", expiresAt: past }, k2: { label: "home-box", expiresAt: live } } },
    credits: { "home-box": 1, "gone-box": 2 },
  };
  assert.equal(pruneState(config, state, NOW), true);
  assert.deepEqual(Object.keys(state.observations), ["home-box"]);
  assert.deepEqual(Object.keys(state.observations["home-box"]).sort(), ["environmentId", "link", "probe"]);
  assert.deepEqual(state.health["home-box"], { failures: 2, cooldownUntil: past, lastFailureAt: iso(NOW - 40 * MIN) }, "health outlives its cooldown");
  assert.ok(state.health.local);
  assert.equal(state.health["gone-box"], undefined);
  assert.deepEqual(Object.keys(state.slots).sort(), ["keep", "keepLocal"]);
  assert.deepEqual(state.leases, { run1: { machines: ["home-box"], expiresAt: live } });
  assert.deepEqual(Object.keys(state.affinity["github.com/o/r"]), ["k2"]);
  assert.deepEqual(state.credits, { "home-box": 1 });
  assert.equal(pruneState(config, state, NOW), false, "pruning is idempotent");
});

test("a changed environmentId in config clears that label's observations on the next transaction", async () => {
  const raw = baseConfig();
  const { home, paths } = await setup(raw);
  const live = iso(NOW + 10 * MIN);
  fs.writeFileSync(
    paths.state,
    JSON.stringify({
      ...emptyState(),
      observations: { "home-box": { environmentId: "env-home", link: { source: "t3-cli", observedAt: iso(NOW), validUntil: live, value: null } } },
    }),
  );
  raw.machines["home-box"].environmentId = "env-home-2";
  fs.writeFileSync(paths.config, JSON.stringify(raw));
  const config = loadConfig(home);
  const obs = await transaction(home, config, (state) => ({ result: state.observations }), { now: NOW });
  assert.deepEqual(obs, {});
});

test("readState gives a pruned snapshot without locking, moving or writing anything", async () => {
  const { home, config, paths } = await setup();
  const live = iso(NOW + MIN);
  const text = JSON.stringify({ ...emptyState(), slots: { a: { label: "home-box", expiresAt: live }, b: { label: "home-box", expiresAt: iso(NOW - MIN) } } });
  fs.writeFileSync(paths.state, text);
  fs.writeFileSync(paths.lock, `${process.pid}.held\n`);
  assert.deepEqual(Object.keys(readState(home, config, NOW).slots), ["a"]);
  assert.equal(fs.readFileSync(paths.state, "utf8"), text);
  fs.writeFileSync(paths.state, "{ corrupt");
  assert.deepEqual(readState(home, config, NOW), emptyState());
  assert.equal(fs.readFileSync(paths.state, "utf8"), "{ corrupt");
  fs.rmSync(paths.lock);
});
