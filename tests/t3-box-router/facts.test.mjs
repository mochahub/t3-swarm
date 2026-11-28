import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyState, validateConfig } from "../../skills/t3-box-router/scripts/store.mjs";
import {
  ObservationError,
  applyObservations,
  applyObservationsDetailed,
  discover,
  mergeFactPatch,
  parseT3EnvironmentList,
  probeUrl,
  proposeLabel,
  refreshFacts,
  refreshFactsDetailed,
  sanitizeError,
} from "../../skills/t3-box-router/scripts/facts.mjs";

const NOW = Date.parse("2030-01-01T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function config(extraMachines = {}) {
  const v = validateConfig({
    version: 1,
    machines: {
      "home-box": { environmentId: "env-home", url: "https://home-box.example", tags: ["linux"] },
      "spare-box": { environmentId: "env-spare", tags: ["linux"] },
      ...extraMachines,
    },
  });
  assert.ok(v.ok, JSON.stringify(v.errors));
  return v.config;
}

const linksRecord = (links) => ({ tool: "t3_environment_links", args: {}, pages: [{ links }] });
const homeLink = {
  environmentId: "env-home",
  label: "home-box",
  status: "reachable",
  access: "full-access",
  expiresAt: "2030-02-01T00:00:00Z",
  lastError: null,
  url: "https://secret-internal.example/path",
};

function specRecords() {
  return [
    linksRecord([homeLink, { environmentId: "env-unknown", label: "stranger", status: "reachable" }]),
    {
      tool: "orchestrator_capabilities",
      args: { environmentId: "env-home" },
      pages: [
        {
          providers: [
            { providerInstanceId: "claude", canRunChildTask: true, models: ["big-list"] },
            { providerInstanceId: "codex", canRunChildTask: "true" },
            { providerInstanceId: "gemini", canRunChildTask: false },
          ],
        },
      ],
    },
    {
      tool: "t3_project_list",
      args: { environmentId: "env-home" },
      pages: [
        {
          projects: [
            { id: "proj-1", title: "Repo", path: "/home/u/repo", repositoryIdentity: { canonicalKey: "GitHub.com/Owner/Repo" }, archivedAt: null, deletedAt: null },
            { id: "proj-old", repositoryIdentity: { canonicalKey: "github.com/owner/old" }, archivedAt: "2029-01-01T00:00:00Z", deletedAt: null },
          ],
          nextCursor: 1,
        },
        { projects: [{ id: "proj-2", repositoryIdentity: { canonicalKey: "github.com/owner/two" }, archivedAt: null, deletedAt: null }] },
      ],
    },
  ];
}

// ------------------------------------------------------------------------------------------------- observe

test("applyObservations joins agent replies onto configured machines and keeps only reduced facts", () => {
  const cfg = config();
  const { state, updated, ignored } = applyObservationsDetailed(cfg, emptyState(), specRecords(), NOW);
  assert.deepEqual(updated, ["home-box", "spare-box"]);
  assert.deepEqual(ignored, []);
  const home = state.observations["home-box"];
  assert.equal(home.environmentId, "env-home");
  assert.deepEqual(home.link, {
    source: "agent",
    observedAt: iso(NOW),
    validUntil: iso(NOW + 15 * MIN),
    value: { status: "reachable", access: "full-access", expiresAt: "2030-02-01T00:00:00Z", lastError: null },
  });
  assert.deepEqual(home.providers, { source: "agent", observedAt: iso(NOW), validUntil: iso(NOW + 24 * HOUR), value: ["claude"] });
  assert.deepEqual(home.projects.value, { "github.com/owner/repo": "proj-1", "github.com/owner/two": "proj-2" });
  assert.equal(home.projects.validUntil, iso(NOW + 24 * HOUR));
  const text = JSON.stringify(state);
  for (const leaked of ["big-list", "/home/u/repo", "secret-internal", "stranger", "env-unknown"]) assert.ok(!text.includes(leaked), leaked);
});

