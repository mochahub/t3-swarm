/**
 * t3-box-router store: configuration and locked state (Node 18+, built-in modules only).
 *
 * Files in the router home (default ~/.t3/boxes, or T3_BOXES_HOME):
 *   config.json   written by the user or `init`; the CLI only reads it.
 *   state.json    written only by `transaction`, atomically, under state.lock.
 *   state.lock    exclusive-create lock file holding the owner's token.
 * The directory is mode 0700 and the files 0600.
 *
 * Error convention, shared by every export below:
 *   - Expected failures (missing or invalid config, lock timeout, write failure, corrupt state) are reported as a
 *     JSON-ready envelope `{ ok: false, error, ...details }`. `init` and `transaction` return that envelope;
 *     `loadConfig` throws a `StoreError` whose `.result` is that envelope.
 *   - Programming errors (a non-function `fn`, an async `fn`, `fn` throwing) propagate as ordinary exceptions,
 *     after the lock is released and without writing state.
 *
 * Main API (callers may await every call; the work itself is synchronous apart from lock waiting):
 *   init(home, proposedConfig?)          -> { ok, created, home, configPath, statePath, ... }
 *   loadConfig(home)                     -> validated config with defaults applied (throws StoreError)
 *   transaction(home, config, fn, opts?) -> fn's `result`, or an error envelope
 *       fn(state, now) must be synchronous and return { state, result }. `state` is the reloaded and pruned
 *       state; `now` is epoch milliseconds. Return `state: undefined` to keep the pruned state.
 *
 *   readState(home, config, now?)       -> lock-free pruned snapshot, for refreshFacts outside the lock
 *
 * Helpers: resolveHome, homePaths, validateConfig, inspectConfig, defaultConfig, emptyState, normalizeState,
 * pruneState, acquireLock, releaseLock, localPlatformTags, isoTime, parseTime, StoreError, validation patterns.
 *
 * Config maps (machines, repos) are plain objects and labels such as `constructor` are valid: look up any
 * caller-supplied label with Object.hasOwn, never `config.machines[label]` alone.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 1;
export const STATE_VERSION = 1;

export const DEFAULTS = Object.freeze({
  minLinkHours: 24,
  linkTtlMinutes: 15,
  factTtlHours: 24,
  slotTtlMinutes: 180,
  leaseTtlHours: 24,
  cooldownMinutes: 30,
  affinityTtlMinutes: 120,
});

/**
 * Bring-up hook bounds. Kept out of DEFAULTS so `init` writes the same config as before; config.defaults gets
 * these keys only when the user sets them.
 */
export const BRINGUP_LIMITS = Object.freeze({ minTimeoutMs: 1000, maxTimeoutMs: 600_000, defaultTimeoutMs: 120_000, defaultRetryMinutes: 10 });
const BRINGUP_DEFAULT_KEYS = ["bringUpTimeoutMs", "bringUpRetryMinutes"];

export const LOCAL_DEFAULTS = Object.freeze({ priority: 0, weight: 1, maxConcurrent: 4 });
export const MACHINE_DEFAULTS = Object.freeze({ kind: "always-on", priority: 10, weight: 1, maxConcurrent: 2, worktreeRoot: "~/work", renew: "manual" });

export const RESERVED_LABELS = Object.freeze(["local", "box"]);
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** IDs that come from T3 (environment, provider, project). Starts alphanumeric, so never `__proto__`. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
export const WORKTREE_ROOT_PATTERN = /^~?[A-Za-z0-9._/-]+$/;
export const SCRIPT_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
export const SSH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;

