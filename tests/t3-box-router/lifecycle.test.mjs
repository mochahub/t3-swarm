// Tests for on-demand and ephemeral lifecycle: the bringUp start marker, per-run ownership, tearDown at release,
// keep-alive, and the user-owned handoff and fetch hooks. Black-box runs use a private router home, swarm home,
// HOME and git checkout, a PATH holding only a fake `t3` plus /usr/bin and /bin, and synthetic shell hooks.
// Nothing here reaches a real T3, the network, a live config or another machine.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStartedMarker, runHook, startedFromHookResult, RESULT_MAX_BYTES } from "../../skills/t3-box-router/scripts/hooks.mjs";
import { adoptStarted, planRelease, annotatePlacement, transferInfo, transferTarget } from "../../skills/t3-box-router/scripts/lifecycle.mjs";
import { decide } from "../../skills/t3-box-router/scripts/engine.mjs";
import { validateConfig, pruneState } from "../../skills/t3-box-router/scripts/store.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/t3-box-router/scripts/box-router.mjs");
const REPO = "github.com/o/r";
const FAR = "2099-01-01T00:00:00.000Z";
const SECRET = "FAKE-SECRET-7f3a9";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_T3 = `#!/bin/sh
[ "$1 $2 $3" = "environment list --json" ] || exit 2
cat "$FAKE_T3_LINKS"
`;

// Every hook: counts its runs per label and hook, saves its stdin, prints a fake secret on stdout and stderr,
// optionally waits for a gate file, optionally swaps the fake link list, writes $HOOK_RESULT (if set) to the result
// file, then exits $HOOK_EXIT. The hook name comes from T3_BOXES_HOOK, set by the router.
const HOOK = `#!/bin/sh
label="$1"
name="$T3_BOXES_HOOK"
echo run >> "$MARK_DIR/$label.$name.runs"
cat > "$MARK_DIR/$label.$name.input.json"
env | grep '^T3_BOXES_' | sort > "$MARK_DIR/$label.$name.env"
case "$HOOK_STDOUT" in \{*) ;; *) echo "stdout ${SECRET}" ;; esac
[ -n "$HOOK_STDOUT" ] && printf '%s\n' "$HOOK_STDOUT"
echo "stderr ${SECRET}" >&2
gate=""
[ "$name" = "tearDown" ] && gate="$DOWN_GATE"
if [ -n "$gate" ]; then i=0; while [ ! -e "$gate" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; fi
if [ "$name" = "bringUp" ] && [ -n "$FAKE_T3_LINKS_UP" ]; then cp "$FAKE_T3_LINKS_UP" "$FAKE_T3_LINKS"; fi
if [ "$name" = "tearDown" ] && [ -n "$FAKE_T3_LINKS_DOWN" ] && [ "\${DOWN_EXIT:-0}" = 0 ]; then cp "$FAKE_T3_LINKS_DOWN" "$FAKE_T3_LINKS"; fi
if [ -n "$T3_BOXES_RESULT_FILE" ] && [ -n "$HOOK_RESULT" ]; then printf '%s' "$HOOK_RESULT" > "$T3_BOXES_RESULT_FILE"; fi
case "$name" in
  tearDown) exit "\${DOWN_EXIT:-0}" ;;
  bringUp) exit "\${UP_EXIT:-0}" ;;
  *) exit "\${HOOK_EXIT:-0}" ;;
esac
`;

