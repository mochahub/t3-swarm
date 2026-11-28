// Black-box tests for the acquire-time bringUp hook. Every run uses a private router home, swarm home, HOME and
// git checkout, a PATH holding only a fake `t3` plus /usr/bin and /bin, and local shell hooks. Nothing here
// reaches a real T3, the network or another machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/t3-box-router/scripts/box-router.mjs");
const REPO = "github.com/o/r";
const FAR = "2099-01-01T00:00:00.000Z";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_T3 = `#!/bin/sh
[ "$1 $2 $3" = "environment list --json" ] || exit 2
cat "$FAKE_T3_LINKS"
`;

// Appends a run marker, saves its stdin and argv, optionally waits for a gate file (at most 20 s), optionally
// fixes the box, then exits.
const UP_HOOK = `#!/bin/sh
label="$1"
echo run >> "$MARK_DIR/$label.runs"
cat > "$MARK_DIR/$label.input.json"
: > "$MARK_DIR/$label.args"
for a in "$@"; do printf '%s\\n' "$a" >> "$MARK_DIR/$label.args"; done
if [ -n "$HOOK_GATE" ]; then i=0; while [ ! -e "$HOOK_GATE" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; fi
if [ -n "$FAKE_T3_LINKS_AFTER" ]; then cp "$FAKE_T3_LINKS_AFTER" "$FAKE_T3_LINKS"; fi
exit "\${HOOK_EXIT:-0}"
`;