const STALE_LOCK_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export class StoreError extends Error {
  constructor(result) {
    super(result.error);
    this.name = "StoreError";
    this.result = result;
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function resolveHome(env = process.env) {
  return env.T3_BOXES_HOME ? path.resolve(env.T3_BOXES_HOME) : path.join(os.homedir(), ".t3", "boxes");
}

export function homePaths(home) {
  return {
    home,
    config: path.join(home, "config.json"),
    state: path.join(home, "state.json"),
    lock: path.join(home, "state.lock"),
  };
}

export function isoTime(ms) {
  return new Date(ms).toISOString();
}

/** Epoch ms for an ISO string, or NaN when absent or unparseable. */
export function parseTime(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/** OS and architecture tags for the caller's machine, from Node's `os`. */
export function localPlatformTags(platform = os.platform(), arch = os.arch()) {
  const osTag = { darwin: "macos", linux: "linux", win32: "windows" }[platform] || platform;
  const archTag = { x64: "x64", arm64: "arm64", arm: "arm" }[arch] || arch;
  return [osTag, archTag].filter((t) => TAG_PATTERN.test(t));
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    allowProjectOverride: false,
    defaults: { ...DEFAULTS },
    local: { tags: localPlatformTags(), priority: LOCAL_DEFAULTS.priority, maxConcurrent: LOCAL_DEFAULTS.maxConcurrent, exclusive: [] },
    machines: {},
    repos: {},
  };
}

export function emptyState() {
  return { version: STATE_VERSION, observations: {}, health: {}, leases: {}, slots: {} };
}

// ---------------------------------------------------------------------------------------------------------------
// Config validation

const PHASE2_MACHINE_FIELDS = ["checks"];
const PHASE2_REPO_FIELDS = ["priority", "maxConcurrent", "allowWorktreeScripts"];
const KNOWN_TOP = new Set(["version", "scriptPath", "allowProjectOverride", "defaults", "local", "machines", "repos"]);
const KNOWN_LOCAL = new Set(["tags", "deviceHostId", "priority", "weight", "maxConcurrent", "exclusive"]);
const KNOWN_MACHINE = new Set([
  "kind", "environmentId", "url", "ssh", "tags", "deviceHostId", "priority", "weight", "maxConcurrent", "exclusive",
  "worktreeRoot", "renew", "bringUp", "bringUpTimeoutMs", "checks",
]);
const KNOWN_REPO = new Set(["needs", "prefers", "deny", "pin", "priority", "maxConcurrent", "worktreeCommand", "allowWorktreeScripts"]);

function checkTags(value, where, errors, { required = false } = {}) {
  if (value === undefined) {
    if (required) errors.push(`${where} is required.`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array of tags.`);
    return [];
  }
  const outTags = [];
  for (const t of value) {
    if (typeof t !== "string" || !TAG_PATTERN.test(t)) errors.push(`${where} has an invalid tag ${JSON.stringify(t)}.`);
    else if (!outTags.includes(t)) outTags.push(t);
  }
  return outTags;
}

function checkNumber(value, where, errors, { fallback, positive = false, integer = false, min }) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${where} must be a finite number.`);
    return fallback;
  }
  if (integer && !Number.isInteger(value)) errors.push(`${where} must be an integer.`);
  if (positive && value <= 0) errors.push(`${where} must be positive.`);
  if (min !== undefined && value < min) errors.push(`${where} must be at least ${min}.`);
  return value;
}

function checkTimeoutMs(value, where, errors) {
  const { minTimeoutMs, maxTimeoutMs, defaultTimeoutMs } = BRINGUP_LIMITS;
  if (!Number.isInteger(value) || value < minTimeoutMs || value > maxTimeoutMs) {
    errors.push(`${where} must be an integer number of milliseconds from ${minTimeoutMs} to ${maxTimeoutMs}.`);
    return defaultTimeoutMs;
  }
  return value;
}

/**
 * Shape check for a bringUp argument vector: a non-empty array of non-empty strings without NUL, whose first
 * element is an absolute path. Whether that file exists and is executable is checked at run time and by doctor,
 * not here, so a config stays loadable while the script is being written. Returns a message or null.
 */
export function bringUpArgvProblem(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return "bringUp must be a non-empty array of strings (an argument vector).";
  if (argv.length > 64) return "bringUp may have at most 64 arguments.";
  if (argv.some((a) => typeof a !== "string" || a.length === 0 || a.length > 4096 || a.includes("\0"))) {
    return "bringUp must contain only non-empty strings without NUL.";
  }
  if (!path.isAbsolute(argv[0])) return "bringUp[0] must be an absolute path to the hook executable.";
  return null;
}

function warnUnknown(obj, known, where, warnings) {
  for (const k of Object.keys(obj)) if (!known.has(k)) warnings.push(`${where}.${k} is not a known field and is ignored.`);
}

function checkUrl(value, where, errors) {
  if (typeof value !== "string") {
    errors.push(`${where} must be a string.`);
    return undefined;
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    errors.push(`${where} is not a valid URL.`);
    return undefined;
  }
  if (u.protocol !== "https:") errors.push(`${where} must use https.`);
  if (u.username || u.password) errors.push(`${where} must not contain credentials.`);
  if (u.search || u.hash) errors.push(`${where} must not have a query or fragment, so it can carry no credentials.`);
  return value;
}

/**
 * Validate a raw config object and apply defaults. Never throws.
 * @returns {{ ok: boolean, config: object|null, errors: string[], warnings: string[] }}
 */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!isObj(raw)) return { ok: false, config: null, errors: ["Config must be a JSON object."], warnings };
  warnUnknown(raw, KNOWN_TOP, "config", warnings);

  if (raw.version !== CONFIG_VERSION) errors.push(`config.version must be ${CONFIG_VERSION}.`);
  const config = { version: CONFIG_VERSION };

  if (raw.scriptPath !== undefined) {
    if (typeof raw.scriptPath !== "string" || !SCRIPT_PATH_PATTERN.test(raw.scriptPath)) errors.push("config.scriptPath must be a plain path.");
    else config.scriptPath = raw.scriptPath;
  }
  if (raw.allowProjectOverride !== undefined && typeof raw.allowProjectOverride !== "boolean") {
    errors.push("config.allowProjectOverride must be a boolean.");
  }
  config.allowProjectOverride = raw.allowProjectOverride === true;
  if (config.allowProjectOverride) warnings.push("config.allowProjectOverride is a Phase 2 feature and is inactive.");

  // defaults
  const d = raw.defaults === undefined ? {} : raw.defaults;
  if (!isObj(d)) errors.push("config.defaults must be an object.");
  config.defaults = { ...DEFAULTS };
  if (isObj(d)) {
    warnUnknown(d, new Set([...Object.keys(DEFAULTS), ...BRINGUP_DEFAULT_KEYS]), "config.defaults", warnings);
    for (const key of Object.keys(DEFAULTS)) {
      config.defaults[key] = checkNumber(d[key], `config.defaults.${key}`, errors, {
        fallback: DEFAULTS[key],
        positive: key !== "minLinkHours",
        min: key === "minLinkHours" ? 0 : undefined,
      });
    }
    if (d.bringUpTimeoutMs !== undefined) {
      config.defaults.bringUpTimeoutMs = checkTimeoutMs(d.bringUpTimeoutMs, "config.defaults.bringUpTimeoutMs", errors);
    }
    if (d.bringUpRetryMinutes !== undefined) {
      config.defaults.bringUpRetryMinutes = checkNumber(d.bringUpRetryMinutes, "config.defaults.bringUpRetryMinutes", errors, {
        fallback: BRINGUP_LIMITS.defaultRetryMinutes, positive: true,
      });
    }
  }

  // local
  const local = raw.local === undefined ? {} : raw.local;
  if (!isObj(local)) errors.push("config.local must be an object.");
  {
    const l = isObj(local) ? local : {};
    warnUnknown(l, KNOWN_LOCAL, "config.local", warnings);
    const declared = checkTags(l.tags, "config.local.tags", errors);
    const tags = [...declared];
    for (const t of localPlatformTags()) if (!tags.includes(t)) tags.push(t);
    config.local = {
      tags,
      priority: checkNumber(l.priority, "config.local.priority", errors, { fallback: LOCAL_DEFAULTS.priority }),
      weight: checkNumber(l.weight, "config.local.weight", errors, { fallback: LOCAL_DEFAULTS.weight, positive: true }),
      maxConcurrent: checkNumber(l.maxConcurrent, "config.local.maxConcurrent", errors, {
        fallback: LOCAL_DEFAULTS.maxConcurrent, positive: true, integer: true,
      }),
      exclusive: checkTags(l.exclusive, "config.local.exclusive", errors),
    };
    if (l.deviceHostId !== undefined) {
      if (typeof l.deviceHostId !== "string" || !ID_PATTERN.test(l.deviceHostId)) errors.push("config.local.deviceHostId is invalid.");
      else config.local.deviceHostId = l.deviceHostId;
    }
    for (const t of config.local.exclusive) {
      if (!config.local.tags.includes(t)) warnings.push(`config.local.exclusive tag ${t} is not among local's tags.`);
    }
  }

  // machines
  const machines = raw.machines === undefined ? {} : raw.machines;
  if (!isObj(machines)) errors.push("config.machines must be an object keyed by label.");
  config.machines = {};
  const seenLabels = new Map();
  const seenEnvs = new Map();
  for (const [label, m] of Object.entries(isObj(machines) ? machines : {})) {
    const where = `config.machines.${label}`;
    if (!LABEL_PATTERN.test(label)) {
      errors.push(`Machine label ${JSON.stringify(label)} must match ${LABEL_PATTERN}.`);
      continue;
    }
    const lower = label.toLowerCase();
    if (RESERVED_LABELS.includes(lower)) errors.push(`Machine label ${label} is reserved for the router and swarm selectors.`);
    if (seenLabels.has(lower)) errors.push(`Machine label ${label} collides with ${seenLabels.get(lower)} (labels are case-insensitive).`);
    seenLabels.set(lower, label);
    if (!isObj(m)) {
      errors.push(`${where} must be an object.`);
      continue;
    }
    warnUnknown(m, KNOWN_MACHINE, where, warnings);
    const entry = {};
    const kind = m.kind === undefined ? MACHINE_DEFAULTS.kind : m.kind;
    if (kind === "ephemeral") errors.push(`${where}.kind ephemeral is a Phase 4 sketch and is not supported.`);
    else if (kind !== "always-on") errors.push(`${where}.kind must be "always-on".`);
    entry.kind = "always-on";
    if (typeof m.environmentId !== "string" || !ID_PATTERN.test(m.environmentId)) {
      errors.push(`${where}.environmentId is required and must be a T3 environment ID.`);
    } else {
      if (seenEnvs.has(m.environmentId)) errors.push(`${where}.environmentId is already used by ${seenEnvs.get(m.environmentId)}.`);
      seenEnvs.set(m.environmentId, label);
      entry.environmentId = m.environmentId;
    }
    if (m.url !== undefined) {
      const url = checkUrl(m.url, `${where}.url`, errors);
      if (url) entry.url = url;
    }
    if (m.ssh !== undefined) {
      if (typeof m.ssh !== "string" || !SSH_PATTERN.test(m.ssh)) errors.push(`${where}.ssh must be a plain [user@]host target.`);
      else entry.ssh = m.ssh;
    }
    if (m.deviceHostId !== undefined) {
      if (typeof m.deviceHostId !== "string" || !ID_PATTERN.test(m.deviceHostId)) errors.push(`${where}.deviceHostId is invalid.`);
      else entry.deviceHostId = m.deviceHostId;
    }
    entry.tags = checkTags(m.tags, `${where}.tags`, errors);
    entry.priority = checkNumber(m.priority, `${where}.priority`, errors, { fallback: MACHINE_DEFAULTS.priority });
    entry.weight = checkNumber(m.weight, `${where}.weight`, errors, { fallback: MACHINE_DEFAULTS.weight, positive: true });
    entry.maxConcurrent = checkNumber(m.maxConcurrent, `${where}.maxConcurrent`, errors, {
      fallback: MACHINE_DEFAULTS.maxConcurrent, positive: true, integer: true,
    });
    entry.exclusive = checkTags(m.exclusive, `${where}.exclusive`, errors);
    for (const t of entry.exclusive) if (!entry.tags.includes(t)) warnings.push(`${where}.exclusive tag ${t} is not among its tags.`);
    const root = m.worktreeRoot === undefined ? MACHINE_DEFAULTS.worktreeRoot : m.worktreeRoot;
    if (typeof root !== "string" || !WORKTREE_ROOT_PATTERN.test(root) || root.startsWith("-") || root.split("/").includes("..")) {
      errors.push(`${where}.worktreeRoot may contain only A-Z a-z 0-9 . _ / - and a leading ~.`);
    }
    entry.worktreeRoot = root;
    const renew = m.renew === undefined ? MACHINE_DEFAULTS.renew : m.renew;
    if (renew !== "manual" && renew !== "auto") errors.push(`${where}.renew must be "manual" or "auto".`);
    entry.renew = renew;
    if (renew === "auto") warnings.push(`${where}.renew auto is a Phase 2 feature and is inactive.`);
    if (m.bringUp !== undefined) {
      const problem = bringUpArgvProblem(m.bringUp);
      if (problem) errors.push(`${where}.${problem}`);
      // Kept exactly as written: the router passes this argument vector to the hook unchanged, with no shell.
      else entry.bringUp = m.bringUp.slice();
    }
    if (m.bringUpTimeoutMs !== undefined) {
      entry.bringUpTimeoutMs = checkTimeoutMs(m.bringUpTimeoutMs, `${where}.bringUpTimeoutMs`, errors);
      if (m.bringUp === undefined) warnings.push(`${where}.bringUpTimeoutMs has no bringUp hook to bound.`);
    }
    for (const f of PHASE2_MACHINE_FIELDS) {
      if (m[f] === undefined) continue;
      warnings.push(`${where}.${f} is a Phase 2 feature and is inactive.`);
      entry[f] = m[f];
    }
    if (entry.checks !== undefined && !Array.isArray(entry.checks)) errors.push(`${where}.checks must be an array.`);
    config.machines[label] = entry;
  }

  // repos
  const repos = raw.repos === undefined ? {} : raw.repos;
  if (!isObj(repos)) errors.push("config.repos must be an object keyed by canonical repo key.");
  config.repos = {};
  for (const [rawKey, r] of Object.entries(isObj(repos) ? repos : {})) {
    const key = rawKey.toLowerCase();
    const where = `config.repos.${rawKey}`;
    if (!/^[^\s/][^\s]*\/[^\s]+$/.test(key) || key.length > 300) {
      errors.push(`${where} must be a canonical repo key such as github.com/owner/repo.`);
      continue;
    }
    if (hasOwn(config.repos, key)) {
      errors.push(`${where} duplicates another repo key (keys are lowercased).`);
      continue;
    }
    if (!isObj(r)) {
      errors.push(`${where} must be an object.`);
      continue;
    }
    warnUnknown(r, KNOWN_REPO, where, warnings);
    const entry = {
      needs: checkTags(r.needs, `${where}.needs`, errors),
      prefers: checkTags(r.prefers, `${where}.prefers`, errors),
      deny: [],
    };
    if (r.deny !== undefined) {
      if (!Array.isArray(r.deny)) errors.push(`${where}.deny must be an array of labels.`);
      else {
        for (const l of r.deny) {
          if (typeof l !== "string" || !LABEL_PATTERN.test(l)) errors.push(`${where}.deny has an invalid label ${JSON.stringify(l)}.`);
          else {
            if (l !== "local" && !hasOwn(config.machines, l)) warnings.push(`${where}.deny names unknown machine ${l}.`);
            entry.deny.push(l);
          }
        }
      }
    }
    if (r.pin !== undefined) {
      if (typeof r.pin !== "string" || (r.pin !== "local" && !hasOwn(config.machines, r.pin))) {
        errors.push(`${where}.pin must be "local" or a configured machine label.`);
      } else entry.pin = r.pin;
    }
    if (r.worktreeCommand !== undefined) {
      if (typeof r.worktreeCommand !== "string" || !SCRIPT_PATH_PATTERN.test(r.worktreeCommand) || r.worktreeCommand.startsWith("-")) {
        errors.push(`${where}.worktreeCommand may contain only A-Z a-z 0-9 . _ / -.`);
      } else entry.worktreeCommand = r.worktreeCommand;
    }
    for (const f of PHASE2_REPO_FIELDS) {
      if (r[f] === undefined) continue;
      warnings.push(`${where}.${f} is a Phase 2 feature and is inactive.`);
      entry[f] = r[f];
    }
    config.repos[key] = entry;
  }

  return { ok: errors.length === 0, config: errors.length === 0 ? config : null, errors, warnings };
}

