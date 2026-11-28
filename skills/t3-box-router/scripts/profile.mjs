/**
 * t3-box-router profiles: machine hardware and toolchain profiles, and the discovered-links cache that finds
 * newly linked boxes nobody has profiled yet (Node 18+, built-in modules only, no I/O).
 *
 * A profile is the sanitized output of scripts/probe.mjs, stored in config.json as machines.<label>.profile (or
 * local.profile) by `apply-probe`. It never overwrites a user field: config validation derives
 *   tags          = (tags ∪ profile tags ∪ extraTags) − denyTags
 *   maxConcurrent = explicit value, else derived from cores and RAM, else the default
 *   priority      = explicit value, else 10 for a remote box and 0 for local
 * so a re-probe updates the derived values while every explicit setting stays as the user wrote it.
 * `profile: false` on a machine opts it out of probing and of the unprofiledBoxes report.
 *
 * Credentials: the probe never looks for credentials, environment files or key stores. A `cred:<name>` or
 * `secret:<name>` tag can only come from an owner-declared attestation whose value is strictly true or false.
 * Validation errors name fields, never the rejected values, so malformed input is not echoed.
 *
 * Discovered links (state.discovered) hold the last complete link read, from the t3 CLI or an agent's
 * t3_environment_links observation, including links that name no configured machine:
 *   { source, observedAt, validUntil, links: { <environmentId>: { label, status, urls } } }
 * unprofiledBoxes() joins that with config to list linked boxes without a fresh profile. It is informational:
 * it never blocks a placement or changes `ok`.
 */

export const PROBE_KIND = "t3-box-router-probe";
export const PROBE_VERSION = 1;
export const PROFILE_DEFAULTS = Object.freeze({ probeTtlDays: 7 });
export const PROFILE_DEFAULT_KEYS = Object.freeze(Object.keys(PROFILE_DEFAULTS));
/** Key under which box-router passes a discovery read through a fact patch. Never a valid machine label. */
export const DISCOVERY_PATCH_KEY = "@links";
export const TOOL_KEYS = Object.freeze(["xcode", "ios-sim", "android-sdk", "godot", "docker", "gh"]);
export const ATTESTATION_PATTERN = /^(?:cred|secret):[a-z0-9][a-z0-9._-]{0,56}$/;
export const LIMITS = Object.freeze({ cpuCores: 4096, ramGb: 65536, gpuCount: 64, attestations: 32, urls: 4, url: 200, label: 200 });