function writeExec(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function linksJson(statuses) {
  return JSON.stringify(
    Object.entries(statuses)
      .filter(([, status]) => status !== undefined)
      .map(([environmentId, status]) => ({ environmentId, label: environmentId, status, access: "full-access", expiresAt: FAR })),
  );
}

/**
 * A sealed router environment. machines: { label: { env, kind?, hooks?: [names], priority?, tags? } }.
 * links: the fake t3 link list now; linksUp / linksDown: what the bringUp / tearDown hook switch it to.
 */
function setup({ machines, defaults = {}, links = {}, linksUp = null, linksDown = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-lifecycle-"));
  const dirs = Object.fromEntries(["home", "swarm", "user", "bin", "hooks", "marks", "repo"].map((d) => [d, path.join(root, d)]));
  for (const [name, d] of Object.entries(dirs)) fs.mkdirSync(d, { recursive: true, mode: name === "home" ? 0o700 : 0o755 });
  fs.chmodSync(dirs.home, 0o700);
  writeExec(path.join(dirs.bin, "t3"), FAKE_T3);
  const hook = path.join(dirs.hooks, "hook.sh");
  writeExec(hook, HOOK);
  const gitEnv = { PATH: "/usr/bin:/bin", HOME: dirs.user };
  execFileSync("git", ["init", "-q"], { cwd: dirs.repo, env: gitEnv });
  execFileSync("git", ["remote", "add", "origin", `git@${REPO.replace("/", ":")}.git`], { cwd: dirs.repo, env: gitEnv });

  const linksFile = path.join(root, "links.json");
  fs.writeFileSync(linksFile, linksJson(links));
  const upFile = path.join(root, "links-up.json");
  const downFile = path.join(root, "links-down.json");
  if (linksUp) fs.writeFileSync(upFile, linksJson(linksUp));
  if (linksDown) fs.writeFileSync(downFile, linksJson(linksDown));

  const config = {
    version: 1,
    defaults,
    local: { tags: ["ios-sim"], maxConcurrent: 2 },
    machines: Object.fromEntries(
      Object.entries(machines).map(([label, m]) => [
        label,
        {
          environmentId: m.env,
          ...(m.kind ? { kind: m.kind } : {}),
          tags: m.tags ?? ["linux"],
          priority: m.priority ?? 10,
          maxConcurrent: 2,
          ...Object.fromEntries((m.hooks ?? []).map((h) => [h, [hook, label, `--${h}`]])),
        },
      ]),
    ),
    repos: {},
  };
  fs.writeFileSync(path.join(dirs.home, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(path.join(dirs.home, "config.json"), 0o600);

  const baseEnv = {
    PATH: `${dirs.bin}:/usr/bin:/bin`,
    HOME: dirs.user,
    T3_BOXES_HOME: dirs.home,
    T3_SWARM_HOME: dirs.swarm,
    FAKE_T3_LINKS: linksFile,
    MARK_DIR: dirs.marks,
    ...(linksUp ? { FAKE_T3_LINKS_UP: upFile } : {}),
    ...(linksDown ? { FAKE_T3_LINKS_DOWN: downFile } : {}),
  };
  const outputs = [];

  function run(args, { stdin, env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: dirs.repo, env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", reject);
      child.on("close", (code) => {
        outputs.push(out, err);
        let json;
        try {
          json = JSON.parse(out);
        } catch {
          return reject(new Error(`Not JSON from ${args.join(" ")} (exit ${code}): ${out} ${err}`));
        }
        resolve({ code, json });
      });
      child.stdin.end(stdin === undefined ? "" : typeof stdin === "string" ? stdin : JSON.stringify(stdin));
    });
  }

  const runs = (label, hookName) => {
    try {
      return fs.readFileSync(path.join(dirs.marks, `${label}.${hookName}.runs`), "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const input = (label, hookName) => JSON.parse(fs.readFileSync(path.join(dirs.marks, `${label}.${hookName}.input.json`), "utf8"));
  const statePath = path.join(dirs.home, "state.json");
  const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const setLinks = (statuses) => fs.writeFileSync(linksFile, linksJson(statuses));
  // Nothing a hook printed or wrote may appear in any router output or in state.
  const assertNoLeak = () => {
    for (const text of [...outputs, fs.readFileSync(statePath, "utf8")]) assert.equal(text.includes(SECRET), false, `leaked: ${text}`);
  };
  return { root, dirs, hook, config, run, runs, input, readState, setLinks, assertNoLeak };
}

const factRecords = (envId) => [
  { tool: "orchestrator_capabilities", args: { environmentId: envId }, pages: [{ providers: [{ providerInstanceId: "claude", canRunChildTask: true }] }] },
  { tool: "t3_project_list", args: { environmentId: envId }, pages: [{ projects: [{ id: `proj-${envId}`, repositoryIdentity: { canonicalKey: REPO } }] }] },
];

async function observe(t, records) {
  const r = await t.run(["observe"], { stdin: records });
  assert.equal(r.code, 0, JSON.stringify(r.json));
}

const entry = (report, label) => (report || []).find((e) => e.label === label);

async function waitFor(pred, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await sleep(25);
  }
  return false;
}

/** Bring an offline on-demand box up for `run` with the given marker, then lease it. Returns the final acquire. */
async function startAndLease(t, label, env, run, { marker }) {
  const first = await t.run(["acquire", "--run", run], { env: { HOOK_RESULT: marker } });
  const rep = entry(first.json.bringUp, label);
  assert.equal(rep?.outcome, "up", JSON.stringify(first.json));
  assert.ok(first.json.needsObservation, "facts from before the hook are expired");
  await observe(t, factRecords(env));
  const second = await t.run(["acquire", "--run", run]);
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.deepEqual(second.json.machines.map((m) => m.label), [label]);
  return { first, second, rep };
}

// ----------------------------------------------------------------------------------------------------------------
// Pure parts

describe("parseStartedMarker", () => {
  test("accepts only a clear yes or no for this box", () => {
    assert.equal(parseStartedMarker("STARTED od-box yes\n", "od-box"), true);
    assert.equal(parseStartedMarker("STARTED od-box no", "od-box"), false);
    assert.equal(parseStartedMarker("warming up\nSTARTED od-box yes\nSTARTED od-box yes\n", "od-box"), true);
    assert.equal(parseStartedMarker('{"started": true}', "od-box"), true);
    assert.equal(parseStartedMarker('{"started": false, "label": "od-box"}', "od-box"), false);
  });
  test("absent, ambiguous, cut short or about another box means unknown", () => {
    for (const text of [
      undefined,
      "",
      "all good",
      "STARTED other-box yes",
      "STARTED od-box yes\nSTARTED od-box no",
      "STARTED od-box maybe",
      "STARTED od-box",
      "STARTED od-box yes extra",
      '{"started": "yes"}',
      '{"started": true, "label": "other-box"}',
      "[true]",
      '{"started": tru',
    ]) {
      assert.equal(parseStartedMarker(text, "od-box"), null, JSON.stringify(text));
    }
    assert.equal(parseStartedMarker("STARTED od-box yes", "od-box", { truncated: true }), null);
  });
});

describe("runHook result file", () => {
  test("is bounded, read only on exit 0, and removed afterwards", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-runhook-"));
    const script = path.join(dir, "h.sh");
    writeExec(script, `#!/bin/sh\ncat > /dev/null\necho "$T3_BOXES_RESULT_FILE" > "${dir}/where"\nhead -c "$N" /dev/zero | tr '\\0' 'a' > "$T3_BOXES_RESULT_FILE"\nexit "$X"\n`);
    const go = async (n, x) => {
      process.env.N = String(n);
      process.env.X = String(x);
      try {
        return await runHook([script], { label: "b" }, 5000, { name: "bringUp", label: "b", resultFile: true });
      } finally {
        delete process.env.N;
        delete process.env.X;
      }
    };
    const small = await go(10, 0);
    assert.equal(small.outcome, "up");
    assert.equal(small.resultText, "a".repeat(10));
    assert.equal(small.resultTruncated, false);
    assert.equal(fs.existsSync(path.dirname(fs.readFileSync(path.join(dir, "where"), "utf8").trim())), false, "private result dir removed");
    const big = await go(RESULT_MAX_BYTES + 100, 0);
    assert.equal(big.resultText.length, RESULT_MAX_BYTES);
    assert.equal(big.resultTruncated, true);
    const failed = await go(10, 3);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.resultText, undefined, "a failed hook's file is never read");
  });
});

test("bringUp stdout is bounded, private and reconciled with the result file", async () => {
  for (const [stdout, file, expected] of [
    ["STARTED od-box yes", "", true],
    ["STARTED od-box no", "", false],
    ['{"started":true}', "", true],
    ["STARTED od-box yes", "STARTED od-box yes", true],
    ["STARTED od-box yes", "STARTED od-box no", null],
    ["STARTED other-box yes", "STARTED od-box yes", null],
    ["STARTED od-box yes", "bad result", null],
    ["STARTED od-box yes\n" + "x".repeat(RESULT_MAX_BYTES), "", null],
  ]) {
    const t = setup({ machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["bringUp"] } }, links: { "env-od": "offline" }, linksUp: { "env-od": "reachable" } });
    const r = await t.run(["acquire", "--run", "r1"], { env: { HOOK_STDOUT: stdout, HOOK_RESULT: file } });
    assert.equal(entry(r.json.bringUp, "od-box")?.started, expected);
    t.assertNoLeak();
  }
  assert.equal(startedFromHookResult({ outcome: "failed", stdoutText: "STARTED b yes" }, "b"), null);
  assert.equal(startedFromHookResult({ outcome: "up", stdoutText: "STARTED b yes", resultTruncated: true }, "b"), null);
});

test("a descendant retaining stdout cannot delay bringUp completion", { timeout: 3000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-stdout-"));
  const script = path.join(dir, "hook.sh");
  writeExec(script, "#!/bin/sh\ncat >/dev/null\nsleep 2 &\nprintf 'STARTED b yes\\n'\n");
  const startedAt = Date.now();
  const result = await runHook([script], { label: "b" }, 5000, { name: "bringUp", label: "b" });
  assert.equal(result.outcome, "up");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(startedFromHookResult(result, "b"), null);
  assert.ok(Date.now() - startedAt < 1500);
});

describe("ownership and release planning", () => {
  const NOW = Date.UTC(2030, 0, 1);
  const later = new Date(NOW + 3_600_000).toISOString();
  const config = {
    version: 1,
    defaults: {},
    local: { tags: [] },
    machines: {
      od: { kind: "on-demand", environmentId: "e-od", tearDown: ["/x"], tags: [], maxConcurrent: 2 },
      aon: { kind: "always-on", environmentId: "e-aon", tags: [], maxConcurrent: 2 },
    },
    repos: {},
  };
  const finished = (run, extra = {}) => ({ id: "c1", environmentId: "e-od", run, startedAt: later, deadline: later, finishedAt: new Date(NOW - 1000).toISOString(), outcome: "up", started: true, ...extra });
  const base = (bringUp, leases) => ({ version: 1, observations: {}, health: {}, slots: {}, leases, bringUp });

  test("adoption needs a confirmed start by the same run, once", () => {
    const leases = { r1: { machines: ["od", "aon"], environments: { od: "e-od", aon: "e-aon" }, expiresAt: later } };
    const own = adoptStarted(base({ od: finished("r1") }, leases), "r1", NOW, config);
    assert.deepEqual(own.adopted, ["od"]);
    assert.deepEqual(own.state.leases.r1.startedByRouter, ["od"]);
    assert.deepEqual(own.state.leases.r1.startedEnvironments, { od: "e-od" });
    assert.ok(own.state.bringUp.od.adoptedAt);
    assert.deepEqual(adoptStarted(own.state, "r1", NOW, config).adopted, [], "adopted once");
    for (const rec of [finished("r2"), finished("r1", { started: false }), finished("r1", { started: undefined }), finished("r1", { outcome: "failed" }), finished("r1", { hook: "tearDown" }), finished("r1", { finishedAt: undefined })]) {
      assert.deepEqual(adoptStarted(base({ od: rec }, leases), "r1", NOW, config).adopted, [], JSON.stringify(rec));
    }
    // Identity: a legacy record (no environmentId), a record for another environment, a lease taken under another
    // environment, or a call without config never adopts.
    for (const rec of [finished("r1", { environmentId: undefined }), finished("r1", { environmentId: "e-other" })]) {
      assert.deepEqual(adoptStarted(base({ od: rec }, leases), "r1", NOW, config).adopted, [], JSON.stringify(rec));
    }
    assert.deepEqual(adoptStarted(base({ od: finished("r1") }, { r1: { machines: ["od"], expiresAt: later } }), "r1", NOW, config).adopted, []);
    assert.deepEqual(adoptStarted(base({ od: finished("r1") }, { r1: { machines: ["od"], environments: { od: "e-x" }, expiresAt: later } }), "r1", NOW, config).adopted, []);
    assert.deepEqual(adoptStarted(base({ od: finished("r1") }, leases), "r1", NOW).adopted, []);
    // The label now names another environment than the one the bring-up started.
    const moved = { ...config, machines: { ...config.machines, od: { ...config.machines.od, environmentId: "e-new" } } };
    const movedLease = { r1: { machines: ["od"], environments: { od: "e-new" }, expiresAt: later } };
    assert.deepEqual(adoptStarted(base({ od: finished("r1") }, movedLease), "r1", NOW, moved).adopted, []);
  });

  test("an engine acquire keeps startedByRouter for boxes it keeps", () => {
    const fresh = (env) => {
      const env1 = (value, ttl) => ({ observedAt: new Date(NOW - 1000).toISOString(), validUntil: new Date(NOW + ttl).toISOString(), value });
      return { environmentId: env, link: env1({ status: "reachable", access: "full-access", expiresAt: FAR }, 600_000), providers: env1(["claude"], 3_600_000), projects: env1({ [REPO]: "p" }, 3_600_000) };
    };
    const state = { ...base({}, { r1: { machines: ["od"], startedByRouter: ["od"], startedEnvironments: { od: "e-od" }, expiresAt: later } }), observations: { od: fresh("e-od") } };
    const out = decide("acquire", { config, state, options: { run: "r1" }, repo: REPO, now: NOW, newId: () => "x" });
    assert.equal(out.result.ok, true, JSON.stringify(out.result));
    assert.deepEqual(out.state.leases.r1.startedByRouter, ["od"]);
    assert.deepEqual(out.state.leases.r1.startedEnvironments, { od: "e-od" });
    assert.deepEqual(out.state.leases.r1.environments, { od: "e-od" });
  });

  test("release plans a tear-down only for an owned box nothing else holds", () => {
    let n = 0;
    const plan = (state, opts = {}) =>
      planRelease({
        config,
        state,
        run: "r1",
        now: NOW,
        decideRelease: (s) => decide("release", { config, state: s, options: { run: "r1" }, now: NOW }),
        makeClaim: () => ({ id: `t${++n}`, run: "r1", startedAt: later, deadline: later }),
        ...opts,
      });
    const owned = { r1: { machines: ["od", "aon"], startedByRouter: ["od"], startedEnvironments: { od: "e-od" }, expiresAt: later } };
    const ok = plan(base({}, owned));
    assert.deepEqual(ok.claimed.map((c) => c.label), ["od"]);
    assert.equal(ok.state.bringUp.od.hook, "tearDown");
    assert.equal(ok.state.bringUp.od.environmentId, "e-od");
    assert.equal(ok.state.leases.r1, undefined);
    assert.deepEqual(ok.result.kept, ["aon", "od"]);

    const blocked = [
      [{ ...base({}, { ...owned, r2: { machines: ["od"], expiresAt: later } }) }, /Still leased to run r2/],
      [{ ...base({}, owned), slots: { s1: { label: "od", run: "r9", expiresAt: later } } }, /live slot/],
      [base({ od: { id: "b", hook: "bringUp", startedAt: later, deadline: later } }, owned), /bringUp hook is running/],
      [{ ...base({}, owned), lifecycle: { keepAlive: { od: { id: "k", deadline: later } } } }, /keepAlive hook is running/],
      [base({}, { r1: { machines: ["od"], expiresAt: later } }), /Not started by the router/],
      // Identity: a legacy ownership record (label only) or one bound to another environment fails closed.
      [base({}, { r1: { machines: ["od"], startedByRouter: ["od"], expiresAt: later } }), /names no environment/],
      [base({}, { r1: { machines: ["od"], startedByRouter: ["od"], startedEnvironments: { od: "e-before" }, expiresAt: later } }), /different environment/],
      // Quietness by environment: another run's lease, a hook claim or a keep-alive under another label naming e-od.
      [base({}, { ...owned, r2: { machines: ["x"], environments: { x: "e-od" }, expiresAt: later } }), /Still leased to run r2/],
      [base({ x: { id: "b", hook: "bringUp", environmentId: "e-od", startedAt: later, deadline: later } }, owned), /bringUp hook is running/],
      [{ ...base({}, owned), lifecycle: { keepAlive: { x: { id: "k", environmentId: "e-od", deadline: later } } } }, /keepAlive hook is running/],
    ];
    for (const [state, why] of blocked) {
      const p = plan(state);
      assert.equal(p.claimed.length, 0, String(why));
      assert.match(entry(p.result.tearDown, "od").detail, why);
    }
    assert.match(entry(plan(base({}, owned), { keep: true }).result.tearDown, "od").detail, /--keep/);
    assert.match(entry(plan(base({}, owned), { unusable: new Map([["od", "tearDown[0] /x is missing or not executable."]]) }).result.tearDown, "od").detail, /not executable/);

    // A slot booked on e-od under a label since removed from config survives pruning and still blocks.
    const orphan = { ...base({}, structuredClone(owned)), slots: { s1: { label: "gone", environmentId: "e-od", run: "r9", expiresAt: later }, s2: { label: "gone2", run: "r9", expiresAt: later } } };
    pruneState(config, orphan, NOW);
    assert.deepEqual(Object.keys(orphan.slots), ["s1"], "a legacy orphan slot is pruned; one naming its environment is kept");
    const orphanPlan = plan(orphan);
    assert.equal(orphanPlan.claimed.length, 0);
    assert.match(entry(orphanPlan.result.tearDown, "od").detail, /1 live slot/);
    // So does another run's lease on e-od under a removed label: pruning empties its machines, not its environments.
    const goneLease = base({}, { ...structuredClone(owned), r2: { machines: ["gone"], environments: { gone: "e-od" }, expiresAt: later } });
    pruneState(config, goneLease, NOW);
    assert.deepEqual(goneLease.leases.r2.machines, []);
    assert.match(entry(plan(goneLease).result.tearDown, "od").detail, /Still leased to run r2/);
    // A slot under the same label but naming another environment still blocks: the label match is kept, conservatively.
    const sameLabel = plan({ ...base({}, owned), slots: { s1: { label: "od", environmentId: "e-old", run: "r9", expiresAt: later } } });
    assert.equal(sameLabel.claimed.length, 0);

    const alwaysOn = plan(base({}, { r1: { machines: ["aon"], expiresAt: later } }));
    assert.deepEqual(alwaysOn.result, { ok: true, run: "r1", stopped: [], kept: ["aon"] }, "always-on release keeps its shape");
  });

  test("a transfer hook runs only for the environment the slot was booked on", () => {
    const cfg = { machines: { od: { environmentId: "e-od", handoff: ["/x"] } } };
    const slot = (extra) => ({ state: { slots: { s1: { label: "od", expiresAt: later, ...extra } } } });
    assert.equal(transferTarget(cfg, slot({ environmentId: "e-od" }).state, "s1", "handoff", NOW).error, undefined);
    assert.match(transferTarget(cfg, slot({ environmentId: "e-before" }).state, "s1", "handoff", NOW).error, /another environment/);
    assert.match(transferTarget(cfg, slot({}).state, "s1", "handoff", NOW).error, /names no environment/);
  });

  test("placement metadata names commands, never hook argv", () => {
    const cfg = { machines: { b: { handoff: ["/secret/path/sync.sh", "--token=x"], fetch: ["/y"] } } };
    const info = transferInfo(cfg, "b", "slot1");
    assert.equal(info.handoff, true);
    assert.equal(info.fetch, true);
    assert.equal(JSON.stringify(info).includes("/secret/path"), false);
    const placed = annotatePlacement(cfg, { ok: true, placement: { label: "b", remote: true, slot: { id: "slot1" } } });
    assert.match(placed.placement.transfer.commands[0], /handoff --slot slot1/);
    assert.equal(annotatePlacement(cfg, { ok: true, placement: { label: "local", remote: false, slot: { id: "s" } } }).placement.transfer, undefined);
  });

  test("store accepts the lifecycle kinds and hooks", () => {
    const v = validateConfig({
      version: 1,
      machines: {
        od: { kind: "on-demand", environmentId: "e1", bringUp: ["/u"], tearDown: ["/d"], keepAlive: ["/k"], handoff: ["/h"], fetch: ["/f"], hookTimeoutMs: 5000 },
        eph: { kind: "ephemeral", environmentId: "e2", bringUp: ["/u"] },
      },
    });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(v.config.machines.od.kind, "on-demand");
    assert.deepEqual(v.config.machines.od.tearDown, ["/d"]);
    assert.equal(v.config.machines.od.hookTimeoutMs, 5000);
    assert.equal(v.config.machines.eph.kind, "ephemeral");
    const noUp = validateConfig({ version: 1, machines: { od: { kind: "on-demand", environmentId: "e1" } } });
    assert.ok(noUp.warnings.some((w) => /without a bringUp hook/.test(w)));
  });
});

// ----------------------------------------------------------------------------------------------------------------
// End to end

test("a confirmed start makes the box the run's; release stops it once and expires its facts", async () => {
  const t = setup({
    machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["bringUp", "tearDown"] } },
    links: { "env-od": "offline" },
    linksUp: { "env-od": "reachable" },
    linksDown: { "env-od": "offline" },
  });
  await observe(t, factRecords("env-od"));
  // The JSON form, with an extra field that must not be stored or shown.
  const { rep, second } = await startAndLease(t, "od-box", "env-od", "r1", { marker: JSON.stringify({ started: true, token: SECRET }) });
  assert.equal(rep.started, true);
  assert.deepEqual(second.json.startedByRouter, ["od-box"]);
  assert.equal(t.input("od-box", "bringUp").kind, "on-demand");
  assert.match(fs.readFileSync(path.join(t.dirs.marks, "od-box.bringUp.env"), "utf8"), /T3_BOXES_RESULT_FILE=/);

  const list = (await t.run(["list"])).json;
  assert.deepEqual(list.leases.find((l) => l.run === "r1").startedByRouter, ["od-box"]);
  const shown = list.machines.find((m) => m.label === "od-box");
  assert.equal(shown.kind, "on-demand");
  assert.equal(shown.state, "ready");

  const rel = await t.run(["release", "--run", "r1"]);
  assert.equal(rel.code, 0, JSON.stringify(rel.json));
  assert.deepEqual(rel.json.stopped, ["od-box"]);
  assert.deepEqual(rel.json.kept, []);
  const td = entry(rel.json.tearDown, "od-box");
  assert.equal(td.outcome, "stopped");
  assert.equal(td.exitCode, 0);
  assert.equal(t.runs("od-box", "tearDown"), 1);
  const input = t.input("od-box", "tearDown");
  assert.equal(input.hook, "tearDown");
  assert.equal(input.run, "r1");
  assert.equal(input.requireIdleCheck, true);
  assert.equal(t.readState().bringUp["od-box"].outcome, "stopped");
  assert.ok(t.readState().bringUp["od-box"].invalidatedAt, "facts from before the tear-down are expired");
  const after = t.readState();
  const providers = after.observations["od-box"]?.providers;
  assert.ok(!providers || Date.parse(providers.validUntil) <= Date.parse(after.bringUp["od-box"].finishedAt), JSON.stringify(providers));
  // The tear-down left the link offline; the box is not placeable on its old facts.
  assert.equal((await t.run(["list"])).json.machines.find((m) => m.label === "od-box").state, "cooling");
  assert.equal((await t.run(["place", "--place", "od-box"])).code, 1);

  const again = await t.run(["release", "--run", "r1"]);
  assert.deepEqual(again.json, { ok: true, run: "r1", stopped: [], kept: [] });
  assert.equal(t.runs("od-box", "tearDown"), 1);

  // A stopped box can be brought up again at once: the retry window throttles bring-ups, not tear-downs.
  await observe(t, factRecords("env-od"));
  const back = await t.run(["acquire", "--run", "r2"], { env: { HOOK_RESULT: "STARTED od-box yes" } });
  assert.equal(entry(back.json.bringUp, "od-box")?.outcome, "up", JSON.stringify(back.json));
  assert.equal(t.runs("od-box", "bringUp"), 2);
  t.assertNoLeak();
});