// Ignores SIGTERM and leaves a grandchild in its process group, so only the group SIGKILL stops it.
const STUCK_HOOK = `#!/bin/sh
trap '' TERM
echo $$ > "$MARK_DIR/hook.pid"
sleep 60 &
echo $! > "$MARK_DIR/grandchild.pid"
echo run >> "$MARK_DIR/$1.runs"
cat > /dev/null
sleep 60
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

/** A sealed router environment. machines: { label: { env, hook?: "up"|"stuck"|path|null, timeoutMs?, tags? } } */
function setup({ machines, defaults = {}, links = {}, linksAfter = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-bringup-"));
  const dirs = Object.fromEntries(["home", "swarm", "user", "bin", "hooks", "marks", "repo"].map((d) => [d, path.join(root, d)]));
  for (const [name, d] of Object.entries(dirs)) fs.mkdirSync(d, { recursive: true, mode: name === "home" ? 0o700 : 0o755 });
  fs.chmodSync(dirs.home, 0o700);
  writeExec(path.join(dirs.bin, "t3"), FAKE_T3);
  writeExec(path.join(dirs.hooks, "up.sh"), UP_HOOK);
  writeExec(path.join(dirs.hooks, "stuck.sh"), STUCK_HOOK);
  fs.writeFileSync(path.join(dirs.hooks, "not-executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  execFileSync("git", ["init", "-q"], { cwd: dirs.repo, env: { PATH: "/usr/bin:/bin", HOME: dirs.user } });
  execFileSync("git", ["remote", "add", "origin", `git@${REPO.replace("/", ":")}.git`], { cwd: dirs.repo, env: { PATH: "/usr/bin:/bin", HOME: dirs.user } });

  const linksFile = path.join(root, "links.json");
  const linksAfterFile = path.join(root, "links-after.json");
  fs.writeFileSync(linksFile, linksJson(links));
  if (linksAfter) fs.writeFileSync(linksAfterFile, linksJson(linksAfter));

  const hookPath = (h) => (h === "up" ? path.join(dirs.hooks, "up.sh") : h === "stuck" ? path.join(dirs.hooks, "stuck.sh") : h);
  const config = {
    version: 1,
    defaults,
    local: { tags: ["ios-sim"], maxConcurrent: 2 },
    machines: Object.fromEntries(
      Object.entries(machines).map(([label, m]) => [
        label,
        {
          environmentId: m.env,
          tags: m.tags ?? ["linux"],
          priority: m.priority ?? 10,
          maxConcurrent: 2,
          ...(m.hook ? { bringUp: [hookPath(m.hook), label, "two words", "--flag=x"] } : {}),
          ...(m.timeoutMs ? { bringUpTimeoutMs: m.timeoutMs } : {}),
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
    ...(linksAfter ? { FAKE_T3_LINKS_AFTER: linksAfterFile } : {}),
  };

  function run(args, { stdin, env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: dirs.repo, env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", reject);
      child.on("close", (code) => {
        let json;
        try {
          json = JSON.parse(out);
        } catch {
          return reject(new Error(`Not JSON from ${args.join(" ")} (exit ${code}): ${out} ${err}`));
        }
        resolve({ code, json, ms: Date.now() - started });
      });
      child.stdin.end(stdin === undefined ? "" : typeof stdin === "string" ? stdin : JSON.stringify(stdin));
    });
  }

  const runs = (label) => {
    try {
      return fs.readFileSync(path.join(dirs.marks, `${label}.runs`), "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const readState = () => JSON.parse(fs.readFileSync(path.join(dirs.home, "state.json"), "utf8"));
  const writeState = (state) => fs.writeFileSync(path.join(dirs.home, "state.json"), JSON.stringify(state), { mode: 0o600 });
  const setLinks = (statuses) => fs.writeFileSync(linksFile, linksJson(statuses));
  return { root, dirs, config, run, runs, readState, writeState, setLinks, hookPath };
}

const factRecords = (envId) => [
  { tool: "orchestrator_capabilities", args: { environmentId: envId }, pages: [{ providers: [{ providerInstanceId: "claude", canRunChildTask: true }] }] },
  { tool: "t3_project_list", args: { environmentId: envId }, pages: [{ projects: [{ id: "proj-1", repositoryIdentity: { canonicalKey: REPO } }] }] },
];
const linkRecord = (statuses) => ({ tool: "t3_environment_links", args: {}, pages: [{ links: JSON.parse(linksJson(statuses)) }] });

async function observe(t, records) {
  const r = await t.run(["observe"], { stdin: records });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  return r.json;
}

const entry = (report, label) => (report || []).find((e) => e.label === label);
const listed = async (t, label) => (await t.run(["list"])).json.machines.find((m) => m.label === label);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await sleep(25);
  }
  return false;
}

// ----------------------------------------------------------------------------------------------------------------

test("a fresh down link runs the hook once, with its exact argv and JSON input, then demands fresh facts", async () => {
  const t = setup({ machines: { "home-box": { env: "env-home", hook: "up" } }, links: { "env-home": "offline" }, linksAfter: { "env-home": "reachable" } });
  await observe(t, factRecords("env-home"));

  const first = await t.run(["acquire", "--run", "r1"]);
  assert.equal(t.runs("home-box"), 1);
  const rep = entry(first.json.bringUp, "home-box");
  assert.equal(rep.outcome, "up", JSON.stringify(first.json));
  assert.equal(rep.exitCode, 0);
  assert.ok(rep.startedAt && rep.finishedAt && rep.timeoutMs === 120_000, JSON.stringify(rep));

  // The argument vector reaches the hook unchanged, without a shell.
  assert.deepEqual(fs.readFileSync(path.join(t.dirs.marks, "home-box.args"), "utf8").split("\n").filter(Boolean), ["home-box", "two words", "--flag=x"]);
  const input = JSON.parse(fs.readFileSync(path.join(t.dirs.marks, "home-box.input.json"), "utf8"));
  assert.equal(input.hook, "bringUp");
  assert.equal(input.label, "home-box");
  assert.equal(input.environmentId, "env-home");
  assert.equal(input.run, "r1");
  assert.equal(input.requireIdleCheck, true);
  assert.equal(input.routerActiveSlots, 0);

  // Provider and project facts from before the hook were expired; the re-read link is reachable now.
  assert.equal(first.code, 1);
  assert.ok(first.json.needsObservation, JSON.stringify(first.json));
  const pending = first.json.pending.find((p) => p.label === "home-box");
  assert.deepEqual(pending.missing.sort(), ["projects", "providers"]);
  assert.equal(first.json.needsObservation.calls.some((c) => c.tool === "t3_environment_links"), false, "the link was re-read after the hook");

  const shown = await listed(t, "home-box");
  assert.equal(shown.state, "unknown");
  assert.equal(shown.bringUp.running, false);
  assert.equal(shown.bringUp.outcome, "up");
  assert.ok(shown.bringUp.retryAfter);

  await observe(t, factRecords("env-home"));
  const second = await t.run(["acquire", "--run", "r1"]);
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.deepEqual(second.json.machines.map((m) => m.label), ["home-box"]);
  assert.equal(second.json.bringUp, undefined);
  assert.equal(t.runs("home-box"), 1);
});

test("a missing link, an unknown status and a stale link never run a hook; acquire, list and doctor agree", async () => {
  const t = setup({
    machines: {
      "gone-box": { env: "env-gone", hook: "up" },
      "odd-box": { env: "env-odd", hook: "up" },
    },
    links: { "env-odd": null },
  });
  await observe(t, [...factRecords("env-gone"), ...factRecords("env-odd")]);
  const r = await t.run(["acquire", "--run", "r1", "--count", "2"]);
  assert.equal(r.code, 1);
  assert.equal(t.runs("gone-box") + t.runs("odd-box"), 0);
  assert.match(entry(r.json.bringUp, "gone-box").detail, /missing or expired.*cannot relink/);
  assert.equal(entry(r.json.bringUp, "gone-box").outcome, "skipped");
  assert.match(entry(r.json.bringUp, "odd-box").detail, /recognized down status/);
  assert.ok(r.json.errors.some((e) => /^gone-box: Link is missing or expired/.test(e)), JSON.stringify(r.json.errors));

  // facts stored the missing link as value null; every reader calls it unlinked.
  assert.equal(t.readState().observations["gone-box"].link.value, null);
  assert.equal((await listed(t, "gone-box")).state, "unlinked");
  const doctor = (await t.run(["doctor"])).json;
  assert.equal(doctor.machines.find((m) => m.label === "gone-box").state, "unlinked");
  const place = (await t.run(["place", "--place", "gone-box"])).json;
  assert.match(place.skipped.find((s) => s.label === "gone-box").reason, /missing or expired/);

  // No fresh link evidence (the t3 CLI is gone and the cached read lapsed): reported, not acted on.
  const state = t.readState();
  for (const label of ["gone-box", "odd-box"]) delete state.observations[label].link;
  t.writeState(state);
  fs.rmSync(path.join(t.dirs.bin, "t3"));
  const stale = await t.run(["acquire", "--run", "r1", "--count", "2"]);
  assert.ok(stale.json.needsObservation, JSON.stringify(stale.json));
  assert.equal(stale.json.bringUp, undefined);
  assert.equal(t.runs("gone-box") + t.runs("odd-box"), 0);
});

test("held slots and cooldown block the hook", async () => {
  const t = setup({ machines: { "home-box": { env: "env-home", hook: "up" } }, links: { "env-home": "reachable" } });
  await observe(t, factRecords("env-home"));
  assert.equal((await t.run(["acquire", "--run", "r0"])).code, 0);
  const placed = await t.run(["place", "--run", "r0", "--place", "home-box"]);
  assert.equal(placed.code, 0, JSON.stringify(placed.json));
  const slot = placed.json.placement.slot.id;

  await observe(t, [linkRecord({ "env-home": "offline" })]);
  const busy = await t.run(["acquire", "--run", "r1"]);
  assert.match(entry(busy.json.bringUp, "home-box").detail, /1 router slot\(s\) held/);
  assert.equal(t.runs("home-box"), 0);

  assert.equal((await t.run(["done", "--slot", slot, "--outcome", "ok"])).code, 0);
  assert.equal((await t.run(["cooldown", "home-box", "30m"])).code, 0);
  const cooling = await t.run(["acquire", "--run", "r1"]);
  assert.match(entry(cooling.json.bringUp, "home-box").detail, /Cooling until/);
  assert.equal(t.runs("home-box"), 0);
});

test("concurrent acquires start one hook, and no slot is booked there while it runs", async () => {
  const t = setup({ machines: { "home-box": { env: "env-home", hook: "up" } }, links: { "env-home": "offline" }, linksAfter: { "env-home": "reachable" } });
  await observe(t, factRecords("env-home"));
  const gate = path.join(t.root, "gate");
  const env = { HOOK_GATE: gate };
  const a = t.run(["acquire", "--run", "ra"], { env });
  assert.ok(await waitFor(() => t.runs("home-box") === 1), "the first hook started");

  // The box looks reachable to agents mid-hook, which must not make it bookable before the hook finishes.
  await observe(t, [linkRecord({ "env-home": "reachable" }), ...factRecords("env-home")]);
  const [b, place, list] = await Promise.all([
    t.run(["acquire", "--run", "rb"], { env }),
    t.run(["place", "--place", "home-box"]),
    t.run(["list"]),
  ]);
  assert.equal(entry(b.json.bringUp, "home-box")?.outcome, "in-progress", JSON.stringify(b.json));
  assert.ok(b.json.errors.some((e) => /Bring-up hook running/.test(e)), JSON.stringify(b.json));
  assert.equal(place.code, 1);
  assert.match(place.json.skipped.find((s) => s.label === "home-box").reason, /Bring-up hook running/);
  const shown = list.json.machines.find((m) => m.label === "home-box");
  assert.equal(shown.bringUp.running, true);
  assert.equal(shown.bringUp.run, "ra");

  fs.writeFileSync(gate, "");
  const first = await a;
  assert.equal(entry(first.json.bringUp, "home-box").outcome, "up");
  assert.equal(t.runs("home-box"), 1);
  assert.equal(Object.keys(t.readState().slots).length, 0);
  // The mid-hook observations were taken before it finished, so they were expired with the rest.
  assert.ok(first.json.needsObservation, JSON.stringify(first.json));
});

test("an attempt is not repeated inside the retry window, and exit 75 restarts nothing", async () => {
  const t = setup({
    machines: { "home-box": { env: "env-home", hook: "up", tags: ["linux", "gpu"] }, "busy-box": { env: "env-busy", hook: "up", priority: 5 } },
    defaults: { bringUpRetryMinutes: 30 },
    links: { "env-home": "offline", "env-busy": "unreachable" },
  });
  await observe(t, [...factRecords("env-home"), ...factRecords("env-busy")]);

  // The hook exits 0 but the box stays down.
  const first = await t.run(["acquire", "--run", "r1", "--needs", "gpu"]);
  assert.equal(entry(first.json.bringUp, "home-box").outcome, "up");
  assert.equal(t.runs("busy-box"), 0, "one hook per missing box");
  const again = await t.run(["acquire", "--run", "r1", "--needs", "gpu"]);
  assert.equal(entry(again.json.bringUp, "home-box").outcome, "recent");
  assert.match(entry(again.json.bringUp, "home-box").detail, /Not repeated before/);
  assert.equal(t.runs("home-box"), 1);

  // The busy box: the hook's idle check refuses. Facts stay (nothing restarted), and the refusal is throttled too.
  const busy = await t.run(["acquire", "--run", "r2", "--needs", "linux"], { env: { HOOK_EXIT: "75" } });
  const rep = entry(busy.json.bringUp, "busy-box");
  assert.equal(rep.outcome, "refused-busy", JSON.stringify(busy.json));
  assert.equal(rep.exitCode, 75);
  assert.ok(t.readState().observations["busy-box"].providers, "a refused hook expires nothing");
  assert.equal(t.readState().bringUp["busy-box"].invalidatedAt, undefined);
  const busyAgain = await t.run(["acquire", "--run", "r2"], { env: { HOOK_EXIT: "75" } });
  assert.equal(entry(busyAgain.json.bringUp, "busy-box").outcome, "recent");
  assert.equal(t.runs("busy-box"), 1);
});

test("a hook past its timeout is stopped with its whole process group, within the bound", { timeout: 30_000 }, async () => {
  const t = setup({ machines: { "home-box": { env: "env-home", hook: "stuck", timeoutMs: 1000 } }, links: { "env-home": "offline" } });
  await observe(t, factRecords("env-home"));
  const r = await t.run(["acquire", "--run", "r1"]);
  const rep = entry(r.json.bringUp, "home-box");
  assert.equal(rep.outcome, "timeout", JSON.stringify(r.json));
  assert.equal(rep.timeoutMs, 1000);
  // 1 s timeout + 5 s SIGTERM grace, with slack for process start; never the hook's own 60 s.
  assert.ok(r.ms < 12_000, `took ${r.ms} ms`);
  const pid = Number(fs.readFileSync(path.join(t.dirs.marks, "grandchild.pid"), "utf8"));
  assert.ok(await waitFor(() => !alive(pid), 3000), `grandchild ${pid} survived`);
  assert.equal(t.readState().bringUp["home-box"].outcome, "timeout");
  assert.ok(t.readState().bringUp["home-box"].invalidatedAt);
});

test("a claim whose router died is finalized at its deadline and its facts expired", async () => {
  const t = setup({ machines: { "home-box": { env: "env-home", hook: "up" } }, links: { "env-home": "reachable" } });
  await observe(t, [linkRecord({ "env-home": "reachable" }), ...factRecords("env-home")]);
  const state = t.readState();
  const now = Date.now();
  state.bringUp = { "home-box": { id: "dead", run: "rx", pid: 999999, startedAt: new Date(now - 60_000).toISOString(), deadline: new Date(now + 60_000).toISOString() } };
  t.writeState(state);
  assert.match((await listed(t, "home-box")).notes.join(" "), /Bring-up hook running/);
  assert.equal((await t.run(["place", "--place", "home-box"])).code, 1, "a live claim blocks placement");

  state.bringUp["home-box"].deadline = new Date(now - 1000).toISOString();
  t.writeState(state);
  const shown = await listed(t, "home-box");
  assert.equal(shown.bringUp.outcome, "abandoned");
  assert.equal(shown.state, "unknown", "facts from before the deadline were expired");
  assert.equal(t.readState().bringUp["home-box"].pid, undefined);
});

test("doctor reports hooks as active config with their bounds, and a broken hook is skipped at acquire", async () => {
  const t = setup({
    machines: { "home-box": { env: "env-home", hook: "up", timeoutMs: 45_000 }, "bad-box": { env: "env-bad", hook: null } },
    defaults: { bringUpRetryMinutes: 3 },
    links: { "env-home": "reachable", "env-bad": "offline" },
  });
  const cfgPath = path.join(t.dirs.home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.machines["bad-box"].bringUp = [path.join(t.dirs.hooks, "not-executable.sh")];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  await observe(t, [...factRecords("env-home"), ...factRecords("env-bad")]);

  const doctor = (await t.run(["doctor"])).json;
  assert.equal(doctor.warnings.some((w) => /bringUp/.test(w)), false, JSON.stringify(doctor.warnings));
  const hooks = Object.fromEntries(doctor.router.bringUp.map((h) => [h.label, h]));
  assert.equal(hooks["home-box"].ok, true);
  assert.equal(hooks["home-box"].timeoutMs, 45_000);
  assert.equal(hooks["home-box"].retryMinutes, 3);
  assert.equal(hooks["bad-box"].ok, false);
  assert.match(hooks["bad-box"].problem, /not executable/);

  const r = await t.run(["acquire", "--run", "r1", "--count", "2"]);
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.deepEqual(r.json.machines.map((m) => m.label), ["home-box"]);
  assert.match(entry(r.json.bringUp, "bad-box").detail, /not executable/);
  assert.equal(t.readState().bringUp, undefined, "nothing was claimed");
});

test("a router stopped mid-hook takes the hook's process group with it; the claim lapses at its deadline", { timeout: 30_000 }, async () => {
  const t = setup({ machines: { "home-box": { env: "env-home", hook: "stuck", timeoutMs: 60_000 } }, links: { "env-home": "offline" } });
  await observe(t, factRecords("env-home"));
  const child = spawn(process.execPath, [SCRIPT, "acquire", "--run", "r1"], {
    cwd: t.dirs.repo,
    env: { PATH: `${t.dirs.bin}:/usr/bin:/bin`, HOME: t.dirs.user, T3_BOXES_HOME: t.dirs.home, T3_SWARM_HOME: t.dirs.swarm, FAKE_T3_LINKS: path.join(t.root, "links.json"), MARK_DIR: t.dirs.marks },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const pidFile = (n) => path.join(t.dirs.marks, n);
  assert.ok(await waitFor(() => fs.existsSync(pidFile("hook.pid")) && fs.existsSync(pidFile("grandchild.pid")), 10_000), "hook started");
  const hookPid = Number(fs.readFileSync(pidFile("hook.pid"), "utf8"));
  const grandchild = Number(fs.readFileSync(pidFile("grandchild.pid"), "utf8"));

  child.kill("SIGTERM");
  const end = await exited;
  assert.equal(end.code, 143, JSON.stringify(end));
  assert.ok(await waitFor(() => !alive(hookPid) && !alive(grandchild), 2000), `hook ${hookPid} or grandchild ${grandchild} survived`);

  // The claim stays until its deadline, so the box stays unbookable while the restart may be half done.
  const claim = t.readState().bringUp["home-box"];
  assert.equal(claim.finishedAt, undefined);
  assert.ok(Date.parse(claim.deadline) >= Date.parse(claim.startedAt) + 60_000);
  assert.match((await listed(t, "home-box")).notes.join(" "), /Bring-up hook running/);
});