const OS_VALUES = new Set(["macos", "linux", "windows"]);
const ARCH_VALUES = new Set(["x64", "arm64", "arm"]);
const GPU_VENDORS = new Set(["nvidia", "amd", "intel", "apple", "other"]);
const COMPUTE_GPU_VENDORS = new Set(["nvidia", "amd"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const URL_PROTOCOLS = new Set(["https:", "http:", "wss:", "ws:"]);
const URL_FIELDS = ["url", "urls", "httpUrl", "httpBaseUrl", "baseUrl", "serverUrl", "remoteUrl", "wsUrl", "websocketUrl", "endpoint", "endpoints"];
const RAM_SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];
const DAY_MS = 86_400_000;
const CLOCK_SKEW_MS = 5 * 60_000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isoTime = (ms) => new Date(ms).toISOString();
const parseTime = (v) => (typeof v === "string" && v.length <= 64 ? Date.parse(v) : NaN);

// ---------------------------------------------------------------------------------------------------------------
// Probe reports and stored profiles

const REPORT_FIELDS = new Set(["ok", "kind", "version", "probedAt", "os", "arch", "cpuCores", "ramGb", "gpu", "display", "tools", "attestations"]);
const STORED_FIELDS = new Set(["environmentId", "profiledAt", "os", "arch", "cpuCores", "ramGb", "gpu", "display", "tools", "attestations"]);

/**
 * Check and reduce the hardware fields shared by a probe report and a stored profile. Pushes field paths (never
 * values) onto `problems`. Returns { facts, ignored } where ignored counts dropped unknown keys.
 */
function readFacts(raw, problems) {
  let ignored = 0;
  const facts = {};
  if (OS_VALUES.has(raw.os)) facts.os = raw.os;
  else problems.push("os");
  if (ARCH_VALUES.has(raw.arch)) facts.arch = raw.arch;
  else problems.push("arch");
  if (Number.isInteger(raw.cpuCores) && raw.cpuCores >= 1 && raw.cpuCores <= LIMITS.cpuCores) facts.cpuCores = raw.cpuCores;
  else problems.push("cpuCores");
  if (typeof raw.ramGb === "number" && Number.isFinite(raw.ramGb) && raw.ramGb > 0 && raw.ramGb <= LIMITS.ramGb) {
    facts.ramGb = Math.round(raw.ramGb * 10) / 10;
  } else problems.push("ramGb");

  const gpu = raw.gpu === undefined ? { count: 0, vendor: null } : raw.gpu;
  if (!isObj(gpu)) problems.push("gpu");
  else {
    for (const k of Object.keys(gpu)) if (k !== "count" && k !== "vendor") ignored++;
    const count = gpu.count === undefined ? 0 : gpu.count;
    const vendor = gpu.vendor === undefined ? null : gpu.vendor;
    if (!Number.isInteger(count) || count < 0 || count > LIMITS.gpuCount) problems.push("gpu.count");
    if (vendor !== null && !GPU_VENDORS.has(vendor)) problems.push("gpu.vendor");
    facts.gpu = { count: Number.isInteger(count) ? count : 0, vendor: count > 0 && GPU_VENDORS.has(vendor) ? vendor : null };
  }

  const display = raw.display === undefined ? { native: false, virtual: false } : raw.display;
  if (!isObj(display)) problems.push("display");
  else {
    for (const k of Object.keys(display)) if (k !== "native" && k !== "virtual") ignored++;
    for (const k of ["native", "virtual"]) if (display[k] !== undefined && typeof display[k] !== "boolean") problems.push(`display.${k}`);
    facts.display = { native: display.native === true, virtual: display.virtual === true };
  }

  const tools = raw.tools === undefined ? {} : raw.tools;
  if (!isObj(tools)) problems.push("tools");
  else {
    facts.tools = {};
    for (const k of Object.keys(tools)) if (!TOOL_KEYS.includes(k)) ignored++;
    for (const k of TOOL_KEYS) {
      if (tools[k] !== undefined && typeof tools[k] !== "boolean") problems.push(`tools.${k}`);
      facts.tools[k] = tools[k] === true;
    }
  }

  const att = readAttestations(raw.attestations);
  if (att.problem) problems.push(att.problem);
  else if (Object.keys(att.value).length) facts.attestations = att.value;
  return { facts, ignored };
}

/**
 * Owner-declared credential capabilities: { "secret:<name>": true|false, "cred:<name>": true|false }. Values must
 * be strictly boolean and names must match ATTESTATION_PATTERN. Any bad entry rejects the whole set, and the
 * problem names only how many entries were bad.
 */
export function readAttestations(raw) {
  if (raw === undefined || raw === null) return { value: {} };
  if (!isObj(raw)) return { problem: "attestations (must be an object of cred:<name> or secret:<name> to true or false)" };
  const keys = Object.keys(raw);
  if (keys.length > LIMITS.attestations) return { problem: `attestations (at most ${LIMITS.attestations} entries)` };
  let bad = 0;
  const value = {};
  for (const k of keys) {
    if (!ATTESTATION_PATTERN.test(k) || typeof raw[k] !== "boolean") bad++;
    else value[k] = raw[k];
  }
  if (bad) {
    return {
      problem: `attestations (${bad} invalid entr${bad === 1 ? "y" : "ies"}; names must be cred:<name> or secret:<name> in lowercase and values strictly true or false)`,
    };
  }
  return { value: Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) };
}

/**
 * Validate a probe report (scripts/probe.mjs output, possibly wrapped by `box-router probe` with ok: true).
 * @returns {{ ok: true, probe: object, ignored: number } | { ok: false, error: string, fields: string[] }}
 */
export function sanitizeProbe(raw) {
  if (!isObj(raw)) return { ok: false, error: "The probe report must be a JSON object.", fields: [] };
  const problems = [];
  let ignored = 0;
  for (const k of Object.keys(raw)) if (!REPORT_FIELDS.has(k)) ignored++;
  if (raw.kind !== PROBE_KIND) problems.push("kind");
  if (raw.version !== PROBE_VERSION) problems.push("version");
  if (raw.ok !== undefined && raw.ok !== true) problems.push("ok");
  const read = readFacts(raw, problems);
  ignored += read.ignored;
  if (problems.length) {
    return { ok: false, error: `The probe report was rejected. Invalid or missing fields: ${problems.join(", ")}.`, fields: problems };
  }
  return { ok: true, probe: read.facts, ignored };
}

/** Build the profile stored in config from a sanitized probe. environmentId is omitted for local. */
export function buildProfile(probe, { environmentId, now }) {
  return {
    ...(environmentId ? { environmentId } : {}),
    profiledAt: isoTime(now),
    ...probe,
  };
}