/** Read and validate config.json without throwing. For `doctor`. */
export function inspectConfig(home) {
  const p = homePaths(home);
  let text;
  try {
    text = fs.readFileSync(p.config, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: false, error: `No config at ${p.config}. Run init.`, configPath: p.config, missing: true, errors: [], warnings: [] };
    }
    return { ok: false, error: `Failed reading ${p.config}: ${err.message}`, configPath: p.config, errors: [], warnings: [] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${p.config} is not valid JSON: ${err.message}`, configPath: p.config, errors: [], warnings: [] };
  }
  const v = validateConfig(raw);
  if (!v.ok) {
    return { ok: false, error: `Invalid config at ${p.config}.`, configPath: p.config, errors: v.errors, warnings: v.warnings };
  }
  const warnings = [...v.warnings];
  for (const [what, file, want] of [["Router home", home, 0o700], ["config.json", p.config, 0o600]]) {
    try {
      const m = fs.statSync(file).mode & 0o777;
      if (m & 0o077) warnings.push(`${what} is mode ${m.toString(8)}; it should be ${want.toString(8)}.`);
    } catch {
      // reported elsewhere
    }
  }
  return { ok: true, config: v.config, configPath: p.config, errors: [], warnings };
}

/** Validated config with defaults applied. Throws StoreError with an `{ ok: false, ... }` envelope. */
export function loadConfig(home) {
  const r = inspectConfig(home);
  if (!r.ok) {
    const { config, ...result } = r;
    throw new StoreError(result);
  }
  return r.config;
}

// ---------------------------------------------------------------------------------------------------------------
// Files

function ensureHome(home) {
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
  }
}

function atomicWrite(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

const serialize = (obj) => JSON.stringify(obj, null, 2) + "\n";

/**
 * Create config.json (the proposed config, or a local-only default) and an empty state.json.
 * Never overwrites an existing config; reports it instead.
 */
export async function init(home, proposedConfig) {
  const p = homePaths(home);
  if (fs.existsSync(p.config)) {
    const r = inspectConfig(home);
    return {
      ok: r.ok,
      created: false,
      home,
      configPath: p.config,
      statePath: p.state,
      stateExists: fs.existsSync(p.state),
      ...(r.ok ? {} : { error: `Existing config is invalid: ${r.error}` }),
      errors: r.errors,
      warnings: r.warnings,
    };
  }
  const raw = proposedConfig === undefined ? defaultConfig() : proposedConfig;
  const v = validateConfig(raw);
  if (!v.ok) return { ok: false, created: false, error: "Proposed config is invalid.", errors: v.errors, warnings: v.warnings };
  try {
    ensureHome(home);
    // Write the user's form (without derived platform tags or filled defaults), so the file stays theirs.
    fs.writeFileSync(p.config, serialize(raw), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(p.config, 0o600);
    let stateCreated = false;
    if (!fs.existsSync(p.state)) {
      atomicWrite(p.state, serialize(emptyState()));
      stateCreated = true;
    }
    return { ok: true, created: true, home, configPath: p.config, statePath: p.state, stateCreated, warnings: v.warnings };
  } catch (err) {
    return { ok: false, created: false, error: `Failed writing setup in ${home}: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lock

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

function readLockText(lockPath) {
  try {
    return fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Exclusive-create lock. A lock older than staleMs, or whose owning pid is gone on this host, is broken by renaming
 * it aside; if the renamed file is not the one judged stale, it is linked back. Returns the owner token.
 */
export async function acquireLock(lockPath, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS } = {}) {
  const token = `${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${token}\n${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return token;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    let stat;
    try {
      stat = fs.statSync(lockPath);
    } catch {
      continue; // released in between
    }
    const seen = readLockText(lockPath);
    const pid = seen ? Number.parseInt(seen.split(".")[0], 10) : NaN;
    const stale = Date.now() - stat.mtimeMs > staleMs || (seen !== null && !pidAlive(pid));
    if (stale && seen !== null) {
      const aside = `${lockPath}.stale.${token}`;
      try {
        fs.renameSync(lockPath, aside);
        if (readLockText(aside) !== seen) {
          try {
            fs.linkSync(aside, lockPath); // we took a fresh lock by mistake; give it back
          } catch {
            // another owner is in place already
          }
        }
        fs.unlinkSync(aside);
      } catch {
        // someone else broke it first
      }
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for lock ${lockPath}`);
    await sleep(15 + Math.floor(Math.random() * 20));
  }
}

/** Remove the lock only if it still holds our token. */
export function releaseLock(lockPath, token) {
  const text = readLockText(lockPath);
  if (text !== null && text.split("\n")[0] === token) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// State

/** Coerce a parsed state object to the schema; returns null if it is not a version-1 state object. */
export function normalizeState(raw) {
  if (!isObj(raw) || raw.version !== STATE_VERSION) return null;
  const state = emptyState();
  for (const k of ["observations", "health", "leases", "slots"]) state[k] = isObj(raw[k]) ? raw[k] : {};
  if (isObj(raw.bringUp)) state.bringUp = raw.bringUp;
  if (isObj(raw.credits)) state.credits = raw.credits;
  if (isObj(raw.affinity)) state.affinity = raw.affinity;
  return state;
}

const ENVELOPE_KINDS = ["link", "probe", "providers", "projects"];

/**
 * Drop expired and orphaned entries in place. Returns true if anything changed.
 *   - observations: whole label when it is not a configured machine or its environmentId no longer matches config;
 *     otherwise each envelope whose validUntil has passed or is unparseable.
 *   - health: only labels that are neither `local` nor configured. Records outlive their cooldown, because
 *     `failures > 0` after the cooldown is what makes a machine `recovering`.
 *   - slots: expired, or on a label that is no longer configured.
 *   - leases: expired; held labels filtered to configured machines.
 *   - bringUp: entries for unconfigured labels, and finished attempts older than the retry window. An unfinished
 *     claim is never dropped here: the router finalizes it (and expires that box's facts) once its deadline passes.
 *   - affinity (Phase 2): expired or unknown label. credits (Phase 2): unknown label.
 */
export function pruneState(config, state, now) {
  let changed = false;
  const machines = config?.machines || {};
  const known = (label) => label === "local" || hasOwn(machines, label);
  const expired = (iso) => !(parseTime(iso) > now);

  for (const label of Object.keys(state.observations)) {
    const obs = state.observations[label];
    const m = hasOwn(machines, label) ? machines[label] : null;
    if (!m || !isObj(obs) || obs.environmentId !== m.environmentId) {
      delete state.observations[label];
      changed = true;
      continue;
    }
    for (const kind of Object.keys(obs)) {
      if (kind === "environmentId") continue;
      if (!ENVELOPE_KINDS.includes(kind) || !isObj(obs[kind]) || expired(obs[kind].validUntil)) {
        delete obs[kind];
        changed = true;
      }
    }
  }
  for (const label of Object.keys(state.health)) {
    if (!known(label) || !isObj(state.health[label])) {
      delete state.health[label];
      changed = true;
    }
  }
  for (const id of Object.keys(state.slots)) {
    const s = state.slots[id];
    if (!isObj(s) || !known(s.label) || expired(s.expiresAt)) {
      delete state.slots[id];
      changed = true;
    }
  }
  for (const run of Object.keys(state.leases)) {
    const lease = state.leases[run];
    if (!isObj(lease) || expired(lease.expiresAt)) {
      delete state.leases[run];
      changed = true;
      continue;
    }
    const held = Array.isArray(lease.machines) ? lease.machines.filter((l) => typeof l === "string" && hasOwn(machines, l)) : [];
    if (!Array.isArray(lease.machines) || held.length !== lease.machines.length) {
      lease.machines = held;
      changed = true;
    }
  }
  if (isObj(state.bringUp)) {
    const retryMs = (Number(config?.defaults?.bringUpRetryMinutes) > 0 ? Number(config.defaults.bringUpRetryMinutes) : BRINGUP_LIMITS.defaultRetryMinutes) * 60_000;
    for (const label of Object.keys(state.bringUp)) {
      const b = state.bringUp[label];
      const finished = isObj(b) && b.finishedAt != null;
      if (!hasOwn(machines, label) || !isObj(b) || (finished && !(parseTime(b.finishedAt) + retryMs > now))) {
        delete state.bringUp[label];
        changed = true;
      }
    }
  }
  if (state.affinity) {
    for (const repo of Object.keys(state.affinity)) {
      const byKey = state.affinity[repo];
      if (!isObj(byKey)) {
        delete state.affinity[repo];
        changed = true;
        continue;
      }
      for (const k of Object.keys(byKey)) {
        if (!isObj(byKey[k]) || !known(byKey[k].label) || expired(byKey[k].expiresAt)) {
          delete byKey[k];
          changed = true;
        }
      }
      if (Object.keys(byKey).length === 0) {
        delete state.affinity[repo];
        changed = true;
      }
    }
  }
  if (state.credits) {
    for (const label of Object.keys(state.credits)) {
      if (!known(label)) {
        delete state.credits[label];
        changed = true;
      }
    }
  }
  return changed;
}

function loadStateLocked(statePath) {
  let text;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, state: emptyState(), text: null };
    return { ok: false, result: { ok: false, error: `Failed reading ${statePath}: ${err.message}` } };
  }
  let parsed;
  let parseError = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parseError = err.message;
  }
  if (parseError === null && isObj(parsed) && typeof parsed.version === "number" && parsed.version !== STATE_VERSION) {
    return {
      ok: false,
      result: { ok: false, error: `${statePath} has unsupported version ${parsed.version}; this router reads version ${STATE_VERSION}. It was left untouched.` },
    };
  }
  const state = parseError === null ? normalizeState(parsed) : null;
  if (state) return { ok: true, state, text };

  const corruptPath = `${statePath}.corrupt.${Date.now()}`;
  try {
    fs.renameSync(statePath, corruptPath);
  } catch (err) {
    return { ok: false, result: { ok: false, error: `${statePath} is corrupt and could not be moved aside: ${err.message}` } };
  }
  return {
    ok: false,
    result: {
      ok: false,
      error: `${statePath} was not a valid state file (${parseError || "not a version 1 state object"}). It was moved to ${corruptPath}; the next command starts from empty state.`,
      corruptPath,
    },
  };
}