test("no marker, a no, a wrong label or a failed hook never make the box the run's", async () => {
  for (const [marker, upExit, label] of [
    [undefined, 0, "none"],
    ["STARTED od-box no", 0, "no"],
    ["STARTED other-box yes", 0, "wrong label"],
    ["STARTED od-box yes\nSTARTED od-box no", 0, "conflict"],
    ["STARTED od-box yes", 3, "failed hook"],
  ]) {
    const t = setup({
      machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["bringUp", "tearDown"] } },
      links: { "env-od": "offline" },
      linksUp: { "env-od": "reachable" },
    });
    await observe(t, factRecords("env-od"));
    const first = await t.run(["acquire", "--run", "r1"], { env: { ...(marker ? { HOOK_RESULT: marker } : {}), UP_EXIT: String(upExit) } });
    const rep = entry(first.json.bringUp, "od-box");
    assert.ok(rep, label);
    if (upExit === 0) assert.equal(rep.started, marker === "STARTED od-box no" ? false : null, label);
    else {
      assert.equal(rep.outcome, "failed", label);
      assert.equal(rep.started, null, label);
      t.setLinks({ "env-od": "reachable" });
    }
    await observe(t, factRecords("env-od"));
    const second = await t.run(["acquire", "--run", "r1"]);
    assert.equal(second.code, 0, `${label}: ${JSON.stringify(second.json)}`);
    assert.equal(second.json.startedByRouter, undefined, label);
    const rel = await t.run(["release", "--run", "r1"]);
    assert.deepEqual(rel.json.stopped, [], label);
    assert.deepEqual(rel.json.kept, ["od-box"], label);
    assert.match(entry(rel.json.tearDown, "od-box").detail, /Not started by the router/, label);
    assert.equal(t.runs("od-box", "tearDown"), 0, label);
    t.assertNoLeak();
  }
});

