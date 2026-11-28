import test from "node:test";
import assert from "node:assert/strict";

import {
  UsageError,
  parseArgv,
  parseDurationMs,
  branchNameProblem,
  canonicalRepoKey,
  renderPolicyLine,
  observationRecordsProblem,
  expireFactsBefore,
  bringUpCandidates,
  acquireShortfall,
  checkKnownLabels,
} from "../../skills/t3-box-router/scripts/cli.mjs";

import { mergeFactPatch } from "../../skills/t3-box-router/scripts/facts.mjs";

const NOW = Date.parse("2030-01-01T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const env = (observedAt, validUntil, value) => ({ source: "t3-cli", observedAt: iso(observedAt), validUntil: iso(validUntil), value });

const config = {
  defaults: { cooldownMinutes: 30, minLinkHours: 24 },
  local: { tags: ["macos", "ios-sim", "xcode", "linux"] },
  machines: {
    "home-box": { kind: "always-on", environmentId: "env-1", tags: ["linux", "gpu"], priority: 10, bringUp: ["/bin/true"] },
    "spare-box": { kind: "always-on", environmentId: "env-2", tags: ["linux"], priority: 5, bringUp: ["/bin/true"] },
    "plain-box": { kind: "always-on", environmentId: "env-3", tags: ["linux"], priority: 1 },
  },
  repos: { "github.com/o/r": { needs: ["linux"], deny: ["spare-box"] } },
};

test("parseArgv converts flags to camelCase options", () => {
  const { command, options } = parseArgv(["place", "--count", "3", "--needs", "linux,gpu", "--needs=linux", "--base", "main", "--branch", "w/1"]);
  assert.equal(command, "place");
  assert.deepEqual(options, { args: [], count: 3, needs: ["linux", "gpu"], base: "main", branch: "w/1" });
  const done = parseArgv(["done", "--slot", "abc123", "--outcome", "unreachable", "--min-cooldown", "1h"]).options;
  assert.equal(done.minCooldown, 3600000);
  assert.equal(parseArgv(["register-payload", "--run", "r1", "--clear"]).options.clear, true);
  assert.equal(parseArgv([]).command, "help");
});

test("parseArgv rejects bad input before any state change", () => {
  for (const argv of [
    ["place", "--count", "0"],
    ["place", "--count", "1.5"],
    ["place", "--base", "-x"],
    ["place", "--branch", "a b"],
    ["place", "--branch", "x.lock"],
    ["place", "--kind", "ios"],
    ["place", "--slot", "a"],
    ["acquire"],
    ["done", "--slot", "a", "--outcome", "maybe"],
    ["done", "--slot", "a", "--outcome", "ok", "--min-cooldown", "30m"],
    ["report", "home-box", "down"],
    ["cooldown", "home-box", "soon"],
    ["cooldown", "home-box", "8d"],
    ["release", "--run", "r1", "--run", "r2"],
    ["nope"],
  ]) {
    assert.throws(() => parseArgv(argv), UsageError, argv.join(" "));
  }
});

test("labels must exist in config", () => {
  const { command, options } = parseArgv(["place", "--place", "ghost"]);
  assert.throws(() => checkKnownLabels(command, options, config), UsageError);
  checkKnownLabels("place", parseArgv(["place", "--place", "box"]).options, config);
  checkKnownLabels("cooldown", parseArgv(["cooldown", "home-box", "30m"]).options, config);
});

test("durations, branch names and repo keys", () => {
  assert.equal(parseDurationMs("90"), 90 * 60000);
  assert.equal(parseDurationMs("1h30m"), 90 * 60000);
  assert.equal(parseDurationMs("45s"), 45000);
  assert.ok(Number.isNaN(parseDurationMs("")));
  assert.equal(branchNameProblem("feat/x-1.2"), null);
  assert.ok(branchNameProblem("a..b"));
  assert.ok(branchNameProblem("a;rm"));
  assert.ok(branchNameProblem(".hidden"));
  assert.equal(canonicalRepoKey("git@github.com:Owner/Repo.git"), "github.com/owner/repo");
  assert.equal(canonicalRepoKey("https://user:tok@github.com/o/r"), "github.com/o/r");
});

test("policy line fills script, run, cap and local-only tags", () => {
  const text = renderPolicyLine({ config, runId: "run-1", scriptPath: "/opt/box router.mjs", maxParallel: 4, repo: null });
  assert.match(text, /node '\/opt\/box router\.mjs' place --run run-1 --count <n>/);
  assert.match(text, /wave cap of 4/);
  assert.match(text, /cooldown env:<label> 30m/);
  assert.match(text, /this machine in this repo: ios-sim, macos, xcode\./);
  const pinned = renderPolicyLine({ config: { ...config, repos: { k: { pin: "local" } } }, runId: "r", scriptPath: "/s", maxParallel: 2, repo: "k" });
  assert.match(pinned, /pins all work to this machine/);
});

test("observe records are restricted to the three read-only tools", () => {
  assert.equal(observationRecordsProblem([{ tool: "t3_environment_links", args: {}, pages: [{ links: [] }] }]), null);
  assert.match(observationRecordsProblem([{ tool: "delegate_task", pages: [{}] }]), /tool must be one of/);
  assert.match(observationRecordsProblem([{ tool: "t3_project_list", args: {}, pages: [{}] }]), /environmentId/);
  assert.match(observationRecordsProblem({}), /array/);
});

test("mergeFactsPatch keeps newer facts and drops stale environments", () => {
  const state = {
    observations: {
      "home-box": { environmentId: "env-1", link: env(NOW, NOW + 1, { status: "reachable" }), providers: env(NOW - 5, NOW + 9, ["p"]) },
      "spare-box": { environmentId: "env-old", providers: env(NOW, NOW + 9, ["q"]) },
    },
  };
  const patch = {
    "home-box": { environmentId: "env-1", link: env(NOW - 1000, NOW + 900000, { status: "unreachable" }), providers: env(NOW, NOW + 9, ["p2"]) },
    "spare-box": { environmentId: "env-2", link: env(NOW, NOW + 900000, { status: "reachable" }) },
    "plain-box": { environmentId: "env-wrong", link: env(NOW, NOW + 900000, { status: "reachable" }) },
  };
  const next = mergeFactPatch(config, state, patch, NOW);
  assert.equal(next.observations["home-box"].link.value.status, "reachable");
  assert.deepEqual(next.observations["home-box"].providers.value, ["p2"]);
  assert.deepEqual(Object.keys(next.observations["spare-box"]).sort(), ["environmentId", "link"]);
  assert.equal(next.observations["plain-box"], undefined);
  assert.deepEqual(mergeFactPatch(config, state, null, NOW), state);
});

test("expireFactsBefore invalidates only facts older than the cutoff", () => {
  const state = { observations: { "home-box": { environmentId: "env-1", link: env(NOW - 10, NOW + 900000, {}), projects: env(NOW + 10, NOW + 900000, {}) } } };
  const next = expireFactsBefore(state, ["home-box"], NOW);
  assert.equal(next.observations["home-box"].link.validUntil, iso(NOW));
  assert.equal(next.observations["home-box"].projects.validUntil, iso(NOW + 900000));
});

test("bringUpCandidates picks only down, idle, matching boxes with fresh evidence", () => {
  const down = (id) => ({ environmentId: id, link: env(NOW, NOW + 900000, { status: "unreachable", expiresAt: "2031-01-01T00:00:00Z" }) });
  const state = { observations: { "home-box": down("env-1"), "spare-box": down("env-2"), "plain-box": down("env-3") }, health: {}, slots: {} };
  let r = bringUpCandidates({ config, state, options: { needs: ["linux"] }, repo: null, now: NOW });
  assert.deepEqual(r.candidates.map((c) => c.label), ["home-box", "spare-box"]);
  r = bringUpCandidates({ config, state, options: {}, repo: "github.com/o/r", now: NOW });
  assert.deepEqual(r.candidates.map((c) => c.label), ["home-box"]);
  r = bringUpCandidates({ config, state, options: { needs: ["gpu"] }, repo: null, now: NOW, exclude: new Set(["home-box"]) });
  assert.deepEqual(r.candidates, []);

  const busy = { ...state, slots: { s1: { label: "home-box", expiresAt: iso(NOW + 60000) } }, health: { "spare-box": { cooldownUntil: iso(NOW + 60000) } } };
  r = bringUpCandidates({ config, state: busy, options: {}, repo: null, now: NOW });
  assert.deepEqual(r.candidates, []);
  assert.match(r.skipped.find((s) => s.label === "home-box").reason, /slot/);
  assert.match(r.skipped.find((s) => s.label === "spare-box").reason, /Cooling/);

  const stale = { ...state, observations: { "home-box": { environmentId: "env-1", link: env(NOW - 2000, NOW - 1000, { status: "unreachable" }) } } };
  r = bringUpCandidates({ config, state: stale, options: {}, repo: null, now: NOW });
  assert.match(r.skipped.find((s) => s.label === "home-box").reason, /No fresh link/);
});

test("acquireShortfall ignores pending facts", () => {
  assert.equal(acquireShortfall({ ok: false, needsObservation: { calls: [] } }, 2), 0);
  assert.equal(acquireShortfall({ ok: false, machines: [] }, 2), 2);
  assert.equal(acquireShortfall({ ok: true, machines: [{}], shortfall: 1 }, 2), 1);
  assert.equal(acquireShortfall({ ok: true, machines: [{}] }, undefined), 0);
});