test("a complete link read without a configured environment records an absent link", () => {
  const { state } = applyObservationsDetailed(config(), emptyState(), [linksRecord([homeLink])], NOW);
  assert.equal(state.observations["spare-box"].link.value, null);
  assert.equal(state.observations["spare-box"].environmentId, "env-spare");
});

test("applyObservations is pure", () => {
  const before = emptyState();
  const frozen = JSON.stringify(before);
  const next = applyObservations(config(), before, specRecords(), NOW);
  assert.equal(JSON.stringify(before), frozen);
  assert.notEqual(next, before);
});

test("an incomplete project list is rejected and nothing is applied", () => {
  const records = specRecords();
  records[2].pages.pop();
  assert.throws(
    () => applyObservations(config(), emptyState(), records, NOW),
    (err) => err instanceof ObservationError && err.result.ok === false && err.result.record === 2 && /nextCursor/.test(err.result.error),
  );
});

test("unreadable records are rejected with their index", () => {
  const cfg = config();
  const bad = [
    [[{ tool: "delegate_task", args: {}, pages: [{}] }], 0, /tool must be one of/],
    [[linksRecord([]), { tool: "t3_project_list", args: { environmentId: "env-home" }, pages: [] }], 1, /non-empty/],
    [[{ tool: "t3_environment_links", pages: [{ error: "denied token=abc123" }] }], 0, /no links array.*T3 reported: denied token=\[redacted\]/],
    [[{ tool: "orchestrator_capabilities", args: { environmentId: "bad id with spaces" }, pages: [{ providers: [] }] }], 0, /environmentId/],
    [["not an object"], 0, /not an object/],
  ];
  for (const [records, index, pattern] of bad) {
    assert.throws(
      () => applyObservations(cfg, emptyState(), records, NOW),
      (err) => err instanceof ObservationError && err.result.record === index && pattern.test(err.result.error),
      JSON.stringify(records),
    );
  }
  assert.throws(() => applyObservations(cfg, emptyState(), { tool: "t3_environment_links" }, NOW), ObservationError);
  assert.throws(() => applyObservations(cfg, emptyState(), Array.from({ length: 65 }, () => linksRecord([])), NOW), /At most 64/);
  const huge = { tool: "t3_project_list", args: { environmentId: "env-home" }, pages: [{ projects: Array.from({ length: 2001 }, () => ({})) }] };
  assert.throws(() => applyObservations(cfg, emptyState(), [huge], NOW), /more than 2000/);
});

test("provider and project records for unknown or local environments are ignored, not applied", () => {
  const records = [
    { tool: "orchestrator_capabilities", args: {}, pages: [{ providers: [{ providerInstanceId: "claude", canRunChildTask: true }] }] },
    { tool: "t3_project_list", args: { environmentId: "env-elsewhere" }, pages: [{ projects: [] }] },
  ];
  const { state, updated, ignored } = applyObservationsDetailed(config(), emptyState(), records, NOW);
  assert.deepEqual(updated, []);
  assert.deepEqual(ignored.map((i) => i.record), [0, 1]);
  assert.deepEqual(state.observations, {});
});

test("an observation resets a label whose stored identity is stale", () => {
  const state = emptyState();
  state.observations["home-box"] = {
    environmentId: "env-previous",
    projects: { source: "agent", observedAt: iso(NOW), validUntil: iso(NOW + HOUR), value: { "github.com/a/b": "p" } },
  };
  const next = applyObservations(config(), state, [linksRecord([homeLink])], NOW);
  assert.equal(next.observations["home-box"].environmentId, "env-home");
  assert.equal(next.observations["home-box"].projects, undefined);
});