test("another run's lease, a live slot, --keep and a busy idle check each keep the box running", async () => {
  const t = setup({
    machines: { "od-box": { env: "env-od", kind: "ephemeral", hooks: ["bringUp", "tearDown"] } },
    links: { "env-od": "offline" },
    linksUp: { "env-od": "reachable" },
  });
  await observe(t, factRecords("env-od"));
  await startAndLease(t, "od-box", "env-od", "r1", { marker: "STARTED od-box yes" });

  // Another run holds it.
  assert.equal((await t.run(["acquire", "--run", "r2"])).code, 0);
  const shared = await t.run(["release", "--run", "r1"]);
  assert.deepEqual(shared.json.kept, ["od-box"]);
  assert.match(entry(shared.json.tearDown, "od-box").detail, /Still leased to run r2/);
  // r2 never owned it, so its release leaves it running too.
  const r2 = await t.run(["release", "--run", "r2"]);
  assert.match(entry(r2.json.tearDown, "od-box").detail, /Not started by the router/);
  assert.equal(t.runs("od-box", "tearDown"), 0);

  // A fresh owned lease with a live slot from any run.
  const t2 = setup({
    machines: { "od-box": { env: "env-od", kind: "ephemeral", hooks: ["bringUp", "tearDown"] } },
    links: { "env-od": "offline" },
    linksUp: { "env-od": "reachable" },
  });
  await observe(t2, factRecords("env-od"));
  await startAndLease(t2, "od-box", "env-od", "r1", { marker: "STARTED od-box yes" });
  const placed = await t2.run(["place", "--run", "r1", "--place", "od-box"]);
  assert.equal(placed.code, 0, JSON.stringify(placed.json));
  const withSlot = await t2.run(["release", "--run", "r1"]);
  assert.match(entry(withSlot.json.tearDown, "od-box").detail, /1 live slot/);
  assert.equal(t2.runs("od-box", "tearDown"), 0);

  // --keep, then a hook whose idle check refuses (exit 75): kept, facts untouched.
  for (const [args, env, why] of [
    [["--keep"], {}, /--keep/],
    [[], { DOWN_EXIT: "75" }, null],
  ]) {
    const t3 = setup({
      machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["bringUp", "tearDown"] } },
      links: { "env-od": "offline" },
      linksUp: { "env-od": "reachable" },
    });
    await observe(t3, factRecords("env-od"));
    await startAndLease(t3, "od-box", "env-od", "r1", { marker: "STARTED od-box yes" });
    const rel = await t3.run(["release", "--run", "r1", ...args], { env });
    assert.deepEqual(rel.json.kept, ["od-box"]);
    assert.deepEqual(rel.json.stopped, []);
    if (why) {
      assert.match(entry(rel.json.tearDown, "od-box").detail, why);
      assert.equal(t3.runs("od-box", "tearDown"), 0);
    } else {
      assert.equal(entry(rel.json.tearDown, "od-box").outcome, "refused-busy");
      assert.equal(t3.runs("od-box", "tearDown"), 1);
      assert.ok(t3.readState().observations["od-box"].providers, "a refused tear-down expires nothing");
    }
    t3.assertNoLeak();
  }
  t.assertNoLeak();
  t2.assertNoLeak();
});

