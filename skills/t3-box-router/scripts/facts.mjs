/**
 * t3-box-router facts: T3 observations and router-read facts (Node 18+, built-in modules only).
 *
 * Observation envelopes, stored under state.observations[label] beside `environmentId`:
 *   link       { source: "agent" | "t3-cli", observedAt, validUntil (linkTtlMinutes), value }
 *              value is { status, access, expiresAt, lastError } from T3, or null when a complete, fresh link read
 *              had no link for the configured environmentId (the box is unlinked). A missing envelope means the
 *              router has no fresh evidence (unknown). Only status === "reachable" counts as reachable.
 *   probe      { source: "https", observedAt, validUntil (linkTtlMinutes), value: boolean } from a bounded GET of
 *              the configured HTTPS url. true means an HTTP status below 500 arrived within the timeout. It can
 *              only mark a reachable link degraded; it never makes a box eligible.
 *   providers  { source: "agent", ..., validUntil (factTtlHours), value: [providerInstanceId] } (canRunChildTask)
 *   projects   { source: "agent", ..., validUntil (factTtlHours), value: { canonicalRepoKey: projectId } }
 *
 * Main API:
 *   applyObservations(config, state, records, now) -> new state. Sync and pure, for use inside transaction().
 *       Throws ObservationError (.result = { ok: false, error, record }) and applies nothing when any record is
 *       unreadable. applyObservationsDetailed returns { state, updated, ignored } for the `observe` reply.
 *   refreshFacts(config, state, now, opts?) -> Promise<patch>, keyed by label: { environmentId, link?, probe? }.
 *       Network and subprocess work: call it outside the lock, then merge with mergeFactPatch under the lock.
 *       refreshFactsDetailed also reports whether the t3 CLI was available and each probe's outcome.
 *   mergeFactPatch(config, state, patch, now?) -> new state, keeping whichever envelope has the newer observedAt
 *       and dropping patch entries whose environmentId no longer matches config.
 *   discover(config, opts?) -> Promise<{ ok, source, proposed, configured, ... }>. Writes nothing.
 *
 * Options for the router-read functions: t3Bin (path, or false to never run t3; default searches PATH),
 * t3TimeoutMs, fetch (a fetch-compatible function), probeTimeoutMs, force (ignore fresh cached facts), labels.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DEFAULTS, ID_PATTERN, LABEL_PATTERN, RESERVED_LABELS, isoTime, parseTime } from "./store.mjs";

export const OBSERVABLE_TOOLS = Object.freeze(["t3_environment_links", "orchestrator_capabilities", "t3_project_list"]);
export const LIMITS = Object.freeze({
  records: 64,
  pages: 200,
  itemsPerPage: 2000,
  string: 200,
  repoKey: 300,
  errorSummary: 160,
  t3OutputBytes: 1024 * 1024,
});

const DEFAULT_T3_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const ENVELOPE_KINDS = ["link", "probe", "providers", "projects"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clone = (v) => JSON.parse(JSON.stringify(v));

export class ObservationError extends Error {
  constructor(result) {
    super(result.error);
    this.name = "ObservationError";
    this.result = result;
  }
}

/** Reduce an error from T3 to a short, single-line summary with likely credentials removed, or null. */
export function sanitizeError(value) {
  if (value === null || value === undefined || value === "") return null;
  let s;
  if (typeof value === "string") s = value;
  else if (isObj(value) && typeof value.message === "string") s = value.message;
  else return "Unreadable error.";
  s = s.slice(0, 2000);
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
  s = s.replace(/([?&][^\s=&#]+=)[^\s&#]+/g, "$1[redacted]");
  s = s.replace(/\b(bearer|basic|pairing[-_ ]?code)\s+(?!code\b)[^\s"&,;:]+/gi, "$1 [redacted]");
  s = s.replace(/\b(token|code|api[-_]?key|key|secret|password|passwd|authorization)(\s*[=:]\s*)("?)[^\s"&,;]+/gi, "$1$2$3[redacted]");
  s = s.replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > LIMITS.errorSummary) s = s.slice(0, LIMITS.errorSummary - 3) + "...";
  return s || null;
}

const shortWord = (v) => (typeof v === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : null);
const isoOrNull = (v) => (typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)) ? v : null);

/** The link facts the router keeps. Everything else in the reply is discarded. */
export function reduceLink(link) {
  return {
    status: shortWord(link.status) ?? (link.status == null ? null : "unrecognized"),
    access: shortWord(link.access) ?? (link.access == null ? null : "unrecognized"),
    expiresAt: isoOrNull(link.expiresAt),
    lastError: sanitizeError(link.lastError),
  };
}

function envelope(source, now, ttlMs, value) {
  return { source, observedAt: isoTime(now), validUntil: isoTime(now + ttlMs), value };
}

const linkTtlMs = (config) => (config.defaults?.linkTtlMinutes ?? DEFAULTS.linkTtlMinutes) * 60_000;
const factTtlMs = (config) => (config.defaults?.factTtlHours ?? DEFAULTS.factTtlHours) * 3_600_000;

function machineByEnvironment(config) {
  const map = new Map();
  for (const [label, m] of Object.entries(config.machines || {})) if (m.environmentId) map.set(m.environmentId, label);
  return map;
}

function entryFor(state, label, environmentId) {
  const cur = hasOwn(state.observations, label) ? state.observations[label] : null;
  if (!isObj(cur) || cur.environmentId !== environmentId) state.observations[label] = { environmentId };
  return state.observations[label];
}

// ---------------------------------------------------------------------------------------------------------------
// Agent observations

function fail(index, tool, message) {
  throw new ObservationError({ ok: false, error: `Record ${index}${tool ? ` (${tool})` : ""}: ${message}`, record: index });
}

function itemsOf(page, key, index, tool, p) {
  if (!isObj(page)) fail(index, tool, `page ${p} is not an object.`);
  const items = page[key];
  if (!Array.isArray(items)) {
    const why = typeof page.error === "string" ? ` T3 reported: ${sanitizeError(page.error)}` : "";
    fail(index, tool, `page ${p} has no ${key} array.${why}`);
  }
  if (items.length > LIMITS.itemsPerPage) fail(index, tool, `page ${p} has more than ${LIMITS.itemsPerPage} ${key}.`);
  return items;
}

/** Parse and bound one observe record into reduced facts, or throw ObservationError. */
function readRecord(rec, index) {
  if (!isObj(rec)) fail(index, null, "is not an object.");
  const tool = rec.tool;
  if (!OBSERVABLE_TOOLS.includes(tool)) fail(index, null, `tool must be one of ${OBSERVABLE_TOOLS.join(", ")}.`);
  const args = rec.args === undefined ? {} : rec.args;
  if (!isObj(args)) fail(index, tool, "args must be an object.");
  const pages = rec.pages;
  if (!Array.isArray(pages) || pages.length === 0) fail(index, tool, "pages must be a non-empty array of raw replies.");
  if (pages.length > LIMITS.pages) fail(index, tool, `has more than ${LIMITS.pages} pages.`);
  let environmentId;
  if (args.environmentId !== undefined) {
    if (typeof args.environmentId !== "string" || !ID_PATTERN.test(args.environmentId)) fail(index, tool, "args.environmentId is invalid.");
    environmentId = args.environmentId;
  }

  if (tool === "t3_environment_links") {
    const links = new Map();
    let seen = 0;
    pages.forEach((page, p) => {
      for (const link of itemsOf(page, "links", index, tool, p)) {
        seen += 1;
        if (!isObj(link) || typeof link.environmentId !== "string" || !ID_PATTERN.test(link.environmentId)) continue;
        if (!links.has(link.environmentId)) {
          links.set(link.environmentId, { ...reduceLink(link), label: typeof link.label === "string" ? link.label.slice(0, LIMITS.string) : null });
        }
      }
    });
    if (seen > 0 && links.size === 0) fail(index, tool, "no link has a readable environmentId.");
    return { tool, links };
  }

  if (tool === "orchestrator_capabilities") {
    const providers = new Set();
    pages.forEach((page, p) => {
      for (const prov of itemsOf(page, "providers", index, tool, p)) {
        if (!isObj(prov) || prov.canRunChildTask !== true) continue;
        if (typeof prov.providerInstanceId !== "string" || !ID_PATTERN.test(prov.providerInstanceId)) continue;
        providers.add(prov.providerInstanceId);
      }
    });
    return { tool, environmentId, providers: [...providers].sort() };
  }

  // t3_project_list
  const last = pages[pages.length - 1];
  if (isObj(last) && last.nextCursor !== undefined && last.nextCursor !== null) {
    fail(index, tool, "the last page still has a nextCursor; follow it and send the complete list.");
  }
  const projects = {};
  pages.forEach((page, p) => {
    for (const proj of itemsOf(page, "projects", index, tool, p)) {
      if (!isObj(proj) || proj.archivedAt || proj.deletedAt) continue;
      if (typeof proj.id !== "string" || !ID_PATTERN.test(proj.id)) continue;
      const key = proj.repositoryIdentity?.canonicalKey;
      if (typeof key !== "string" || key.length === 0 || key.length > LIMITS.repoKey || /[\s\u0000-\u001f]/.test(key)) continue;
      const lower = key.toLowerCase();
      if (lower === "__proto__" || hasOwn(projects, lower)) continue;
      projects[lower] = proj.id;
    }
  });
  return { tool, environmentId, projects };
}

/**
 * Validate every record, then join the reduced facts onto configured machines by environmentId.
 * @returns {{ state: object, updated: string[], ignored: { record: number, tool: string, reason: string }[] }}
 */
export function applyObservationsDetailed(config, state, records, now) {
  if (!Array.isArray(records)) {
    throw new ObservationError({ ok: false, error: "Observations must be a JSON array of { tool, args, pages } records.", record: null });
  }
  if (records.length > LIMITS.records) {
    throw new ObservationError({ ok: false, error: `At most ${LIMITS.records} records per observe call.`, record: null });
  }
  const parsed = records.map((rec, i) => readRecord(rec, i));
  const next = clone(state);
  if (!isObj(next.observations)) next.observations = {};
  const byEnv = machineByEnvironment(config);
  const updated = new Set();
  const ignored = [];

  parsed.forEach((r, i) => {
    if (r.tool === "t3_environment_links") {
      for (const [label, m] of Object.entries(config.machines || {})) {
        const link = r.links.get(m.environmentId);
        const value = link ? { status: link.status, access: link.access, expiresAt: link.expiresAt, lastError: link.lastError } : null;
        entryFor(next, label, m.environmentId).link = envelope("agent", now, linkTtlMs(config), value);
        updated.add(label);
      }
      return;
    }
    if (!r.environmentId) {
      ignored.push({ record: i, tool: r.tool, reason: "No args.environmentId; local needs no provider or project observation." });
      return;
    }
    const label = byEnv.get(r.environmentId);
    if (!label) {
      ignored.push({ record: i, tool: r.tool, reason: "environmentId is not a configured machine." });
      return;
    }
    const entry = entryFor(next, label, r.environmentId);
    if (r.tool === "orchestrator_capabilities") entry.providers = envelope("agent", now, factTtlMs(config), r.providers);
    else entry.projects = envelope("agent", now, factTtlMs(config), r.projects);
    updated.add(label);
  });

  return { state: next, updated: [...updated].sort(), ignored };
}

/** applyObservationsDetailed, returning only the new state. */
export function applyObservations(config, state, records, now) {
  return applyObservationsDetailed(config, state, records, now).state;
}

/**
 * Merge a refreshFacts patch onto (latest, locked) state. For each envelope keep whichever has the newer
 * observedAt, so a slow refresh never overwrites a fact observed after it started. Entries for labels that are
 * gone or whose environmentId changed since the refresh are dropped, as are envelopes already expired at `now`.
 */
export function mergeFactPatch(config, state, patch, now) {
  const next = clone(state);
  if (!isObj(next.observations)) next.observations = {};
  for (const [label, p] of Object.entries(isObj(patch) ? patch : {})) {
    const m = hasOwn(config.machines || {}, label) ? config.machines[label] : null;
    if (!m || !isObj(p) || p.environmentId !== m.environmentId) continue;
    let entry = hasOwn(next.observations, label) ? next.observations[label] : null;
    for (const kind of ENVELOPE_KINDS) {
      const env = p[kind];
      if (!isObj(env) || !Number.isFinite(parseTime(env.observedAt))) continue;
      if (now !== undefined && !(parseTime(env.validUntil) > now)) continue;
      entry = entryFor(next, label, m.environmentId);
      const cur = entry[kind];
      if (!isObj(cur) || !(parseTime(cur.observedAt) >= parseTime(env.observedAt))) entry[kind] = clone(env);
    }
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Router-read facts: t3 CLI and HTTPS probe

/** Path of an executable `t3` on PATH, or null. */
export function findT3(envPath = process.env.PATH || "") {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "t3");
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

function resolveT3(opts) {
  if (opts.t3Bin === false) return null;
  if (typeof opts.t3Bin === "string") return opts.t3Bin;
  return findT3();
}

/**
 * Parse `t3 environment list --json`. Only the v0.1.13 command's existence is verified, not its exact output, so
 * this accepts a bare array or an object wrapping one (environments, links, items, data), and the field spellings
 * environmentId|id|environment_id, label|name|displayName, expiresAt|expires_at, lastError|last_error|error.
 * @returns {{ environmentId: string, label: string|null, status, access, expiresAt, lastError }[]}
 */
export function parseT3EnvironmentList(text) {
  const data = JSON.parse(text);
  let list = Array.isArray(data) ? data : null;
  if (!list && isObj(data)) {
    for (const k of ["environments", "links", "items", "data"]) {
      if (Array.isArray(data[k])) {
        list = data[k];
        break;
      }
    }
  }
  if (!list) throw new Error("Unrecognized t3 environment list output.");
  const outList = [];
  const entries = list.slice(0, LIMITS.itemsPerPage);
  for (const e of entries) {
    if (!isObj(e)) continue;
    const environmentId = e.environmentId ?? e.id ?? e.environment_id;
    if (typeof environmentId !== "string" || !ID_PATTERN.test(environmentId)) continue;
    const label = e.label ?? e.name ?? e.displayName;
    outList.push({
      environmentId,
      label: typeof label === "string" ? label.slice(0, LIMITS.string) : null,
      ...reduceLink({
        status: e.status ?? e.state,
        access: e.access,
        expiresAt: e.expiresAt ?? e.expires_at,
        lastError: e.lastError ?? e.last_error ?? e.error,
      }),
    });
  }
  // A non-empty list with no readable ID means the output shape is not understood; absent links would be wrong.
  if (entries.length > 0 && outList.length === 0) throw new Error("No entry in t3 environment list output had a readable environment ID.");
  return outList;
}

/** Run the t3 CLI's link listing. Resolves { ok, links? , error? }; never rejects. */
export function readT3Links(t3Bin, { timeoutMs = DEFAULT_T3_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      t3Bin,
      ["environment", "list", "--json"],
      { timeout: timeoutMs, maxBuffer: LIMITS.t3OutputBytes, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout) => {
        if (err) {
          const why = err.killed ? `timed out after ${timeoutMs} ms` : err.code === "ENOENT" ? "not found" : `failed (${sanitizeError(err.message)})`;
          resolve({ ok: false, error: `t3 environment list ${why}.` });
          return;
        }
        try {
          resolve({ ok: true, links: parseT3EnvironmentList(stdout) });
        } catch (parseErr) {
          resolve({ ok: false, error: `t3 environment list output was not usable: ${sanitizeError(parseErr.message)}` });
        }
      },
    );
  });
}

/**
 * Bounded HTTPS GET. Redirects are not followed and the body is discarded. Resolves
 * { ok: boolean, status?, error? }: ok is true when an HTTP status below 500 arrives within timeoutMs.
 */
export async function probeUrl(url, { fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
  if (u.protocol !== "https:" || u.username || u.password) return { ok: false, error: "Probe URL must be credential-free https." };
  if (typeof fetchImpl !== "function") return { ok: false, error: "No fetch implementation available." };
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ ok: false, error: `Timed out after ${timeoutMs} ms.` });
    }, timeoutMs);
  });
  const attempt = (async () => {
    try {
      const res = await fetchImpl(u.href, { method: "GET", redirect: "manual", signal: ac.signal, headers: { accept: "*/*" } });
      try {
        await res.body?.cancel?.();
      } catch {
        // body already closed
      }
      const status = Number(res.status);
      return { ok: Number.isInteger(status) && status > 0 && status < 500, status };
    } catch (err) {
      return { ok: false, error: ac.signal.aborted ? `Timed out after ${timeoutMs} ms.` : sanitizeError(err?.message) || "Request failed." };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const fresh = (env, now) => isObj(env) && parseTime(env.validUntil) > now;

/**
 * Read link facts (t3 CLI) and probe results for machines whose cached facts are missing or stale.
 * @returns {Promise<{ patch: object, t3: { available: boolean, ok?: boolean, error?: string }, probes: object }>}
 */
export async function refreshFactsDetailed(config, state, now, opts = {}) {
  const machines = Object.entries(config.machines || {}).filter(([label]) => !opts.labels || opts.labels.includes(label));
  const observations = isObj(state?.observations) ? state.observations : {};
  const current = (label, envId) => {
    const o = hasOwn(observations, label) ? observations[label] : null;
    return isObj(o) && o.environmentId === envId ? o : {};
  };
  const patch = {};
  const put = (label, envId, kind, env) => {
    if (!hasOwn(patch, label)) patch[label] = { environmentId: envId };
    patch[label][kind] = env;
  };

  const needLink = machines.filter(([label, m]) => opts.force || !fresh(current(label, m.environmentId).link, now));
  const t3 = { available: false };
  if (needLink.length > 0) {
    const bin = resolveT3(opts);
    if (bin) {
      t3.available = true;
      const read = await readT3Links(bin, { timeoutMs: opts.t3TimeoutMs });
      t3.ok = read.ok;
      if (read.ok) {
        const byEnv = new Map(read.links.map((l) => [l.environmentId, l]));
        for (const [label, m] of needLink) {
          const l = byEnv.get(m.environmentId);
          const value = l ? { status: l.status, access: l.access, expiresAt: l.expiresAt, lastError: l.lastError } : null;
          put(label, m.environmentId, "link", envelope("t3-cli", now, linkTtlMs(config), value));
        }
      } else t3.error = read.error;
    }
  }

  const probes = {};
  const needProbe = machines.filter(([label, m]) => m.url && (opts.force || !fresh(current(label, m.environmentId).probe, now)));
  await Promise.all(
    needProbe.map(async ([label, m]) => {
      const r = await probeUrl(m.url, { fetch: opts.fetch, timeoutMs: opts.probeTimeoutMs });
      probes[label] = r;
      put(label, m.environmentId, "probe", envelope("https", now, linkTtlMs(config), r.ok));
    }),
  );
  return { patch, t3, probes };
}

/** refreshFactsDetailed, returning only the patch. */
export async function refreshFacts(config, state, now, opts = {}) {
  return (await refreshFactsDetailed(config, state, now, opts)).patch;
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery

/** Turn a T3 link label into a valid router label (lowercase, A-Z a-z 0-9 . _ -). */
export function proposeLabel(t3Label, environmentId) {
  let s = typeof t3Label === "string" ? t3Label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "") : "";
  s = s.slice(0, 64).replace(/-+$/, "");
  if (!LABEL_PATTERN.test(s)) s = `box-${environmentId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "unnamed"}`;
  return s;
}

/**
 * Propose inventory rows from link facts. Uses `t3 environment list --json` when the t3 binary is found, otherwise
 * opts.records (a t3_environment_links record, or an array of them, in the observe format). config may be null
 * before init. Writes nothing.
 */
export async function discover(config, opts = {}) {
  const machines = config?.machines || {};
  let links = null;
  let source = null;
  const warnings = [];
  const bin = resolveT3(opts);
  if (bin) {
    const read = await readT3Links(bin, { timeoutMs: opts.t3TimeoutMs });
    if (read.ok) {
      links = read.links;
      source = "t3-cli";
    } else warnings.push(read.error);
  }
  if (!links && opts.records !== undefined) {
    const records = Array.isArray(opts.records) ? opts.records : [opts.records];
    let parsed;
    try {
      parsed = records.map((r, i) => readRecord(r, i));
    } catch (err) {
      if (err instanceof ObservationError) return err.result;
      throw err;
    }
    const bad = parsed.findIndex((r) => r.tool !== "t3_environment_links");
    if (bad >= 0) return { ok: false, error: `Record ${bad}: discover reads only t3_environment_links records.`, record: bad };
    const merged = new Map();
    for (const r of parsed) for (const [id, l] of r.links) if (!merged.has(id)) merged.set(id, { environmentId: id, ...l });
    links = [...merged.values()];
    source = "agent";
  }
  if (!links) {
    return {
      ok: false,
      error: "No link facts: the t3 CLI is unavailable. Read t3_environment_links and pass the record to discover on stdin.",
      needsObservation: { calls: [{ tool: "t3_environment_links", args: {} }], observe: "box-router discover" },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const configuredByEnv = new Map(Object.entries(machines).map(([label, m]) => [m.environmentId, label]));
  const linkByEnv = new Map(links.map((l) => [l.environmentId, l]));
  const configured = Object.entries(machines).map(([label, m]) => {
    const l = linkByEnv.get(m.environmentId);
    const issues = [];
    if (!l) issues.push("No T3 link for this environmentId.");
    else if (l.label && l.label !== label) issues.push(`T3 calls this link ${JSON.stringify(l.label)}; the swarm viewer shows T3's label.`);
    return { label, environmentId: m.environmentId, t3Label: l?.label ?? null, linked: Boolean(l), status: l?.status ?? null, issues };
  });

  const taken = new Map(Object.keys(machines).map((l) => [l.toLowerCase(), "a configured machine"]));
  const proposed = [];
  for (const l of links) {
    if (configuredByEnv.has(l.environmentId)) continue;
    const label = proposeLabel(l.label, l.environmentId);
    const issues = [];
    if (l.label !== label) issues.push(`Label adjusted from T3's ${JSON.stringify(l.label)}.`);
    if (RESERVED_LABELS.includes(label)) issues.push(`Label ${label} is reserved; choose another.`);
    if (taken.has(label)) issues.push(`Label ${label} is already used by ${taken.get(label)}; choose another.`);
    else taken.set(label, "another proposed row");
    if (l.status !== "reachable") issues.push(`Link status is ${l.status ?? "unknown"}, not reachable.`);
    proposed.push({
      label,
      environmentId: l.environmentId,
      t3Label: l.label,
      status: l.status,
      access: l.access,
      expiresAt: l.expiresAt,
      lastError: l.lastError,
      machine: { kind: "always-on", environmentId: l.environmentId, tags: [], priority: 10, maxConcurrent: 2 },
      issues,
    });
  }
  return {
    ok: true,
    source,
    proposed,
    configured,
    next: "Confirm each proposed row's label, tags, SSH and access needs, priority and capacity with the user before writing config.",
    ...(warnings.length ? { warnings } : {}),
  };
}