test("lastError is reduced to a short single line without credentials", () => {
  const err = "fetch https://user:hunter2@box.example/x?token=abc&b=2 failed\nBearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz\npairing code: 123456 " + "x".repeat(400);
  const s = sanitizeError(err);
  assert.ok(s.length <= 160);
  assert.ok(!s.includes("\n"));
  for (const secret of ["hunter2", "abc&", "eyJhbG", "123456"]) assert.ok(!s.includes(secret), `${secret} in ${s}`);
  assert.equal(sanitizeError("Token expired; exit code 3"), "Token expired; exit code 3");
  assert.ok(!sanitizeError("Authorization: Bearer abc.def").includes("abc.def"));
  assert.equal(sanitizeError("got Bearer abc.def back"), "got Bearer [redacted] back");
  assert.equal(sanitizeError(null), null);
  assert.equal(sanitizeError({ message: "boom" }), "boom");
  assert.equal(sanitizeError({ nested: true }), "Unreadable error.");
  const { state } = applyObservationsDetailed(config(), emptyState(), [linksRecord([{ ...homeLink, status: "<script>", lastError: err }])], NOW);
  assert.equal(state.observations["home-box"].link.value.status, "unrecognized");
  assert.equal(state.observations["home-box"].link.value.lastError, s);
});

// ------------------------------------------------------------------------------------------------- merge

test("mergeFactPatch keeps the newer envelope and drops stale identities", () => {
  const cfg = config();
  const linkAt = (t, status) => ({ source: "t3-cli", observedAt: iso(t), validUntil: iso(t + 15 * MIN), value: { status, access: null, expiresAt: null, lastError: null } });
  const state = emptyState();
  state.observations["home-box"] = { environmentId: "env-home", link: { ...linkAt(NOW, "reachable"), source: "agent" } };
  const patch = {
    "home-box": { environmentId: "env-home", link: linkAt(NOW - MIN, "offline"), probe: { source: "https", observedAt: iso(NOW - MIN), validUntil: iso(NOW + 14 * MIN), value: true } },
    "spare-box": { environmentId: "env-renamed", link: linkAt(NOW, "reachable") },
    "gone-box": { environmentId: "env-gone", link: linkAt(NOW, "reachable") },
  };
  const next = mergeFactPatch(cfg, state, patch, NOW);
  assert.equal(next.observations["home-box"].link.value.status, "reachable", "older patch does not overwrite newer fact");
  assert.equal(next.observations["home-box"].link.source, "agent");
  assert.equal(next.observations["home-box"].probe.value, true);
  assert.equal(next.observations["spare-box"], undefined);
  assert.equal(next.observations["gone-box"], undefined);
  assert.equal(state.observations["home-box"].probe, undefined, "input state untouched");

  const newer = mergeFactPatch(cfg, next, { "home-box": { environmentId: "env-home", link: linkAt(NOW + MIN, "offline") } }, NOW + MIN);
  assert.equal(newer.observations["home-box"].link.value.status, "offline");
  const expired = mergeFactPatch(cfg, emptyState(), { "spare-box": { environmentId: "env-spare", link: linkAt(NOW - HOUR, "reachable") } }, NOW);
  assert.deepEqual(expired.observations, {});
});

// ------------------------------------------------------------------------------------------------- refresh