test("while a tear-down runs, place, acquire and a second release cannot use or stop the box", { timeout: 30_000 }, async () => {
  const t = setup({
    machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["bringUp", "tearDown"] } },
    links: { "env-od": "offline" },
    linksUp: { "env-od": "reachable" },
    linksDown: { "env-od": "offline" },
  });
  await observe(t, factRecords("env-od"));
  await startAndLease(t, "od-box", "env-od", "r1", { marker: "STARTED od-box yes" });
  const gate = path.join(t.root, "down-gate");
  const rel = t.run(["release", "--run", "r1"], { env: { DOWN_GATE: gate } });
  assert.ok(await waitFor(() => t.runs("od-box", "tearDown") === 1), "tear-down started");

  // The box looks reachable to agents mid-tear-down; that must not make it usable.
  await observe(t, factRecords("env-od"));
  const [place, acquire, release2, list] = await Promise.all([
    t.run(["place", "--place", "od-box"]),
    t.run(["acquire", "--run", "r9"]),
    t.run(["release", "--run", "r1"]),
    t.run(["list"]),
  ]);
  assert.equal(place.code, 1);
  assert.match(place.json.skipped.find((s) => s.label === "od-box").reason, /Tear-down hook running/);
  assert.equal(acquire.code, 1, JSON.stringify(acquire.json));
  assert.ok(acquire.json.errors.some((e) => /Tear-down hook running/.test(e)), JSON.stringify(acquire.json));
  assert.equal(entry(acquire.json.bringUp, "od-box")?.outcome, "in-progress");
  assert.deepEqual(release2.json, { ok: true, run: "r1", stopped: [], kept: [] });
  const shown = list.json.machines.find((m) => m.label === "od-box");
  assert.equal(shown.bringUp.running, true);
  assert.equal(shown.bringUp.hook, "tearDown");
  assert.equal(t.runs("od-box", "bringUp"), 1, "no bring-up during the tear-down");

  fs.writeFileSync(gate, "");
  const done = await rel;
  assert.deepEqual(done.json.stopped, ["od-box"]);
  assert.equal(t.runs("od-box", "tearDown"), 1);
  assert.equal(Object.keys(t.readState().slots).length, 0);
  t.assertNoLeak();
});