/**
 * Read a profile from config (users may edit it). Returns { profile } (null when absent), { optOut: true } for
 * `profile: false`, or { problem } describing which fields are wrong; the caller warns and ignores it.
 */
export function readStoredProfile(raw, { environmentId } = {}) {
  if (raw === undefined) return { profile: null };
  if (raw === false) return { profile: null, optOut: true };
  if (!isObj(raw)) return { profile: null, problem: "must be an object written by apply-probe, or false to opt out of probing" };
  const problems = [];
  const read = readFacts(raw, problems);
  const profiledAt = parseTime(raw.profiledAt);
  if (!Number.isFinite(profiledAt)) problems.push("profiledAt");
  if (raw.environmentId !== undefined && (typeof raw.environmentId !== "string" || !ID_RE.test(raw.environmentId))) problems.push("environmentId");
  if (problems.length) return { profile: null, problem: `is invalid and ignored (fields: ${problems.join(", ")}); run the probe and apply-probe again` };
  if (environmentId && raw.environmentId !== undefined && raw.environmentId !== environmentId) {
    return { profile: null, problem: "was probed on a different environmentId and is ignored; probe this machine again" };
  }
  for (const k of Object.keys(raw)) if (!STORED_FIELDS.has(k)) read.ignored++;
  return {
    profile: { ...(raw.environmentId !== undefined ? { environmentId: raw.environmentId } : {}), profiledAt: isoTime(profiledAt), ...read.facts },
  };
}

/** Nominal RAM size for a total that the OS reports a little below it (31.2 GiB -> 32). */
export function nominalRamGb(ramGb) {
  for (const size of RAM_SIZES) if (ramGb <= size * 1.02) return size;
  return Math.pow(2, Math.ceil(Math.log2(ramGb)));
}

/** Tags a profile provides. Credential tags come only from attestations that are true. */
export function profileTags(profile) {
  if (!isObj(profile)) return [];
  const tags = [profile.os, profile.arch];
  const gpu = profile.gpu || {};
  if (gpu.count > 0) {
    if (COMPUTE_GPU_VENDORS.has(gpu.vendor)) tags.push("gpu");
    if (gpu.vendor) tags.push(`gpu-${gpu.vendor}`);
  }
  if (Number.isFinite(profile.ramGb)) tags.push(`ram-${nominalRamGb(profile.ramGb)}g`);
  if (profile.display?.native || profile.display?.virtual) tags.push("display");
  if (profile.display?.virtual) tags.push("virtual-display");
  for (const k of TOOL_KEYS) if (profile.tools?.[k] === true) tags.push(k);
  for (const [k, v] of Object.entries(profile.attestations || {})) if (v === true && ATTESTATION_PATTERN.test(k)) tags.push(k);
  return [...new Set(tags.filter((t) => typeof t === "string" && TAG_RE.test(t)))];
}

/**
 * Capacity defaults from a profile: one slot per two cores and per 4 GB of RAM, whichever is smaller, from 1 to
 * 8. Priority 10 for a remote box, 0 for local. Explicit config values always win over these.
 */
export function deriveCapacity(profile, { remote }) {
  const priority = remote ? 10 : 0;
  if (!isObj(profile)) return { priority };
  const byCores = Math.floor((profile.cpuCores || 0) / 2);
  const byRam = Math.floor((profile.ramGb || 0) / 4);
  return { priority, maxConcurrent: Math.min(8, Math.max(1, Math.min(byCores, byRam))) };
}

/** (explicit ∪ profile ∪ extra) − deny, in first-seen order. */
export function mergeTags(explicit = [], fromProfile = [], extra = [], deny = []) {
  const denied = new Set(deny);
  return [...new Set([...explicit, ...fromProfile, ...extra])].filter((t) => !denied.has(t));
}

export function profileTtlMs(config) {
  const days = Number(config?.defaults?.probeTtlDays);
  return (days > 0 ? days : PROFILE_DEFAULTS.probeTtlDays) * DAY_MS;
}

/** True when a profile belongs to this environment and is younger than the TTL (and not from the future). */
export function profileFresh(profile, environmentId, now, ttlMs) {
  if (!isObj(profile)) return false;
  if (environmentId && profile.environmentId !== undefined && profile.environmentId !== environmentId) return false;
  const at = parseTime(profile.profiledAt);
  return Number.isFinite(at) && at <= now + CLOCK_SKEW_MS && at + ttlMs > now;
}

