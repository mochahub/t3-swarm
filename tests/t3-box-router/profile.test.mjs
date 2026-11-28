import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PROBE_KIND,
  sanitizeProbe,
  readStoredProfile,
  profileTags,
  deriveCapacity,
  nominalRamGb,
  mergeProbeIntoRawConfig,
  linkUrls,
  discoveryEnvelope,
  recordDiscovered,
  pruneDiscovered,
  unprofiledBoxes,
} from "../../skills/t3-box-router/scripts/profile.mjs";
import { probeMachine, parseAttestations, realHost } from "../../skills/t3-box-router/scripts/probe.mjs";
import { validateConfig, normalizeState, pruneState, emptyState } from "../../skills/t3-box-router/scripts/store.mjs";
import { parseArgv, UsageError } from "../../skills/t3-box-router/scripts/cli.mjs";
import { proposeLabel, parseT3EnvironmentList, applyObservationsDetailed } from "../../skills/t3-box-router/scripts/facts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const router = path.join(root, "skills/t3-box-router/scripts/box-router.mjs");
const NOW = Date.parse("2030-01-01T10:00:00Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const CANARY = "CANARY-sk-live-0123456789";

function report(over = {}) {
  return {
    kind: PROBE_KIND,
    version: 1,
    probedAt: iso(NOW),
    os: "linux",
    arch: "x64",
    cpuCores: 16,
    ramGb: 31.2,
    gpu: { count: 1, vendor: "nvidia" },
    display: { native: false, virtual: true },
    tools: { xcode: false, "ios-sim": false, "android-sdk": true, godot: true, docker: true, gh: true },
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Probe report validation

test("sanitizeProbe keeps known fields, drops unknown ones and derives tags and capacity", () => {
  const r = sanitizeProbe({ ...report(), ok: true, hostname: "box", tools: { ...report().tools, kubectl: true } });
  assert.equal(r.ok, true);
  assert.equal(r.ignored, 2);
  assert.equal(r.probe.hostname, undefined);
  assert.equal(r.probe.tools.kubectl, undefined);
  assert.equal(r.probe.kind, undefined);
  assert.deepEqual(profileTags(r.probe), ["linux", "x64", "gpu", "gpu-nvidia", "ram-32g", "display", "virtual-display", "android-sdk", "godot", "docker", "gh"]);
  assert.deepEqual(deriveCapacity(r.probe, { remote: true }), { priority: 10, maxConcurrent: 7 });
  assert.deepEqual(deriveCapacity({ cpuCores: 64, ramGb: 256 }, { remote: true }).maxConcurrent, 8);
  assert.deepEqual(deriveCapacity({ cpuCores: 2, ramGb: 2 }, { remote: false }), { priority: 0, maxConcurrent: 1 });
  assert.deepEqual([nominalRamGb(15.5), nominalRamGb(16), nominalRamGb(62.7), nominalRamGb(7.6)], [16, 16, 64, 8]);
});

test("sanitizeProbe rejects malformed reports by field name without echoing values", () => {
  for (const bad of [
    report({ kind: CANARY }),
    report({ os: CANARY }),
    report({ cpuCores: 0 }),
    report({ cpuCores: 2.5 }),
    report({ ramGb: CANARY }),
    report({ gpu: { count: -1, vendor: CANARY } }),
    report({ display: { native: CANARY } }),
    report({ tools: { docker: CANARY } }),
    report({ attestations: { [`secret:${CANARY.toLowerCase()}`]: "yes" } }),
    report({ attestations: { [CANARY]: true } }),
    report({ attestations: { "secret:signing": 1 } }),
    report({ attestations: [CANARY] }),
  ]) {
    const r = sanitizeProbe(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!JSON.stringify(r).includes(CANARY));
    assert.ok(!JSON.stringify(r).toLowerCase().includes(CANARY.toLowerCase()));
  }
  assert.equal(sanitizeProbe(null).ok, false);
  assert.equal(sanitizeProbe([report()]).ok, false);
});

test("credential tags come only from strictly boolean owner attestations", () => {
  const r = sanitizeProbe(report({ attestations: { "secret:build-signing": true, "cred:play-store": false } }));
  assert.equal(r.ok, true);
  const tags = profileTags(r.probe);
  assert.ok(tags.includes("secret:build-signing"));
  assert.ok(!tags.includes("cred:play-store"));
  assert.equal(tags.filter((t) => /^(cred|secret):/.test(t)).length, 1);
  // A stored profile edited to sneak in a credential tag through another field gains nothing.
  const stored = readStoredProfile({ ...r.probe, profiledAt: iso(NOW), tags: ["secret:other"] });
  assert.ok(!profileTags(stored.profile).includes("secret:other"));
  assert.deepEqual(parseAttestations(["secret:a=true", "cred:b=false"]), { "secret:a": true, "cred:b": false });
  for (const v of [`secret:a=${CANARY}`, "secret:a=1", "secret:A=true", "token:a=true", "secret:a"]) {
    assert.throws(() => parseAttestations([v]), (e) => !e.message.includes(CANARY));
    assert.throws(() => parseArgv(["probe", "--attest", v]), (e) => e instanceof UsageError && !e.message.includes(CANARY));
  }
  assert.deepEqual(parseArgv(["probe", "--attest", "secret:a=true", "--attest=cred:b=false"]).options.attest, { "secret:a": true, "cred:b": false });
});

// ---------------------------------------------------------------------------------------------------------------
// Probe script

function fakeHost({ platform = "linux", arch = "x64", files = [], executables = [], dirs = {}, texts = {}, env = {}, links = {} } = {}) {
  const fileSet = new Set(files);
  const exeSet = new Set(executables);
  return {
    platform,
    arch,
    cpuCount: 12,
    totalmem: 64 * 2 ** 30,
    homedir: "/home/u",
    env: { PATH: "/usr/bin:/opt/bin", ...env },
    exists: (p) => fileSet.has(p) || exeSet.has(p) || Object.prototype.hasOwnProperty.call(dirs, p),
    isExecutable: (p) => exeSet.has(p),
    readdir: (p) => dirs[p] || [],
    readText: (p) => texts[p] ?? null,
    readlink: (p) => links[p] ?? null,
  };
}

test("probeMachine reports Linux hardware and tools from presence checks only", () => {
  const host = fakeHost({
    dirs: { "/proc/driver/nvidia/gpus": ["0000:01:00.0", "0000:02:00.0"] },
    executables: ["/usr/bin/xvfb-run", "/usr/bin/docker", "/opt/bin/godot4", "/opt/sdk/platform-tools/adb"],
    env: { ANDROID_HOME: "/opt/sdk" },
  });
  const r = probeMachine({ host, now: NOW });
  assert.equal(r.kind, PROBE_KIND);
  assert.equal(r.os, "linux");
  assert.equal(r.cpuCores, 12);
  assert.equal(r.ramGb, 64);
  assert.deepEqual(r.gpu, { count: 2, vendor: "nvidia" });
  assert.deepEqual(r.display, { native: false, virtual: true });
  assert.deepEqual(r.tools, { xcode: false, "ios-sim": false, "android-sdk": true, godot: true, docker: true, gh: false });
  assert.equal(r.attestations, undefined);
  assert.equal(sanitizeProbe(r).ok, true);

  const amd = probeMachine({ host: fakeHost({ dirs: { "/sys/class/drm": ["card0", "card0-HDMI-A-1", "renderD128"] }, texts: { "/sys/class/drm/card0/device/vendor": "0x1002\n" } }) });
  assert.deepEqual(amd.gpu, { count: 1, vendor: "amd" });
});

test("probeMachine finds Xcode and the iOS simulator on macOS", () => {
  const dev = "/Applications/Xcode.app/Contents/Developer";
  const host = fakeHost({
    platform: "darwin",
    arch: "arm64",
    links: { "/var/db/xcode_select_link": dev },
    files: [`${dev}/usr/bin/xcodebuild`, `${dev}/Platforms/iPhoneSimulator.platform`],
    executables: ["/opt/bin/gh"],
  });
  const r = probeMachine({ host, attestations: { "secret:asc-key": true } });
  assert.equal(r.os, "macos");
  assert.deepEqual(r.gpu, { count: 1, vendor: "apple" });
  assert.equal(r.display.native, true);
  assert.equal(r.tools.xcode, true);
  assert.equal(r.tools["ios-sim"], true);
  assert.equal(r.tools.gh, true);
  assert.deepEqual(r.attestations, { "secret:asc-key": true });
  const tags = profileTags(sanitizeProbe(r).probe);
  assert.ok(tags.includes("gpu-apple") && !tags.includes("gpu"));
});

test("the real host view reads only allowlisted environment variables", () => {
  process.env.T3_BOXES_PROFILE_TEST_SECRET = CANARY;
  try {
    const host = realHost();
    assert.equal(JSON.stringify(host.env).includes(CANARY), false);
    for (const k of Object.keys(host.env)) assert.ok(["PATH", "PATHEXT", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR"].includes(k), k);
  } finally {
    delete process.env.T3_BOXES_PROFILE_TEST_SECRET;
  }
  const src = fs.readFileSync(path.join(root, "skills/t3-box-router/scripts/probe.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /from "\.\//, "probe.mjs must stay self-contained");
  assert.doesNotMatch(code, /child_process|keychain|\.ssh|gh auth|security find|fetch\(/);
});

// ---------------------------------------------------------------------------------------------------------------
// Config: effective tags and capacity

const stored = (over = {}) => ({ environmentId: "env-1", profiledAt: iso(NOW), ...sanitizeProbe(report()).probe, ...over });

test("validated config merges profile tags with explicit tags, extraTags and denyTags; explicit values win", () => {
  const v = validateConfig({
    version: 1,
    local: { profile: { profiledAt: iso(NOW), ...sanitizeProbe(report({ os: "macos", arch: "arm64", gpu: { count: 1, vendor: "apple" }, cpuCores: 4, ramGb: 8 })).probe } },
    machines: {
      auto: { environmentId: "env-1", profile: stored() },
      pinned: { environmentId: "env-2", tags: ["linux", "fast"], extraTags: ["ram-hot"], denyTags: ["docker", "gpu"], maxConcurrent: 3, priority: 4, exclusive: ["gpu-nvidia"], profile: stored({ environmentId: "env-2" }) },
      off: { environmentId: "env-3", tags: ["linux"], profile: false },
    },
  });
  assert.equal(v.ok, true, v.errors.join("; "));
  const { auto, pinned, off } = v.config.machines;
  assert.ok(auto.tags.includes("gpu") && auto.tags.includes("docker"));
  assert.equal(auto.maxConcurrent, 7);
  assert.equal(auto.priority, 10);
  assert.deepEqual(pinned.tags.slice(0, 2), ["linux", "fast"]);
  assert.ok(pinned.tags.includes("ram-hot") && pinned.tags.includes("gpu-nvidia"));
  assert.ok(!pinned.tags.includes("docker") && !pinned.tags.includes("gpu"));
  assert.equal(pinned.maxConcurrent, 3);
  assert.equal(pinned.priority, 4);
  assert.equal(off.profile, false);
  assert.deepEqual(off.tags, ["linux"]);
  assert.equal(v.config.local.priority, 0);
  assert.equal(v.config.local.maxConcurrent, 2);
  assert.ok(v.config.local.tags.includes("gpu-apple"));
  assert.deepEqual(v.warnings, []);
});

test("an invalid or foreign stored profile is ignored with a warning that does not echo it", () => {
  const v = validateConfig({
    version: 1,
    machines: {
      a: { environmentId: "env-a", tags: ["linux"], profile: { ...stored({ environmentId: "env-a" }), os: CANARY } },
      b: { environmentId: "env-b", tags: ["linux"], profile: stored({ environmentId: "env-other" }) },
    },
    defaults: { probeTtlDays: 0 },
  });
  assert.equal(v.ok, false); // probeTtlDays must be positive
  assert.ok(v.errors.some((e) => e.includes("probeTtlDays")));
  const w = validateConfig({ version: 1, machines: { a: { environmentId: "env-a", tags: ["linux"], profile: { ...stored({ environmentId: "env-a" }), os: CANARY } }, b: { environmentId: "env-b", tags: ["linux"], profile: stored({ environmentId: "env-other" }) } }, defaults: { probeTtlDays: 3 } });
  assert.equal(w.ok, true);
  assert.equal(w.config.defaults.probeTtlDays, 3);
  assert.equal(w.config.machines.a.profile, undefined);
  assert.deepEqual(w.config.machines.a.tags, ["linux"]);
  assert.equal(w.config.machines.a.maxConcurrent, 2);
  assert.equal(w.config.machines.b.profile, undefined);
  assert.equal(w.warnings.length, 2);
  assert.ok(!JSON.stringify(w).includes(CANARY));
});

test("the documented example validates with its explicit tags, capacity and probe TTL", () => {
  const example = JSON.parse(fs.readFileSync(path.join(root, "skills/t3-box-router/references/config.example.json"), "utf8"));
  const v = validateConfig(example);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.deepEqual(v.warnings, []);
  const box = v.config.machines["home-box"];
  assert.deepEqual(box.tags, ["linux", "gpu", "ram-32g", "godot", "secret:build-signing"]);
  assert.equal(box.priority, 10);
  assert.equal(box.maxConcurrent, 6);
  assert.equal(box.profile, undefined);
  assert.equal(v.config.local.maxConcurrent, 4);
  assert.equal(v.config.local.priority, 0);
  assert.equal(v.config.defaults.probeTtlDays, 7);
});

// ---------------------------------------------------------------------------------------------------------------
// apply-probe merge

test("mergeProbeIntoRawConfig touches only the profile, adds new boxes and refuses mismatches", () => {
  const probe = sanitizeProbe(report()).probe;
  const raw = { version: 1, machines: { "home-box": { environmentId: "env-home", tags: ["linux"], maxConcurrent: 3, extraTags: ["x"] } }, repos: {} };
  const same = mergeProbeIntoRawConfig(raw, { target: "home-box", probe, now: NOW });
  assert.equal(same.ok, true);
  assert.equal(same.created, false);
  assert.deepEqual(same.preserved, ["tags", "extraTags", "maxConcurrent"]);
  assert.deepEqual({ ...same.config.machines["home-box"], profile: undefined }, { ...raw.machines["home-box"], profile: undefined });
  assert.equal(same.config.machines["home-box"].profile.environmentId, "env-home");
  assert.equal(same.config.machines["home-box"].profile.profiledAt, iso(NOW));
  assert.equal(raw.machines["home-box"].profile, undefined, "input is not mutated");

  const added = mergeProbeIntoRawConfig(raw, { target: "new-box", environmentId: "env-new", probe, now: NOW });
  assert.equal(added.ok, true);
  assert.equal(added.created, true);
  assert.deepEqual(Object.keys(added.config.machines["new-box"]), ["kind", "environmentId", "profile"]);

  assert.match(mergeProbeIntoRawConfig(raw, { target: "home-box", environmentId: "env-x", probe, now: NOW }).error, /different environmentId/);
  assert.match(mergeProbeIntoRawConfig(raw, { target: "Home-Box", environmentId: "env-y", probe, now: NOW }).error, /collides/);
  assert.match(mergeProbeIntoRawConfig(raw, { target: "other", environmentId: "env-home", probe, now: NOW }).error, /already configured as home-box/);
  assert.match(mergeProbeIntoRawConfig(raw, { target: "ghost", probe, now: NOW }).error, /--environment-id/);
  const local = mergeProbeIntoRawConfig(raw, { target: "local", probe, now: NOW });
  assert.equal(local.ok, true);
  assert.equal(local.config.local.profile.environmentId, undefined);
  assert.throws(() => parseArgv(["apply-probe", "local", "--environment-id", "env-1"]), UsageError);
  assert.throws(() => parseArgv(["apply-probe", "box"]), UsageError);
  assert.equal(parseArgv(["apply-probe", "new-box", "--environment-id", "env-1"]).options.target, "new-box");
});

// ---------------------------------------------------------------------------------------------------------------
// Discovery and unprofiledBoxes

test("link URLs keep only credential-free origins", () => {
  assert.deepEqual(
    linkUrls({ url: "https://user:pw@box.example:8443/pair/abcdef?token=zzz#x", urls: ["wss://box.example/ws", "file:///etc/passwd", "nonsense"], endpoints: { http: "http://10.0.0.2:3773/x" } }),
    ["https://box.example:8443", "wss://box.example", "http://10.0.0.2:3773"],
  );
  const parsed = parseT3EnvironmentList(JSON.stringify([{ environmentId: "e1", label: "a", status: "reachable", url: "https://a.example/?code=secret" }, { environmentId: "e2" }]));
  assert.deepEqual(parsed[0].urls, ["https://a.example"]);
  assert.equal(parsed[1].urls, undefined);
});

test("unprofiledBoxes lists new, unprofiled and stale linked boxes and skips the rest", () => {
  const config = validateConfig({
    version: 1,
    defaults: { probeTtlDays: 7 },
    machines: {
      fresh: { environmentId: "env-fresh", profile: stored({ environmentId: "env-fresh", profiledAt: iso(NOW - 6 * DAY) }) },
      stale: { environmentId: "env-stale", url: "https://stale.example", profile: stored({ environmentId: "env-stale", profiledAt: iso(NOW - 8 * DAY) }) },
      bare: { environmentId: "env-bare", tags: ["linux"] },
      optout: { environmentId: "env-optout", tags: ["linux"], profile: false },
      offline: { environmentId: "env-offline", tags: ["linux"] },
    },
  }).config;
  let state = emptyState();
  state = recordDiscovered(state, discoveryEnvelope("t3-cli", [
    { environmentId: "env-fresh", label: "fresh", status: "reachable" },
    { environmentId: "env-stale", label: "stale", status: "reachable", urls: ["https://stale-t3.example"] },
    { environmentId: "env-optout", label: "optout", status: "reachable" },
    { environmentId: "env-new", label: "New Box!", status: "reachable", urls: ["https://new.example"] },
    { environmentId: "env-gone", label: "gone", status: "revoked" },
  ], NOW, 15 * 60_000));
  // bare is known only through its own link observation (the observe fallback for configured machines).
  state.observations.bare = { environmentId: "env-bare", link: { source: "agent", observedAt: iso(NOW), validUntil: iso(NOW + 60_000), value: { status: "reachable" } } };
  state.observations.offline = { environmentId: "env-offline", link: { source: "agent", observedAt: iso(NOW), validUntil: iso(NOW + 60_000), value: null } };
  const boxes = unprofiledBoxes({ config, state, now: NOW, proposeLabel });
  assert.deepEqual(boxes, [
    { environmentId: "env-bare", label: "bare", urls: [], reason: "unprofiled" },
    { environmentId: "env-new", label: "new-box", urls: ["https://new.example"], reason: "new" },
    { environmentId: "env-stale", label: "stale", urls: ["https://stale-t3.example", "https://stale.example"], reason: "stale" },
  ]);
  // The TTL is configurable.
  const strict = { ...config, defaults: { ...config.defaults, probeTtlDays: 1 } };
  assert.ok(unprofiledBoxes({ config: strict, state, now: NOW, proposeLabel }).some((b) => b.label === "fresh" && b.reason === "stale"));
  // An expired discovery read contributes nothing; observations still do.
  const later = unprofiledBoxes({ config, state, now: NOW + 30 * 60_000, proposeLabel });
  assert.deepEqual(later, []);
});

test("new links get unique usable labels and expired links are skipped", () => {
  const config = { machines: { BUILD: { environmentId: "original" } } };
  const links = ["local", "build", "build", "gone"].map((label, i) => ({
    environmentId: "env-" + i, label, status: i === 3 ? "expired" : "reachable",
  }));
  const state = recordDiscovered(emptyState(), discoveryEnvelope("agent", links, NOW, 60_000));
  const boxes = unprofiledBoxes({ config, state, now: NOW, proposeLabel });
  assert.deepEqual(boxes.map((b) => b.label), ["build-2", "build-3", "local-2"]);
});

test("the discovered cache survives state normalization and is pruned when stale", () => {
  const env = discoveryEnvelope("agent", [{ environmentId: "env-1", label: "a", status: "reachable", urls: [] }], NOW, 60_000);
  const s = normalizeState({ ...emptyState(), discovered: env });
  assert.deepEqual(s.discovered, env);
  assert.equal(recordDiscovered(s, discoveryEnvelope("agent", [], NOW - 1, 60_000)), s, "an older read never replaces a newer one");
  assert.equal(pruneState({ machines: {} }, s, NOW + 1), false);
  assert.equal(pruneState({ machines: {} }, s, NOW + 60_001), true);
  assert.equal(s.discovered, undefined);
  assert.equal(pruneDiscovered({ discovered: "junk" }, NOW), true);
});

test("observe records return every link for discovery, configured or not", () => {
  const config = validateConfig({ version: 1, machines: { a: { environmentId: "env-a", tags: ["linux"] } } }).config;
  const r = applyObservationsDetailed(config, emptyState(), [
    { tool: "t3_environment_links", args: {}, pages: [{ links: [{ environmentId: "env-a", status: "reachable" }, { environmentId: "env-b", label: "b", status: "reachable", url: "https://b.example/x?t=1" }] }] },
  ], NOW);
  assert.deepEqual(r.links, [
    { environmentId: "env-a", label: null, status: "reachable", urls: [] },
    { environmentId: "env-b", label: "b", status: "reachable", urls: ["https://b.example"] },
  ]);
  assert.equal(r.state.observations.a.link.value.urls, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// CLI, in temporary homes with a fake t3 binary

function fixture(t, { t3Links } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boxes = path.join(dir, "boxes");
  const bin = path.join(dir, "bin");
  const work = path.join(dir, "work");
  for (const p of [boxes, bin, work]) fs.mkdirSync(p, { mode: 0o700 });
  const t3 = t3Links ? `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(t3Links)}\nEOF\n` : "#!/bin/sh\nexit 1\n";
  fs.writeFileSync(path.join(bin, "t3"), t3, { mode: 0o755 });
  const configPath = path.join(boxes, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    local: { tags: ["macos"], maxConcurrent: 2 },
    machines: { "home-box": { kind: "always-on", environmentId: "env-home", tags: ["linux"], extraTags: ["mine"], denyTags: ["docker"], maxConcurrent: 3 } },
  }, null, 2), { mode: 0o600 });
  const env = { ...process.env, HOME: dir, T3_BOXES_HOME: boxes, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const parse = (p, args) => {
    let json;
    try {
      json = JSON.parse(p.stdout);
    } catch {
      assert.fail(`Invalid JSON for ${args.join(" ")}: ${p.stdout}\n${p.stderr}`);
    }
    assert.equal(p.status === 0, json.ok === true, `${args.join(" ")}: ${p.stdout} ${p.stderr}`);
    return json;
  };
  const box = (args, input) => {
    const p = spawnSync(process.execPath, [router, ...args], { cwd: work, env, input, encoding: "utf8", timeout: 20000 });
    assert.ifError(p.error);
    return { json: parse(p, args), stdout: p.stdout, status: p.status };
  };
  const boxAsync = (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [router, ...args], { cwd: work, env });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.on("error", reject);
      child.on("close", (status) => resolve({ json: parse({ stdout, status }, args), status }));
      child.stdin.end(input);
    });
  return { dir, boxes, configPath, box, boxAsync };
}

const T3_LINKS = [
  { environmentId: "env-home", label: "home-box", status: "reachable", access: "full-access", expiresAt: "2099-01-01T00:00:00Z" },
  { environmentId: "env-new", label: "Studio Mac", status: "reachable", url: "https://u:p@studio.example:3773/pair/xyz?token=abc" },
];

test("list and place report newly linked boxes from the t3 CLI without blocking a ready machine", (t) => {
  const f = fixture(t, { t3Links: T3_LINKS });
  const list = f.box(["list"]).json;
  assert.deepEqual(list.unprofiledBoxes, [
    { environmentId: "env-home", label: "home-box", urls: [], reason: "unprofiled" },
    { environmentId: "env-new", label: "studio-mac", urls: ["https://studio.example:3773"], reason: "new" },
  ]);
  const place = f.box(["place", "--place", "local"]);
  assert.equal(place.status, 0);
  assert.equal(place.json.ok, true);
  assert.equal(place.json.unprofiledBoxes.length, 2);
  assert.ok(!place.stdout.includes("token=abc") && !place.stdout.includes("u:p@"));
  const state = JSON.parse(fs.readFileSync(path.join(f.boxes, "state.json"), "utf8"));
  assert.ok(state.discovered.links["env-new"]);
  assert.equal(f.box(["acquire", "--run", "r1"]).json.unprofiledBoxes.length, 2);
});

test("without the t3 CLI, an observed links record feeds unprofiledBoxes", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.box(["list"]).json.unprofiledBoxes, []);
  const observed = f.box(["observe"], JSON.stringify([{ tool: "t3_environment_links", args: {}, pages: [{ links: T3_LINKS }] }]));
  assert.equal(observed.json.ok, true);
  const boxes = f.box(["list"]).json.unprofiledBoxes;
  assert.deepEqual(boxes.map((b) => [b.environmentId, b.reason]), [["env-home", "unprofiled"], ["env-new", "new"]]);
});

test("probe | apply-probe writes a profile atomically and preserves the user's fields", (t) => {
  const f = fixture(t, { t3Links: T3_LINKS });
  const probe = f.box(["probe"]).json;
  assert.equal(probe.kind, PROBE_KIND);
  const local = f.box(["apply-probe", "local"], JSON.stringify(probe)).json;
  assert.equal(local.ok, true);
  assert.equal(local.effective.priority, 0);

  const applied = f.box(["apply-probe", "home-box"], JSON.stringify(report())).json;
  assert.equal(applied.created, false);
  assert.deepEqual(applied.preserved, ["tags", "extraTags", "denyTags", "maxConcurrent"]);
  assert.equal(applied.effective.maxConcurrent, 3);
  assert.equal(applied.effective.priority, 10);
  assert.ok(applied.effective.tags.includes("mine") && applied.effective.tags.includes("gpu") && !applied.effective.tags.includes("docker"));
  const raw = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(raw.machines["home-box"].tags, ["linux"]);
  assert.equal(raw.machines["home-box"].maxConcurrent, 3);
  assert.equal(raw.machines["home-box"].profile.environmentId, "env-home");
  assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.boxes).filter((n) => n.endsWith(".tmp")), []);

  const added = f.box(["apply-probe", "studio-mac", "--environment-id", "env-new"], JSON.stringify(report({ os: "macos", arch: "arm64", gpu: { count: 1, vendor: "apple" }, cpuCores: 8, ramGb: 16 }))).json;
  assert.equal(added.created, true);
  assert.equal(added.effective.maxConcurrent, 4);
  assert.equal(added.effective.priority, 10);
  assert.deepEqual(f.box(["list"]).json.unprofiledBoxes, []);
  assert.equal(f.box(["doctor"]).json.errors.length, 0);
});

test("apply-probe rejects malformed input without echoing it or touching config", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.configPath, "utf8");
  for (const input of [
    `{"kind": "${CANARY}`,
    JSON.stringify(report({ attestations: { "secret:x": CANARY } })),
    JSON.stringify(report({ attestations: { [CANARY]: true } })),
    JSON.stringify(report({ os: CANARY })),
    JSON.stringify([CANARY]),
  ]) {
    const r = f.box(["apply-probe", "home-box"], input);
    assert.equal(r.status, 1);
    assert.equal(r.json.ok, false);
    assert.ok(!r.stdout.includes(CANARY), r.stdout);
  }
  assert.equal(f.box(["apply-probe", "ghost"], JSON.stringify(report())).json.ok, false);
  assert.equal(f.box(["apply-probe", "home-box", "--environment-id", "env-other"], JSON.stringify(report())).json.ok, false);
  assert.equal(fs.readFileSync(f.configPath, "utf8"), before);
});

test("concurrent apply-probe runs serialize under the lock and keep both writes", async (t) => {
  const f = fixture(t);
  const results = await Promise.all(
    ["a", "b", "c", "d"].map((l) => f.boxAsync(["apply-probe", `box-${l}`, "--environment-id", `env-${l}`], JSON.stringify(report()))),
  );
  for (const r of results) assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const raw = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.deepEqual(Object.keys(raw.machines).sort(), ["box-a", "box-b", "box-c", "box-d", "home-box"]);
  for (const l of ["a", "b", "c", "d"]) assert.equal(raw.machines[`box-${l}`].profile.environmentId, `env-${l}`);
});