test("a short acquire brings up an on-demand box before an ephemeral one, whatever their priorities", async () => {
  const t = setup({
    machines: {
      "eph-box": { env: "env-eph", kind: "ephemeral", priority: 99, hooks: ["bringUp"] },
      "od-box": { env: "env-od", kind: "on-demand", priority: 1, hooks: ["bringUp"] },
    },
    links: { "env-eph": "offline", "env-od": "offline" },
  });
  await observe(t, [...factRecords("env-eph"), ...factRecords("env-od")]);
  const r = await t.run(["acquire", "--run", "r1", "--count", "1"]);
  assert.equal(entry(r.json.bringUp, "od-box")?.outcome, "up", JSON.stringify(r.json));
  assert.equal(t.runs("od-box", "bringUp"), 1);
  assert.equal(t.runs("eph-box", "bringUp"), 0);
});

test("a FIFO in place of the result file does not block the router", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-fifo-"));
  const script = path.join(dir, "h.sh");
  writeExec(script, `#!/bin/sh\ncat > /dev/null\nrm -f "$T3_BOXES_RESULT_FILE"\nmkfifo "$T3_BOXES_RESULT_FILE"\nexit 0\n`);
  const started = Date.now();
  const r = await runHook([script], { label: "b" }, 5000, { name: "bringUp", label: "b", resultFile: true });
  assert.equal(r.outcome, "up");
  assert.equal(r.resultText, undefined);
  assert.ok(Date.now() - started < 5000, "returned without waiting on the FIFO");
});