/**
 * Merge a sanitized probe into the raw (user-written) config, touching only the target's `profile` field (and
 * creating the machine entry for a new box). Pure: returns a new object.
 *   target         "local" or a machine label
 *   environmentId  required for a new machine; must match an existing machine's
 * @returns {{ ok: true, config, created, environmentId, preserved: string[] } | { ok: false, error }}
 */
export function mergeProbeIntoRawConfig(rawConfig, { target, environmentId, probe, now }) {
  if (!isObj(rawConfig)) return { ok: false, error: "config.json is not a JSON object." };
  const raw = JSON.parse(JSON.stringify(rawConfig));
  const preservedOf = (entry) => ["tags", "extraTags", "denyTags", "priority", "maxConcurrent", "exclusive"].filter((k) => entry[k] !== undefined);

  if (target === "local") {
    if (environmentId) return { ok: false, error: "local takes no --environment-id." };
    if (raw.local !== undefined && !isObj(raw.local)) return { ok: false, error: "config.local must be an object." };
    raw.local = raw.local || {};
    raw.local.profile = buildProfile(probe, { now });
    return { ok: true, config: raw, created: false, environmentId: null, preserved: preservedOf(raw.local) };
  }

  if (raw.machines !== undefined && !isObj(raw.machines)) return { ok: false, error: "config.machines must be an object." };
  raw.machines = raw.machines || {};
  const machines = raw.machines;
  let created = false;
  let env;
  if (hasOwn(machines, target)) {
    const m = machines[target];
    if (!isObj(m)) return { ok: false, error: `config.machines.${target} must be an object.` };
    env = m.environmentId;
    if (typeof env !== "string" || !ID_RE.test(env)) return { ok: false, error: `config.machines.${target} has no valid environmentId.` };
    if (environmentId && environmentId !== env) {
      return { ok: false, error: `Machine ${target} is configured with a different environmentId. Probe the right box or fix config first.` };
    }
  } else {
    const lower = target.toLowerCase();
    const clash = Object.keys(machines).find((l) => l.toLowerCase() === lower);
    if (clash) return { ok: false, error: `Label ${target} collides with configured machine ${clash} (labels are case-insensitive).` };
    if (!environmentId) return { ok: false, error: `No machine labelled ${target}. To add a newly linked box, pass --environment-id from unprofiledBoxes.` };
    const owner = Object.entries(machines).find(([, m]) => isObj(m) && m.environmentId === environmentId);
    if (owner) return { ok: false, error: `That environmentId is already configured as ${owner[0]}. Apply the probe to ${owner[0]}.` };
    env = environmentId;
    machines[target] = { kind: "always-on", environmentId: env };
    created = true;
  }
  const entry = machines[target];
  const preserved = preservedOf(entry);
  entry.profile = buildProfile(probe, { environmentId: env, now });
  return { ok: true, config: raw, created, environmentId: env, preserved };
}

// ---------------------------------------------------------------------------------------------------------------
// Link URLs and the discovered-links cache

/** Credential-free origins (scheme://host[:port]) from a raw T3 link entry, at most LIMITS.urls. */
export function linkUrls(link) {
  if (!isObj(link)) return [];
  const raw = [];
  for (const f of URL_FIELDS) {
    if (!hasOwn(link, f)) continue;
    const v = link[f];
    if (typeof v === "string") raw.push(v);
    else if (Array.isArray(v)) raw.push(...v.slice(0, 16));
    else if (isObj(v)) raw.push(...Object.values(v).slice(0, 16));
  }
  const out = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.length > 2048) continue;
    let u;
    try {
      u = new URL(v);
    } catch {
      continue;
    }
    if (!URL_PROTOCOLS.has(u.protocol) || !u.hostname) continue;
    const origin = `${u.protocol}//${u.host}`;
    if (origin.length <= LIMITS.url && !out.includes(origin)) out.push(origin);
    if (out.length >= LIMITS.urls) break;
  }
  return out;
}

const shortStatus = (v) => (typeof v === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : v == null ? null : "unrecognized");

/**
 * An envelope for one complete link read. links: [{ environmentId, label, status, urls }] (as parsed by facts).
 */
export function discoveryEnvelope(source, links, now, ttlMs) {
  const byEnv = {};
  for (const l of Array.isArray(links) ? links : []) {
    if (!isObj(l) || typeof l.environmentId !== "string" || !ID_RE.test(l.environmentId) || hasOwn(byEnv, l.environmentId)) continue;
    byEnv[l.environmentId] = {
      label: typeof l.label === "string" ? l.label.slice(0, LIMITS.label) : null,
      status: shortStatus(l.status),
      urls: Array.isArray(l.urls) ? l.urls.filter((u) => typeof u === "string").slice(0, LIMITS.urls) : [],
    };
  }
  return { source, observedAt: isoTime(now), validUntil: isoTime(now + ttlMs), links: byEnv };
}