/**
 * Lock-free, read-only snapshot of state, normalized and pruned at `now`, for work that must stay outside the lock
 * (such as refreshFacts). A missing, unreadable, corrupt or other-version file reads as empty state; nothing is moved
 * or written. Decisions must still be re-checked against state inside a transaction.
 */
export function readState(home, config, now = Date.now()) {
  let state = null;
  try {
    state = normalizeState(JSON.parse(fs.readFileSync(homePaths(home).state, "utf8")));
  } catch {
    state = null;
  }
  state = state || emptyState();
  pruneState(config, state, now);
  return state;
}

/**
 * Run `fn(state, now)` under the state lock against freshly reloaded, pruned state, and atomically write the
 * state it returns. Keep network and T3 work outside: `fn` must be synchronous.
 * @param {string} home
 * @param {object} config  validated config (from loadConfig)
 * @param {(state: object, now: number) => { state?: object, result: any }} fn
 * @param {{ now?: number | (() => number), lockTimeoutMs?: number, staleLockMs?: number }} [opts]
 * @returns {Promise<any>} fn's result, or `{ ok: false, error }` on lock, read, corrupt-state or write failure.
 */
export async function transaction(home, config, fn, opts = {}) {
  if (typeof fn !== "function") throw new TypeError("transaction needs a function");
  const p = homePaths(home);
  try {
    ensureHome(home);
  } catch (err) {
    return { ok: false, error: `Cannot create router home ${home}: ${err.message}` };
  }
  let token;
  try {
    token = await acquireLock(p.lock, { timeoutMs: opts.lockTimeoutMs, staleMs: opts.staleLockMs });
  } catch (err) {
    return { ok: false, error: `Could not lock router state: ${err.message}` };
  }
  try {
    const loaded = loadStateLocked(p.state);
    if (!loaded.ok) return loaded.result;
    const now = typeof opts.now === "function" ? opts.now() : typeof opts.now === "number" ? opts.now : Date.now();
    const state = loaded.state;
    pruneState(config, state, now);
    const out = fn(state, now);
    if (out && typeof out.then === "function") throw new TypeError("transaction fn must be synchronous; do async work outside the lock");
    if (!isObj(out) || !hasOwn(out, "result")) throw new TypeError("transaction fn must return { state, result }");
    const next = out.state === undefined ? state : out.state;
    if (!normalizeState(next)) throw new TypeError("transaction fn returned an invalid state");
    const text = serialize(next);
    if (text !== loaded.text) {
      try {
        atomicWrite(p.state, text);
      } catch (err) {
        return { ok: false, error: `Failed writing ${p.state}: ${err.message}` };
      }
    }
    return out.result;
  } finally {
    releaseLock(p.lock, token);
  }
}