test("an always-on box in a lease is only ever kept, with the release shape unchanged", async () => {
  const t = setup({ machines: { "home-box": { env: "env-home", hooks: ["keepAlive"] } }, links: { "env-home": "reachable" } });
  await observe(t, factRecords("env-home"));
  assert.equal((await t.run(["acquire", "--run", "r1"])).code, 0);
  const rel = await t.run(["release", "--run", "r1"]);
  assert.deepEqual(rel.json, { ok: true, run: "r1", stopped: [], kept: ["home-box"] });
});

test("keep-alive renews the lease and runs each leased box's hook; without a lease it fails", async () => {
  const t = setup({
    machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["keepAlive"] }, "plain-box": { env: "env-plain" } },
    links: { "env-od": "reachable", "env-plain": "reachable" },
  });
  await observe(t, [...factRecords("env-od"), ...factRecords("env-plain")]);
  const none = await t.run(["keep-alive", "--run", "r1"]);
  assert.equal(none.code, 1);
  assert.match(none.json.error, /No active lease/);
  assert.equal(t.runs("od-box", "keepAlive"), 0);

  assert.equal((await t.run(["acquire", "--run", "r1", "--count", "2"])).code, 0);
  const before = t.readState().leases.r1.expiresAt;
  await sleep(20);
  const r = await t.run(["keep-alive", "--run", "r1"]);
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.ok(Date.parse(r.json.expiresAt) > Date.parse(before));
  assert.equal(t.readState().leases.r1.expiresAt, r.json.expiresAt);
  assert.deepEqual(r.json.keepAlive.map((k) => [k.label, k.outcome]), [["od-box", "ok"]]);
  assert.equal(t.runs("od-box", "keepAlive"), 1);
  const input = t.input("od-box", "keepAlive");
  assert.equal(input.run, "r1");
  assert.equal(input.kind, "on-demand");
  assert.equal(t.readState().lifecycle, undefined, "the keep-alive claim is lifted");

  const failing = await t.run(["keep-alive", "--run", "r1"], { env: { HOOK_EXIT: "4" } });
  assert.equal(failing.code, 0);
  assert.equal(entry(failing.json.keepAlive, "od-box").outcome, "failed");
  assert.equal(entry(failing.json.keepAlive, "od-box").exitCode, 4);
  t.assertNoLeak();
});