/** Store a discovery envelope unless the state already holds a newer one. Returns a new state object. */
export function recordDiscovered(state, envelope) {
  if (!isObj(envelope) || !isObj(envelope.links)) return state;
  const cur = state?.discovered;
  if (isObj(cur) && parseTime(cur.observedAt) > parseTime(envelope.observedAt)) return state;
  return { ...state, discovered: envelope };
}

/** Drop an expired or malformed discovery envelope in place. Returns true when anything changed. */
export function pruneDiscovered(state, now) {
  if (!hasOwn(state, "discovered")) return false;
  const d = state.discovered;
  if (isObj(d) && isObj(d.links) && parseTime(d.validUntil) > now) return false;
  delete state.discovered;
  return true;
}

export function discoveryStale(state, now) {
  const d = state?.discovered;
  return !(isObj(d) && isObj(d.links) && parseTime(d.validUntil) > now);
}

/**
 * Linked boxes without a fresh profile, for place, acquire and list. Never blocks anything.
 *   reason "new"         linked in T3 but not in config (apply-probe <label> --environment-id adds it)
 *          "unprofiled"  configured, never profiled
 *          "stale"       configured, profile older than defaults.probeTtlDays (7) or from another environment
 * Sources: the fresh discovery envelope, plus every configured machine with a fresh link observation that found
 * its link. Revoked links are skipped (they need relinking, not probing). Machines with `profile: false` are
 * skipped. proposeLabel(t3Label, environmentId) turns a T3 label into a valid router label for new boxes.
 * @returns {{ environmentId, label, urls, reason }[]} sorted by label
 */
export function unprofiledBoxes({ config, state, now, proposeLabel = (l, id) => l || id }) {
  const machines = isObj(config?.machines) ? config.machines : {};
  const ttl = profileTtlMs(config);
  const byEnv = new Map();
  for (const [label, m] of Object.entries(machines)) if (isObj(m) && m.environmentId) byEnv.set(m.environmentId, label);
  const seen = new Map();
  const consider = (environmentId, t3Label, status, urls) => {
    if (["expired", "missing", "removed", "revoked", "unlinked"].includes(status)) return;
    const prev = seen.get(environmentId);
    if (prev) {
      for (const u of urls) if (!prev.urls.includes(u) && prev.urls.length < LIMITS.urls) prev.urls.push(u);
      return;
    }
    const label = byEnv.get(environmentId);
    let reason;
    if (label === undefined) reason = "new";
    else {
      const m = machines[label];
      if (m.profile === false) return;
      if (!isObj(m.profile)) reason = "unprofiled";
      else if (!profileFresh(m.profile, environmentId, now, ttl)) reason = "stale";
      else return;
    }
    const all = [...urls];
    if (label !== undefined && typeof machines[label].url === "string") {
      for (const u of linkUrls({ url: machines[label].url })) if (!all.includes(u)) all.push(u);
    }
    seen.set(environmentId, { environmentId, label: label ?? proposeLabel(t3Label, environmentId), urls: all.slice(0, LIMITS.urls), reason });
  };

  const d = state?.discovered;
  if (!discoveryStale(state, now)) {
    for (const [environmentId, l] of Object.entries(d.links)) {
      if (!ID_RE.test(environmentId) || !isObj(l)) continue;
      consider(environmentId, l.label, l.status, Array.isArray(l.urls) ? l.urls.filter((u) => typeof u === "string") : []);
    }
  }
  for (const [label, m] of Object.entries(machines)) {
    const obs = state?.observations?.[label];
    const link = obs?.link;
    if (!isObj(obs) || obs.environmentId !== m?.environmentId || !isObj(link) || !(parseTime(link.validUntil) > now)) continue;
    if (!isObj(link.value)) continue; // a complete read found no link: unlinked, nothing to probe
    consider(m.environmentId, label, link.value.status, []);
  }
  // Two links may advertise the same display name. Every suggested label must work with apply-probe.
  const taken = new Set(["local", "box", ...Object.keys(machines).map((label) => label.toLowerCase())]);
  for (const box of [...seen.values()].sort((a, b) => a.environmentId.localeCompare(b.environmentId))) {
    if (box.reason !== "new") continue;
    const base = box.label;
    for (let n = 2; taken.has(box.label.toLowerCase()); n++) {
      const suffix = `-${n}`;
      box.label = base.slice(0, 64 - suffix.length) + suffix;
    }
    taken.add(box.label.toLowerCase());
  }
  return [...seen.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