function fakeT3(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-router-t3-"));
  const bin = path.join(dir, "t3");
  const calls = path.join(dir, "calls.log");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n${body}\n`,
    { mode: 0o755 },
  );
  return { bin, dir, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []) };
}

const t3List = (list) => fakeT3(`process.stdout.write(${JSON.stringify(JSON.stringify(list))});`);

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}
const respond = (status) => ({ status, body: { cancel: async () => {} } });

test("refreshFacts reads links through the t3 CLI and probes HTTPS endpoints", async () => {
  const t3 = t3List({ environments: [{ id: "env-home", name: "home-box", status: "reachable", access: "full-access", expires_at: "2030-02-01T00:00:00Z", last_error: null }] });
  const fetch = fakeFetch(() => respond(200));
  const r = await refreshFactsDetailed(config(), emptyState(), NOW, { t3Bin: t3.bin, fetch });
  assert.deepEqual(t3.calls(), [["environment", "list", "--json"]]);
  assert.deepEqual(r.t3, { available: true, ok: true });
  assert.deepEqual(r.patch["home-box"].link, {
    source: "t3-cli",
    observedAt: iso(NOW),
    validUntil: iso(NOW + 15 * MIN),
    value: { status: "reachable", access: "full-access", expiresAt: "2030-02-01T00:00:00Z", lastError: null },
  });
  assert.equal(r.patch["home-box"].environmentId, "env-home");
  assert.deepEqual(r.patch["home-box"].probe, { source: "https", observedAt: iso(NOW), validUntil: iso(NOW + 15 * MIN), value: true });
  assert.deepEqual(r.patch["spare-box"], { environmentId: "env-spare", link: { source: "t3-cli", observedAt: iso(NOW), validUntil: iso(NOW + 15 * MIN), value: null } });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://home-box.example/");
  assert.equal(fetch.calls[0].init.method, "GET");
  assert.equal(fetch.calls[0].init.redirect, "manual");
  assert.ok(fetch.calls[0].init.signal);
});

test("refreshFacts skips fresh facts unless forced, and merges back as a patch", async () => {
  const t3 = t3List([{ environmentId: "env-home", status: "reachable" }, { environmentId: "env-spare", status: "reachable" }]);
  const fetch = fakeFetch(() => respond(204));
  const cfg = config();
  const first = await refreshFacts(cfg, emptyState(), NOW, { t3Bin: t3.bin, fetch });
  const state = mergeFactPatch(cfg, emptyState(), first, NOW);
  const second = await refreshFacts(cfg, state, NOW + MIN, { t3Bin: t3.bin, fetch });
  assert.deepEqual(second, {});
  assert.equal(t3.calls().length, 1);
  assert.equal(fetch.calls.length, 1);
  const forced = await refreshFacts(cfg, state, NOW + MIN, { t3Bin: t3.bin, fetch, force: true, labels: ["home-box"] });
  assert.deepEqual(Object.keys(forced), ["home-box"]);
  assert.equal(t3.calls().length, 2);
  const later = await refreshFacts(cfg, state, NOW + 16 * MIN, { t3Bin: t3.bin, fetch });
  assert.deepEqual(Object.keys(later).sort(), ["home-box", "spare-box"]);
});

test("a missing, failing, slow or garbled t3 CLI yields no link facts", async () => {
  const cfg = config({});
  const noFetch = fakeFetch(() => respond(200));
  const none = await refreshFactsDetailed(cfg, emptyState(), NOW, { t3Bin: false, fetch: noFetch });
  assert.deepEqual(none.t3, { available: false });
  assert.equal(none.patch["home-box"].link, undefined);
  assert.equal(none.patch["spare-box"], undefined);

  const failing = fakeT3(`process.stderr.write("token=abcdef boom"); process.exit(3);`);
  const f = await refreshFactsDetailed(cfg, emptyState(), NOW, { t3Bin: failing.bin, fetch: noFetch });
  assert.equal(f.t3.ok, false);
  assert.match(f.t3.error, /t3 environment list failed/);
  assert.equal(f.patch["spare-box"], undefined);

  const slow = fakeT3(`setTimeout(() => {}, 10000);`);
  const s = await refreshFactsDetailed(cfg, emptyState(), NOW, { t3Bin: slow.bin, t3TimeoutMs: 200, fetch: noFetch });
  assert.equal(s.t3.ok, false);
  assert.match(s.t3.error, /timed out/);

  const garbled = fakeT3(`process.stdout.write("not json");`);
  const g = await refreshFactsDetailed(cfg, emptyState(), NOW, { t3Bin: garbled.bin, fetch: noFetch });
  assert.equal(g.t3.ok, false);
  assert.match(g.t3.error, /not usable/);

  const missing = await refreshFactsDetailed(cfg, emptyState(), NOW, { t3Bin: path.join(os.tmpdir(), "no-such-t3-binary"), fetch: noFetch });
  assert.equal(missing.t3.ok, false);
});

test("probes fail closed on server errors, network errors and timeouts", async () => {
  assert.deepEqual(await probeUrl("https://a.example", { fetch: fakeFetch(() => respond(503)) }), { ok: false, status: 503 });
  assert.deepEqual(await probeUrl("https://a.example", { fetch: fakeFetch(() => respond(401)) }), { ok: true, status: 401 });
  assert.deepEqual(await probeUrl("https://a.example", { fetch: fakeFetch(() => respond(302)) }), { ok: true, status: 302 });
  const net = await probeUrl("https://a.example", { fetch: fakeFetch(() => Promise.reject(new Error("ECONNREFUSED"))) });
  assert.equal(net.ok, false);
  assert.match(net.error, /ECONNREFUSED/);
  const hang = await probeUrl("https://a.example", { fetch: () => new Promise(() => {}), timeoutMs: 50 });
  assert.deepEqual(hang, { ok: false, error: "Timed out after 50 ms." });
  const aborting = await probeUrl("https://a.example", {
    timeoutMs: 50,
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  assert.equal(aborting.ok, false);
  assert.equal((await probeUrl("http://a.example", { fetch: fakeFetch(() => respond(200)) })).ok, false);
  assert.equal((await probeUrl("https://u:p@a.example", { fetch: fakeFetch(() => respond(200)) })).ok, false);

  const failing = fakeFetch(() => respond(500));
  const patch = await refreshFacts(config(), emptyState(), NOW, { t3Bin: false, fetch: failing });
  assert.equal(patch["home-box"].probe.value, false);
});

test("t3 output or agent links with no readable environment ID fail safe instead of marking boxes unlinked", async () => {
  const t3 = t3List([{ environment: { id: "env-home" } }]);
  const r = await refreshFactsDetailed(config(), emptyState(), NOW, { t3Bin: t3.bin, fetch: fakeFetch(() => respond(200)) });
  assert.equal(r.t3.available, true);
  assert.equal(r.t3.ok, false);
  assert.equal(r.patch["home-box"].link, undefined);
  assert.equal(r.patch["spare-box"], undefined);
  assert.throws(
    () => applyObservations(config(), emptyState(), [linksRecord([{ environment: { id: "env-home" } }])], NOW),
    (err) => err instanceof ObservationError && /readable environmentId/.test(err.result.error),
  );
  const empty = await refreshFactsDetailed(config(), emptyState(), NOW, { t3Bin: t3List([]).bin, fetch: fakeFetch(() => respond(200)) });
  assert.equal(empty.t3.ok, true);
  assert.equal(empty.patch["home-box"].link.value, null, "an empty list really means no links");
});

test("labels that shadow Object builtins work in patches and merges", async () => {
  const cfg = config({ constructor: { environmentId: "env-ctor", url: "https://ctor.example" } });
  const t3 = t3List([{ environmentId: "env-ctor", status: "reachable" }]);
  const patch = await refreshFacts(cfg, emptyState(), NOW, { t3Bin: t3.bin, fetch: fakeFetch(() => respond(200)) });
  assert.ok(Object.hasOwn(patch, "constructor"));
  assert.equal(patch.constructor.link.value.status, "reachable");
  assert.equal(patch.constructor.probe.value, true);
  const merged = mergeFactPatch(cfg, emptyState(), patch, NOW);
  assert.equal(merged.observations.constructor.environmentId, "env-ctor");
  const observed = applyObservations(cfg, emptyState(), [linksRecord([{ environmentId: "env-ctor", status: "reachable" }])], NOW);
  assert.equal(observed.observations.constructor.link.value.status, "reachable");
});

test("parseT3EnvironmentList accepts plausible shapes and rejects others", () => {
  assert.equal(parseT3EnvironmentList(JSON.stringify([{ environmentId: "e1", label: "a", status: "reachable" }]))[0].environmentId, "e1");
  assert.equal(parseT3EnvironmentList(JSON.stringify({ links: [{ id: "e2" }] }))[0].environmentId, "e2");
  assert.deepEqual(parseT3EnvironmentList(JSON.stringify({ data: [] })), []);
  assert.throws(() => parseT3EnvironmentList(JSON.stringify({ data: [{ id: "__proto__ x" }, 5] })), /readable environment ID/);
  assert.throws(() => parseT3EnvironmentList(JSON.stringify({ unexpected: true })), /Unrecognized/);
});

// ------------------------------------------------------------------------------------------------- discover

test("discover proposes unconfigured links and flags label problems", async () => {
  const t3 = t3List([
    { environmentId: "env-home", label: "Home Box", status: "reachable" },
    { environmentId: "env-new", label: "Big GPU Box!", status: "reachable", access: "full-access" },
    { environmentId: "env-local", label: "local", status: "reachable" },
    { environmentId: "env-clash", label: "spare-box", status: "offline", lastError: "secret=abc" },
  ]);
  const r = await discover(config(), { t3Bin: t3.bin });
  assert.equal(r.ok, true);
  assert.equal(r.source, "t3-cli");
  const byEnv = Object.fromEntries(r.proposed.map((p) => [p.environmentId, p]));
  assert.deepEqual(Object.keys(byEnv).sort(), ["env-clash", "env-local", "env-new"]);
  assert.equal(byEnv["env-new"].label, "big-gpu-box");
  assert.deepEqual(byEnv["env-new"].machine, { kind: "always-on", environmentId: "env-new", tags: [], priority: 10, maxConcurrent: 2 });
  assert.ok(byEnv["env-local"].issues.some((i) => /reserved/.test(i)));
  assert.ok(byEnv["env-clash"].issues.some((i) => /configured machine/.test(i)));
  assert.ok(byEnv["env-clash"].issues.some((i) => /not reachable/.test(i)));
  assert.equal(byEnv["env-clash"].lastError, "secret=[redacted]");
  const home = r.configured.find((c) => c.label === "home-box");
  assert.ok(home.issues.some((i) => /T3 calls this link "Home Box"/.test(i)));
  const spare = r.configured.find((c) => c.label === "spare-box");
  assert.equal(spare.linked, false);
});

test("discover falls back to an agent record, and asks for one when it has neither", async () => {
  const fromAgent = await discover(null, { t3Bin: false, records: linksRecord([homeLink, { ...homeLink, environmentId: "env-2", label: "home-box" }]) });
  assert.equal(fromAgent.ok, true);
  assert.equal(fromAgent.source, "agent");
  assert.deepEqual(fromAgent.proposed.map((p) => p.label), ["home-box", "home-box"]);
  assert.ok(fromAgent.proposed[1].issues.some((i) => /another proposed row/.test(i)));
  assert.deepEqual(fromAgent.configured, []);

  const asks = await discover(config(), { t3Bin: false });
  assert.equal(asks.ok, false);
  assert.deepEqual(asks.needsObservation.calls, [{ tool: "t3_environment_links", args: {} }]);

  const wrong = await discover(config(), { t3Bin: false, records: [{ tool: "t3_project_list", args: { environmentId: "env-home" }, pages: [{ projects: [] }] }] });
  assert.equal(wrong.ok, false);
  const broken = await discover(config(), { t3Bin: false, records: [{ tool: "t3_environment_links", pages: "nope" }] });
  assert.equal(broken.ok, false);
  assert.equal(broken.record, 0);
});

test("proposeLabel produces valid labels", () => {
  assert.equal(proposeLabel("Home Box", "e1"), "home-box");
  assert.equal(proposeLabel("---", "ABC-123-def"), "box-abc123de");
  assert.equal(proposeLabel(null, "e9"), "box-e9");
  assert.equal(proposeLabel("x".repeat(100), "e").length, 64);
});

test("raw MCP pages yield the same observations as their structured payloads", () => {
  const records = specRecords();
  const wrapped = records.map(record => ({
    ...record, pages: record.pages.map(page => ({ structuredContent: page, content: [] })),
  }));
  const accept = input => applyObservations(config(), emptyState(), input, NOW);
  assert.deepEqual(accept(wrapped), accept(records));
  const textOnly = records.map(record => ({
    ...record, pages: record.pages.map(page => ({ content: [{ type: "text", text: JSON.stringify(page) }] })),
  }));
  assert.deepEqual(accept(textOnly), accept(records));
  wrapped[0].pages[0].isError = true;
  assert.throws(() => accept(wrapped), /T3 reported an error/);
});