test("handoff and fetch run the user's hooks for a live slot, with metadata in place", async () => {
  const t = setup({
    machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["handoff"] }, "plain-box": { env: "env-plain", priority: 1 } },
    links: { "env-od": "reachable", "env-plain": "reachable" },
  });
  await observe(t, [...factRecords("env-od"), ...factRecords("env-plain")]);
  const placed = await t.run(["place", "--place", "od-box", "--base", "main", "--branch", "w1"]);
  assert.equal(placed.code, 0, JSON.stringify(placed.json));
  const transfer = placed.json.placement.transfer;
  assert.equal(transfer.mode, "user-hook");
  assert.equal(transfer.handoff, true);
  assert.equal(transfer.fetch, false);
  assert.equal(JSON.stringify(placed.json).includes(t.hook), false, "no hook path in the placement");
  const slot = placed.json.placement.slot.id;

  const h = await t.run(["handoff", "--slot", slot, "--base", "main", "--branch", "w1"]);
  assert.equal(h.code, 0, JSON.stringify(h.json));
  assert.equal(h.json.outcome, "ok");
  const input = t.input("od-box", "handoff");
  assert.equal(input.slot, slot);
  assert.equal(input.label, "od-box");
  assert.equal(input.branch, "w1");
  assert.equal(input.base, "main");
  assert.equal(input.repo, REPO);
  assert.equal(fs.realpathSync(input.cwd), fs.realpathSync(t.dirs.repo));

  const noFetch = await t.run(["fetch", "--slot", slot]);
  assert.equal(noFetch.code, 1);
  assert.match(noFetch.json.error, /no fetch hook/);
  const failed = await t.run(["handoff", "--slot", slot], { env: { HOOK_EXIT: "9" } });
  assert.equal(failed.code, 1);
  assert.equal(failed.json.outcome, "failed");
  assert.equal(failed.json.exitCode, 9);

  const plain = await t.run(["place", "--place", "plain-box"]);
  assert.equal(plain.json.placement.transfer, undefined);
  assert.equal((await t.run(["done", "--slot", slot, "--outcome", "ok"])).code, 0);
  const dead = await t.run(["handoff", "--slot", slot]);
  assert.equal(dead.code, 1);
  assert.match(dead.json.error, /not live/);
  assert.equal(t.runs("od-box", "handoff"), 2);
  t.assertNoLeak();
});

test("a label reassigned in config never lets release or a transfer hook act on another environment", async () => {
  const t = setup({
    machines: {
      "od-a": { env: "env-a", kind: "on-demand", hooks: ["bringUp", "tearDown", "handoff", "keepAlive"], tags: ["linux", "gpu"] },
      "od-b": { env: "env-b", kind: "on-demand", hooks: ["bringUp", "tearDown", "handoff"] },
    },
    links: { "env-a": "offline", "env-b": "reachable" },
    linksUp: { "env-a": "reachable", "env-b": "reachable" },
    linksDown: { "env-a": "offline", "env-b": "reachable" },
  });
  await observe(t, [...factRecords("env-a"), ...factRecords("env-b")]);
  // r1 needs gpu, which only od-a has, so its bring-up starts od-a (env-a); od-b stays free for a slot.
  const first = await t.run(["acquire", "--run", "r1", "--needs", "gpu"], { env: { HOOK_RESULT: "STARTED od-a yes" } });
  assert.equal(entry(first.json.bringUp, "od-a")?.outcome, "up", JSON.stringify(first.json));
  await observe(t, factRecords("env-a"));
  const second = await t.run(["acquire", "--run", "r1", "--needs", "gpu"]);
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.deepEqual(second.json.startedByRouter, ["od-a"]);
  const lease = t.readState().leases.r1;
  assert.deepEqual(lease.startedEnvironments, { "od-a": "env-a" });
  assert.equal(t.readState().bringUp["od-a"].environmentId, "env-a");

  const placed = await t.run(["place", "--place", "od-b"]);
  assert.equal(placed.code, 0, JSON.stringify(placed.json));
  const slot = placed.json.placement.slot.id;
  assert.equal(t.readState().slots[slot].environmentId, "env-b");

  // Synthetic config change: the two labels swap environments.
  const swapped = structuredClone(t.config);
  swapped.machines["od-a"].environmentId = "env-b";
  swapped.machines["od-b"].environmentId = "env-a";
  const configPath = path.join(t.dirs.home, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(swapped, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);

  // The slot was booked on env-b; od-b now names env-a, so its handoff hook must not run.
  const h = await t.run(["handoff", "--slot", slot]);
  assert.equal(h.code, 1, JSON.stringify(h.json));
  assert.match(h.json.error, /another environment/);
  assert.equal(t.runs("od-b", "handoff"), 0);

  const ping = await t.run(["keep-alive", "--run", "r1"]);
  assert.equal(entry(ping.json.keepAlive, "od-a").outcome, "skipped");
  assert.equal(t.runs("od-a", "keepAlive"), 0);

  // r1 started env-a under od-a; od-a now names env-b. Release must stop nothing.
  const rel = await t.run(["release", "--run", "r1"]);
  assert.equal(rel.code, 0, JSON.stringify(rel.json));
  assert.deepEqual(rel.json.stopped, []);
  assert.match(entry(rel.json.tearDown, "od-a").detail, /different environment/);
  assert.equal(t.runs("od-a", "tearDown"), 0);
  assert.equal(t.runs("od-b", "tearDown"), 0);
  t.assertNoLeak();
});

test("doctor reports lifecycle kinds and hook problems", async () => {
  const t = setup({ machines: { "od-box": { env: "env-od", kind: "on-demand", hooks: ["bringUp", "tearDown", "fetch"] } }, links: { "env-od": "reachable" } });
  const cfgPath = path.join(t.dirs.home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.machines["od-box"].fetch = [path.join(t.dirs.hooks, "missing.sh")];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const doctor = (await t.run(["doctor"])).json;
  const lc = doctor.router.lifecycle.find((e) => e.label === "od-box");
  assert.equal(lc.kind, "on-demand");
  assert.equal(lc.hooks.tearDown.ok, true);
  assert.equal(lc.hooks.fetch.ok, false);
  assert.match(lc.hooks.fetch.problem, /^fetch\[0\] .* missing or not executable/);
});
