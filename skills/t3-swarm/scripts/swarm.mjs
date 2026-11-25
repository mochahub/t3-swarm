#!/usr/bin/env node
/**
 * t3-swarm router & state CLI (zero external dependencies, Node 18+).
 *
 * Manages:
 *   - Machine-local config (~/.t3/swarm/config.json) + opt-in safe project override (.t3-swarm.json)
 *   - Locked, atomic cooldowns & weighted round-robin credits (~/.t3/swarm/health.json). A cooldown key can
 *     name a provider, a billing bucket, one model (`provider:model` or bare model id), or a `*` glob of those.
 *   - Quota weights (config `weights`): smooth weighted round-robin (nginx) per worker tier, so each bucket
 *     gets work in proportion to its weight; optional weighted Lead selection that sticks to a run.
 *   - Single-file run state ledgers (~/.t3/swarm/runs/<run-id>.md) with a Status line that gates `finish`
 *   - Lead failover selection (falling back to the heavy worker pool) & tier:depth worker routing with
 *     the Lead's bucket weighted down
 *   - Optional user quota hook (~/.t3/swarm/hooks.mjs -> export async function checkQuota(...))
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REFERENCES_DIR = path.join(SKILL_DIR, "references");

const SWARM_HOME = process.env.T3_SWARM_HOME || path.join(os.homedir(), ".t3", "swarm");
const DEFAULT_CONFIG_PATH = path.join(SWARM_HOME, "config.json");
const HEALTH_PATH = path.join(SWARM_HOME, "health.json");
const LOCK_PATH = path.join(SWARM_HOME, "health.lock");
const RUNS_DIR = path.join(SWARM_HOME, "runs");
const ARCHIVE_DIR = path.join(SWARM_HOME, "archive");
const HOOKS_PATH = path.join(SWARM_HOME, "hooks.mjs");

const DEPTH_ORDER = ["low", "medium", "high", "deep"];
const VALID_TIERS = ["heavy", "balanced", "fast"];
const KNOWN_COMMANDS = new Set([
  "help",
  "doctor",
  "status",
  "init",
  "finish",
  "pick-lead",
  "pick-worker",
  "pick-workers",
  "post",
  "board",
  "cooldown",
  "clear-cooldown",
  "boxes",
]);
const DEFAULT_BUCKET_ALIASES = {
  "openai-codex": "codex",
};
const MAX_COOLDOWN_MINUTES = 10080; // 7 days
const DEFAULT_STATUS_UPDATE_MINUTES = 15;
const MAX_STATUS_UPDATE_MINUTES = 1440; // 24 hours

let cachedHooks = undefined;
async function loadHooks() {
  if (cachedHooks !== undefined) return cachedHooks;
  if (!fs.existsSync(HOOKS_PATH)) {
    cachedHooks = null;
    return null;
  }
  try {
    cachedHooks = await import(pathToFileURL(HOOKS_PATH).href);
    return cachedHooks;
  } catch {
    cachedHooks = null;
    return null;
  }
}

async function checkQuota(provider, model, bucket) {
  const hooks = await loadHooks();
  if (hooks && typeof hooks.checkQuota === "function") {
    try {
      const res = await hooks.checkQuota(provider, model, bucket);
      if (res && typeof res.available === "boolean") return res;
    } catch {
      // Fail open on user hook errors so orchestration doesn't hard-lock
    }
  }
  return { available: true };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function out(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exitCode = exitCode;
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function acquireLock(timeoutMs = 3000, lockPath = LOCK_PATH) {
  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Recover stale lock older than 10 seconds
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock ${lockPath}`);
      }
      sleepSync(25);
    }
  }
}

function releaseLock(lockPath = LOCK_PATH) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

// Serialize writers of one file (several Leads post to a run's board at once).
function withFileLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  acquireLock(5000, lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

function loadHealthLocked() {
  if (!fs.existsSync(HEALTH_PATH)) {
    return { ok: true, health: { cooldowns: {}, credits: { workers: {}, leads: {}, envs: {} }, leadPicks: {} }, mutated: false };
  }
  let raw;
  try {
    raw = fs.readFileSync(HEALTH_PATH, "utf8");
  } catch (err) {
    return { ok: false, error: `Failed reading ${HEALTH_PATH}: ${err.message}` };
  }
  let health;
  try {
    health = JSON.parse(raw);
    if (!health || typeof health !== "object") throw new Error("Not a JSON object");
  } catch (err) {
    const backup = `${HEALTH_PATH}.corrupt.${Date.now()}`;
    try {
      fs.copyFileSync(HEALTH_PATH, backup);
    } catch {
      // best effort backup
    }
    return {
      ok: false,
      status: "corrupt_health",
      error: `Corrupt health.json (${err.message}). Backed up to ${backup}. Fix or remove ${HEALTH_PATH} to continue.`,
      backupPath: backup,
    };
  }

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  health.cooldowns = isObj(health.cooldowns) ? health.cooldowns : {};
  health.credits = isObj(health.credits) ? health.credits : {};
  health.credits.workers = isObj(health.credits.workers) ? health.credits.workers : {};
  health.credits.leads = isObj(health.credits.leads) ? health.credits.leads : {};
  health.credits.envs = isObj(health.credits.envs) ? health.credits.envs : {};
  health.leadPicks = isObj(health.leadPicks) ? health.leadPicks : {};

  const now = Date.now();
  let mutated = false;
  // Plain round-robin cursors were replaced by weighted credits
  if ("cursors" in health) {
    delete health.cursors;
    mutated = true;
  }
  // Forget per-run Lead picks after 7 days
  for (const [runId, pick] of Object.entries(health.leadPicks)) {
    if (!pick?.at || now - Date.parse(pick.at) > MAX_COOLDOWN_MINUTES * 60_000) {
      delete health.leadPicks[runId];
      mutated = true;
    }
  }
  // Auto-prune expired cooldowns
  for (const [key, entry] of Object.entries(health.cooldowns)) {
    if (!entry?.until || Date.parse(entry.until) <= now) {
      delete health.cooldowns[key];
      mutated = true;
    }
  }
  return { ok: true, health, mutated };
}

async function withHealth(fn) {
  acquireLock();
  try {
    const loaded = loadHealthLocked();
    if (!loaded.ok) return loaded;
    const { health, mutated } = loaded;
    const result = await fn(health);
    if (result?.save || mutated) {
      atomicWriteJson(HEALTH_PATH, health);
    }
    return result?.payload ?? { ok: true };
  } finally {
    releaseLock();
  }
}

function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findProjectOverride(startDir) {
  const gitRoot = findGitRoot(startDir);
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, ".t3-swarm.json");
    if (fs.existsSync(candidate)) return candidate;
    if (gitRoot && dir === gitRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sanitizeOverrideEntry(entry, allowedProviders) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.provider !== "string" || typeof entry.model !== "string") return null;
  if (!allowedProviders.has(entry.provider)) return null;
  // Strip unsafe fields (staticOptions, depthOption, depthMap) from untrusted repo overrides
  const clean = { provider: entry.provider, model: entry.model };
  if (typeof entry.bucket === "string") clean.bucket = entry.bucket;
  if (typeof entry.maxDepth === "string" && DEPTH_ORDER.includes(entry.maxDepth)) {
    clean.maxDepth = entry.maxDepth;
  }
  return clean;
}

function loadConfig(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      return { ok: false, status: "unconfigured", configPath: resolved, configSource: "explicit" };
    }
    try {
      const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
      return { ok: true, configPath: resolved, configSource: "explicit", config, projectOverridePath: null };
    } catch (err) {
      return { ok: false, status: "invalid_config", configPath: resolved, error: err.message };
    }
  }

  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return {
      ok: false,
      status: "unconfigured",
      configPath: DEFAULT_CONFIG_PATH,
      configSource: "global",
    };
  }

  let globalConfig;
  try {
    globalConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
  } catch (err) {
    return {
      ok: false,
      status: "invalid_config",
      configPath: DEFAULT_CONFIG_PATH,
      error: err.message,
    };
  }

  // Only honor repo .t3-swarm.json when explicitly opted in via global config
  const projectOverridePath =
    globalConfig?.allowProjectOverride === true ? findProjectOverride(process.cwd()) : null;

  if (!projectOverridePath) {
    return {
      ok: true,
      configPath: DEFAULT_CONFIG_PATH,
      configSource: "global",
      config: globalConfig,
      projectOverridePath: null,
    };
  }

  let overrideCfg;
  try {
    overrideCfg = JSON.parse(fs.readFileSync(projectOverridePath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      status: "invalid_project_override",
      configPath: projectOverridePath,
      error: err.message,
    };
  }

  const allowedProviders = new Set(Object.keys(globalConfig.providers || {}));
  for (const l of globalConfig.leads || []) if (l?.provider) allowedProviders.add(l.provider);
  for (const tier of VALID_TIERS) {
    for (const w of globalConfig.workers?.[tier] || []) if (w?.provider) allowedProviders.add(w.provider);
  }

  const merged = structuredClone(globalConfig);
  if (Array.isArray(overrideCfg.leads)) {
    const safeLeads = overrideCfg.leads
      .map((e) => sanitizeOverrideEntry(e, allowedProviders))
      .filter(Boolean);
    if (safeLeads.length > 0) merged.leads = safeLeads;
  }
  if (overrideCfg.workers && typeof overrideCfg.workers === "object") {
    for (const tier of VALID_TIERS) {
      if (Array.isArray(overrideCfg.workers[tier])) {
        const safeWorkers = overrideCfg.workers[tier]
          .map((e) => sanitizeOverrideEntry(e, allowedProviders))
          .filter(Boolean);
        if (safeWorkers.length > 0) merged.workers[tier] = safeWorkers;
      }
    }
  }

  return {
    ok: true,
    configPath: DEFAULT_CONFIG_PATH,
    configSource: "global+project",
    projectOverridePath,
    config: merged,
  };
}

function getBucket(config, entry) {
  // 1. Explicit per-entry bucket
  if (typeof entry.bucket === "string" && entry.bucket.trim()) {
    return entry.bucket.trim();
  }
  const providerCfg = config.providers?.[entry.provider] || {};
  const aliases = { ...DEFAULT_BUCKET_ALIASES, ...(config.bucketAliases || {}) };

  // 2. Upstream billing provider option (e.g. Cline options.provider = "openai-codex" -> "codex")
  const optProvider = entry.staticOptions?.provider ?? providerCfg.staticOptions?.provider;
  if (typeof optProvider === "string" && optProvider.trim()) {
    return aliases[optProvider.trim()] || optProvider.trim();
  }

  // 3. Explicit provider-level shared billing bucket (e.g. shared "cline" credits)
  if (typeof providerCfg.bucket === "string" && providerCfg.bucket.trim()) {
    return aliases[providerCfg.bucket.trim()] || providerCfg.bucket.trim();
  }

  // 4. Namespaced vendor prefix (e.g. pi:openai, pi:anthropic) to avoid cross-harness collisions
  if (typeof entry.model === "string" && entry.model.includes("/")) {
    const vendor = entry.model.split("/")[0].trim();
    if (vendor) return `${entry.provider}:${vendor}`;
  }

  // 5. Default to T3 providerInstanceId
  return entry.provider;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Every name a cooldown key may use to hit this entry: provider, billing bucket, bare model id, provider:model.
function cooldownCandidates(config, entry) {
  return [entry.provider, getBucket(config, entry), entry.model, `${entry.provider}:${entry.model}`];
}

function keyMatchesEntry(config, key, entry) {
  const candidates = cooldownCandidates(config, entry);
  if (key.includes("*")) {
    const re = globToRegExp(key);
    return candidates.some((c) => re.test(c));
  }
  return candidates.includes(key);
}

// --exclude takes the same key forms as cooldowns: provider, bucket, model, provider:model, or a glob.
function isExcluded(config, excludeSet, entry) {
  for (const key of excludeSet) if (keyMatchesEntry(config, key, entry)) return true;
  return false;
}

// Returns the active cooldown key that blocks this entry, or null.
function activeCooldownKey(config, health, entry) {
  const now = Date.now();
  for (const [key, cd] of Object.entries(health.cooldowns)) {
    if (!cd?.until || Date.parse(cd.until) <= now) continue;
    if (keyMatchesEntry(config, key, entry)) return key;
  }
  return null;
}

function configuredEntries(config) {
  const list = [];
  (config.leads || []).forEach((entry, i) => {
    if (entry?.provider && entry?.model) list.push({ role: "lead", priority: i + 1, entry });
  });
  for (const tier of VALID_TIERS) {
    for (const entry of config.workers?.[tier] || []) {
      if (entry?.provider && entry?.model) list.push({ role: tier, entry });
    }
  }
  return list;
}

// Configured entries a cooldown key would block, grouped by provider:model.
function entriesMatchingKey(config, key) {
  const byTarget = new Map();
  for (const { role, entry } of configuredEntries(config)) {
    if (!keyMatchesEntry(config, key, entry)) continue;
    const id = `${entry.provider}:${entry.model}`;
    if (!byTarget.has(id)) {
      byTarget.set(id, { provider: entry.provider, model: entry.model, bucket: getBucket(config, entry), roles: [] });
    }
    byTarget.get(id).roles.push(role);
  }
  return [...byTarget.values()];
}

const entryId = (entry) => `${entry.provider}:${entry.model}`;

function weightsCfg(config) {
  const w = config.weights;
  return w && typeof w === "object" && !Array.isArray(w) ? w : {};
}

// A bucket's configured weight (keyed by bucket, else by provider); 1 when unlisted.
function bucketWeight(config, entry, bucket) {
  const table = weightsCfg(config).buckets || {};
  if (typeof table[bucket] === "number") return table[bucket];
  if (typeof table[entry.provider] === "number") return table[entry.provider];
  return 1;
}

// An entry's own weight: its explicit `weight`, else its bucket's weight.
function baseWeight(config, entry, bucket = getBucket(config, entry)) {
  return typeof entry.weight === "number" ? entry.weight : bucketWeight(config, entry, bucket);
}

// Multiplier for buckets passed in --avoid (the Lead's or Coordinator's own bucket).
function avoidMultiplier(config) {
  if (config.defaults?.antiCannibalization === false) return 1;
  const m = weightsCfg(config).leadBucketMultiplier;
  return typeof m === "number" && m >= 0 ? m : 0.5;
}

/**
 * Smooth weighted round-robin (the nginx algorithm). Every positive-weight candidate gains its weight in
 * credit, the highest credit wins and pays back the round's total. Ties go to the lowest `tieKey(c)` (e.g.
 * a bucket not yet used in this wave), then config order; tied candidates have equal credit, so this never
 * shifts long-run shares. Weight-0 candidates never gain credit and are chosen only when no positive-weight
 * candidate exists. Mutates `credits`.
 */
function swrrPick(credits, candidates, tieKey = () => 0) {
  const positive = candidates.filter((c) => c.weight > 0);
  if (positive.length === 0) {
    const fallback = [...candidates].sort((a, b) => tieKey(a) - tieKey(b))[0];
    return { chosen: fallback, charge: 0 };
  }
  const total = positive.reduce((sum, c) => sum + c.weight, 0);
  for (const c of positive) credits[c.id] = (Number(credits[c.id]) || 0) + c.weight;
  let best = null;
  for (const c of positive) {
    const diff = best ? credits[c.id] - credits[best.id] : 1;
    if (diff > 1e-9 || (Math.abs(diff) <= 1e-9 && tieKey(c) < tieKey(best))) best = c;
  }
  credits[best.id] -= total;
  return { chosen: best, charge: total };
}

// Lead candidates: configured leads in order, then (unless disabled) the heavy worker pool by weight.
// Pure: never touches credits, so cooldown/doctor/status can call it safely.
async function rankLeads(config, health, depth, excludeSet) {
  const candidates = (config.leads || []).map((lead, i) => ({ lead, priority: i + 1, source: "leads" }));
  if (config.defaults?.leadFallbackToHeavy !== false) {
    const seen = new Set(candidates.map((c) => `${c.lead?.provider}:${c.lead?.model}`));
    const heavy = (config.workers?.heavy || [])
      .filter((w) => w?.provider && w?.model && !seen.has(entryId(w)))
      .map((w, i) => ({ w, i, weight: baseWeight(config, w) }))
      .sort((a, b) => b.weight - a.weight || a.i - b.i);
    for (const { w } of heavy) {
      seen.add(entryId(w));
      candidates.push({ lead: w, priority: candidates.length + 1, source: "heavy-fallback" });
    }
  }

  const healthy = [];
  const skipped = [];
  for (const { lead, priority, source } of candidates) {
    if (!lead?.provider || !lead?.model) {
      skipped.push({ priority, source, reason: "invalid_entry" });
      continue;
    }
    const bucket = getBucket(config, lead);
    const base = { priority, source, model: lead.model, bucket };
    if (isExcluded(config, excludeSet, lead)) {
      skipped.push({ ...base, reason: "excluded" });
      continue;
    }
    const cdKey = activeCooldownKey(config, health, lead);
    if (cdKey) {
      skipped.push({ ...base, reason: `cooldown:${cdKey}` });
      continue;
    }
    if (!supportsDepth(config, lead, depth)) {
      skipped.push({ ...base, reason: `depth_cap(${depth})` });
      continue;
    }
    const quota = await checkQuota(lead.provider, lead.model, bucket);
    if (!quota.available) {
      skipped.push({ ...base, reason: quota.reason || "quota_hook" });
      continue;
    }
    healthy.push({ lead, bucket, priority, source, weight: baseWeight(config, lead, bucket) });
  }
  return { healthy, skipped };
}

const LEAD_REFUND_WINDOW_MS = 15 * 60_000;

/**
 * Choose the Lead for a run. With --run, the choice sticks to that run: repeat calls return the same Lead
 * while it stays healthy; if it has gone unhealthy, pick again (refunding its turn when it failed within
 * 15 minutes, i.e. before doing real work). Mutates health.credits.leads and health.leadPicks.
 */
function chooseLead(config, health, healthy, runId, stream = null) {
  const weighted = weightsCfg(config).leadSelection === "weighted";
  const pickKey = runId && stream ? `${runId}#${stream}` : runId; // single-Lead runs keep the plain run key
  const prior = pickKey ? health.leadPicks[pickKey] : null;
  let refunded = false;
  if (prior) {
    const same = healthy.find((h) => entryId(h.lead) === prior.id);
    if (same) return { chosen: same, sticky: true, changed: false };
    if (prior.charge > 0 && Date.now() - Date.parse(prior.at) < LEAD_REFUND_WINDOW_MS) {
      health.credits.leads[prior.id] = (Number(health.credits.leads[prior.id]) || 0) + prior.charge;
      refunded = true;
    }
  }

  // Workstream Leads of one run: prefer a model no other workstream is using, so one model's limit
  // can't stop two workstreams and the Leads think differently. Reuse only when nothing else is healthy.
  let pool = healthy;
  let sharedWith = null;
  if (runId && stream && stream !== "integrate") { // the integration pass runs alone, after the others
    const taken = new Map();
    for (const [k, v] of Object.entries(health.leadPicks)) {
      if (k.startsWith(`${runId}#`) && k !== pickKey && v?.id) taken.set(v.id, k.slice(runId.length + 1));
    }
    const free = healthy.filter((h) => !taken.has(entryId(h.lead)));
    if (free.length) pool = free;
    else if (taken.size) sharedWith = taken.get(entryId(healthy[0].lead)) || [...taken.values()][0];
  }

  let chosen = pool[0];
  let charge = 0;
  const fromLeads = pool.filter((h) => h.source === "leads");
  if (weighted && fromLeads.length > 0) {
    const live = new Set((config.leads || []).filter((l) => l?.provider && l?.model).map(entryId));
    for (const id of Object.keys(health.credits.leads)) if (!live.has(id)) delete health.credits.leads[id];
    const pick = swrrPick(
      health.credits.leads,
      fromLeads.map((h) => ({ id: entryId(h.lead), weight: h.weight, h }))
    );
    chosen = pick.chosen.h;
    charge = pick.charge;
  }
  if (pickKey) {
    health.leadPicks[pickKey] = {
      id: entryId(chosen.lead),
      at: new Date().toISOString(),
      charge,
      ...(prior ? { failoverFrom: prior.id } : {}),
    };
  }
  return {
    chosen,
    sticky: false,
    changed: Boolean(pickKey) || charge > 0 || refunded,
    ...(prior ? { failoverFrom: prior.id, refunded } : {}),
    ...(sharedWith ? { sharedWith } : {}),
  };
}

const DURATION_RE = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;

// "90" -> 90 minutes; "1h42m5s" / "7d" / "45m" -> minutes (rounded up). NaN when unparseable.
function parseDurationMinutes(raw) {
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(Number(s));
  const m = s.match(DURATION_RE);
  if (!s || !m || (!m[1] && !m[2] && !m[3] && !m[4])) return NaN;
  const [, d, h, mi, se] = m;
  return Math.ceil(Number(d || 0) * 1440 + Number(h || 0) * 60 + Number(mi || 0) + Number(se || 0) / 60);
}

function supportsDepth(config, entry, depth) {
  const providerCfg = config.providers?.[entry.provider] || {};
  const maxDepth = entry.maxDepth ?? providerCfg.maxDepth ?? null;
  if (!maxDepth) return true;
  const maxIdx = DEPTH_ORDER.indexOf(maxDepth);
  const reqIdx = DEPTH_ORDER.indexOf(depth);
  if (maxIdx === -1 || reqIdx === -1) return false;
  return reqIdx <= maxIdx;
}

function buildTarget(config, entry, depth) {
  const providerCfg = config.providers?.[entry.provider] || {};
  const options = {
    ...(providerCfg.staticOptions || {}),
    ...(entry.staticOptions || {}),
  };

  const depthOption =
    entry.depthOption !== undefined ? entry.depthOption : providerCfg.depthOption;
  const mergedDepthMap = {
    ...(providerCfg.depthMap || {}),
    ...(entry.depthMap || {}),
  };

  let depthApplied = false;
  if (depthOption && mergedDepthMap[depth] !== undefined) {
    options[depthOption] = mergedDepthMap[depth];
    depthApplied = true;
  }

  const target = {
    providerInstanceId: entry.provider,
    model: entry.model,
  };
  if (Object.keys(options).length > 0) {
    target.options = options;
  }

  const depthDropped = Boolean(depthOption !== null && !depthApplied);
  return { target, depthDropped };
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function parseCsvSet(val) {
  if (!val || typeof val !== "string") return new Set();
  return new Set(
    val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function slugify(text) {
  return (
    String(text || "run")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "run"
  );
}

function getGitInfo() {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0;
    return { isGitRepo: true, branch, commit, dirty };
  } catch {
    return { isGitRepo: false, branch: null, commit: null, dirty: false };
  }
}

function readLedgerStatus(filePath) {
  try {
    const match = fs.readFileSync(filePath, "utf8").match(/^\s*-\s*\*\*Status:\*\*\s*`?([A-Za-z_]+)/m);
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

function checkWritable(dir) {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== "object") {
    errors.push("Config must be a JSON object.");
    return { errors, warnings };
  }

  if (config.providers !== undefined && (typeof config.providers !== "object" || Array.isArray(config.providers))) {
    errors.push("`providers` must be an object keyed by providerInstanceId.");
  }

  const checkEntry = (entry, label) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (typeof entry.provider !== "string" || !entry.provider.trim()) {
      errors.push(`${label} is missing required string \`provider\`.`);
    }
    if (typeof entry.model !== "string" || !entry.model.trim()) {
      errors.push(`${label} is missing required string \`model\`.`);
    }
    if (entry.maxDepth !== undefined && !DEPTH_ORDER.includes(entry.maxDepth)) {
      errors.push(`${label} has invalid maxDepth "${entry.maxDepth}". Must be one of: ${DEPTH_ORDER.join(", ")}.`);
    }
    if (entry.weight !== undefined && !(typeof entry.weight === "number" && Number.isFinite(entry.weight) && entry.weight >= 0)) {
      errors.push(`${label} has invalid weight ${JSON.stringify(entry.weight)}; use a number >= 0.`);
    }
    if (entry.provider && !config.providers?.[entry.provider]) {
      warnings.push(
        `${label} uses provider "${entry.provider}" with no \`providers.${entry.provider}\` block—thinking depth options will NOT be sent.`
      );
    }
  };

  for (const [provId, pCfg] of Object.entries(config.providers || {})) {
    if (pCfg?.maxDepth !== undefined && !DEPTH_ORDER.includes(pCfg.maxDepth)) {
      errors.push(`providers.${provId} has invalid maxDepth "${pCfg.maxDepth}".`);
    }
  }

  if (config.defaults?.leadDepth && !DEPTH_ORDER.includes(config.defaults.leadDepth)) {
    errors.push(`defaults.leadDepth "${config.defaults.leadDepth}" is invalid.`);
  }
  if (config.defaults?.workerDepth && !DEPTH_ORDER.includes(config.defaults.workerDepth)) {
    errors.push(`defaults.workerDepth "${config.defaults.workerDepth}" is invalid.`);
  }

  const fallback = config.defaults?.leadFallbackToHeavy;
  if (fallback !== undefined && typeof fallback !== "boolean") {
    errors.push("defaults.leadFallbackToHeavy must be true or false.");
  }

  if (!Array.isArray(config.leads) || config.leads.length === 0) {
    warnings.push("No leads configured (Mode 2 requires at least one lead).");
  } else {
    config.leads.forEach((l, i) => checkEntry(l, `leads[${i}]`));
    const valid = config.leads.filter((l) => l?.provider && l?.model);
    const leadBuckets = new Set(valid.map((l) => getBucket(config, l)));
    if (valid.length > 0 && leadBuckets.size < 2) {
      warnings.push(
        `Every lead bills to "${[...leadBuckets][0]}"; one account-wide limit stops all of them. Add a lead from another bucket.`
      );
    }
  }

  if (!config.workers || typeof config.workers !== "object") {
    errors.push("Missing `workers` object.");
  } else {
    for (const tier of VALID_TIERS) {
      const list = config.workers[tier];
      if (!Array.isArray(list) || list.length === 0) {
        warnings.push(`Worker tier "${tier}" is empty.`);
      } else {
        list.forEach((w, i) => checkEntry(w, `workers.${tier}[${i}]`));
      }
    }
  }

  validateWeights(config, errors, warnings);
  validateStatusUpdates(config, errors, warnings);
  validateBoxes(config, errors, warnings);
  validateViewer(config, errors);
  return { errors, warnings };
}

function validateBoxes(config, errors, warnings) {
  for (const k of ["environments", "machines", "placement", "boxes"]) {
    if (config[k] !== undefined) warnings.push(`\`${k}\` is ignored: boxes aren't configured in the swarm. The Coordinator gets a run's boxes from the user's box skill and registers them (\`boxes register\`).`);
  }
}

// Live viewer (scripts/swarm-viz.mjs): off unless config turns it on with `viewer: { enabled: true }`.
const VIZ_PATH = path.join(path.dirname(SCRIPT_PATH), "swarm-viz.mjs");
const DEFAULT_VIEWER_PORT = 4777;
function resolveViewer(config, runId = null) {
  const v = config.viewer;
  if (!v || typeof v !== "object" || v.enabled !== true) return { enabled: false };
  const port = Number.isInteger(v.port) ? v.port : DEFAULT_VIEWER_PORT;
  return {
    enabled: true,
    port,
    start: `node "${VIZ_PATH}" --detach --root "<first Lead's childThreadId>" --port ${port}${runId ? ` --run ${runId}` : ""}`,
    ...(runId
      ? { next: "Run `start` after dispatching the first Lead, automatically open the returned port in a T3 preview tab (`preview_open`), and always show the returned `url` to the user in your reply." }
      : {}),
  };
}
function validateViewer(config, errors) {
  const v = config.viewer;
  if (v === undefined) return;
  if (!v || typeof v !== "object" || Array.isArray(v)) return errors.push("`viewer` must be an object: { enabled: true, port: 4777 }.");
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") errors.push("viewer.enabled must be true or false.");
  if (v.port !== undefined && !(Number.isInteger(v.port) && v.port >= 1024 && v.port <= 65535)) errors.push("viewer.port must be an integer from 1024 to 65535.");
}
// Stop a run's viewer (finish): its pidfile names the process; check it is ours before signalling.
function stopViewer(runId) {
  const pidFile = path.join(RUNS_DIR, `${runId}.viz.pid`);
  if (!fs.existsSync(pidFile)) return null;
  let stopped = false;
  try {
    const { pid } = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    const cmdline = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (cmdline.includes("swarm-viz.mjs")) {
      process.kill(pid, "SIGTERM");
      stopped = true;
    }
  } catch {
    // already gone
  }
  try { fs.unlinkSync(pidFile); } catch {}
  return stopped;
}

function resolveStatusUpdates(config) {
  const su = config.statusUpdates;
  if (!su || typeof su !== "object" || Array.isArray(su) || su.enabled !== true) {
    return { enabled: false };
  }
  const intervalMinutes =
    Number.isInteger(su.intervalMinutes) &&
    su.intervalMinutes >= 1 &&
    su.intervalMinutes <= MAX_STATUS_UPDATE_MINUTES
      ? su.intervalMinutes
      : DEFAULT_STATUS_UPDATE_MINUTES;
  return {
    enabled: true,
    intervalMinutes,
    everyMs: intervalMinutes * 60_000,
  };
}

function validateStatusUpdates(config, errors, warnings) {
  if (config.statusUpdates === undefined) return;
  const su = config.statusUpdates;
  if (!su || typeof su !== "object" || Array.isArray(su)) {
    errors.push("`statusUpdates` must be an object.");
    return;
  }
  if (su.enabled !== undefined && typeof su.enabled !== "boolean") {
    errors.push("statusUpdates.enabled must be true or false.");
  }
  if (su.intervalMinutes !== undefined) {
    if (
      !Number.isInteger(su.intervalMinutes) ||
      su.intervalMinutes < 1 ||
      su.intervalMinutes > MAX_STATUS_UPDATE_MINUTES
    ) {
      errors.push(
        `statusUpdates.intervalMinutes must be an integer from 1 to ${MAX_STATUS_UPDATE_MINUTES}; set enabled: false to disable.`
      );
    } else if (su.enabled === true && su.intervalMinutes < 5) {
      warnings.push(
        `statusUpdates.intervalMinutes is short (${su.intervalMinutes}m); 10–15m is recommended to avoid check-in noise.`
      );
    }
  }
  if (su.enabled === undefined && su.intervalMinutes !== undefined) {
    warnings.push(
      "statusUpdates.intervalMinutes is set without statusUpdates.enabled: true; status updates stay off until enabled is true."
    );
  }
}

function validateWeights(config, errors, warnings) {
  if (config.weights === undefined) return;
  const w = config.weights;
  if (!w || typeof w !== "object" || Array.isArray(w)) {
    errors.push("`weights` must be an object.");
    return;
  }
  const known = new Set();
  for (const { entry } of configuredEntries(config)) {
    known.add(entry.provider);
    known.add(getBucket(config, entry));
  }
  if (w.buckets !== undefined) {
    if (!w.buckets || typeof w.buckets !== "object" || Array.isArray(w.buckets)) {
      errors.push("`weights.buckets` must be an object of bucket -> number.");
    } else {
      for (const [key, val] of Object.entries(w.buckets)) {
        if (!(typeof val === "number" && Number.isFinite(val) && val >= 0)) {
          errors.push(`weights.buckets.${key} must be a number >= 0.`);
        }
        if (!known.has(key)) {
          errors.push(
            `weights.buckets.${key} matches no configured bucket or provider (${[...known].join(", ")}); a typo here silently leaves that bucket at weight 1.`
          );
        }
      }
    }
  }
  const m = w.leadBucketMultiplier;
  if (m !== undefined && !(typeof m === "number" && m >= 0 && m <= 1)) {
    errors.push("weights.leadBucketMultiplier must be a number from 0 to 1.");
  }
  if (w.leadSelection !== undefined && !["priority", "weighted"].includes(w.leadSelection)) {
    errors.push('weights.leadSelection must be "priority" or "weighted".');
  }
  const cap = w.maxSessionsPerBucket;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 1)) {
    errors.push("weights.maxSessionsPerBucket must be an integer >= 1.");
  }
  if (w.leadSelection === "weighted") {
    const leads = (config.leads || []).filter((l) => l?.provider && l?.model);
    if (leads.length > 0 && leads.every((l) => baseWeight(config, l) === 0)) {
      warnings.push("weights.leadSelection is weighted but every lead has weight 0; leads will go in list order.");
    }
  }
}

async function selectOneWorker(config, health, tier, depth, avoidSet, excludeSet, batchCounts, where = {}) {
  const { envs, run: placeRun } = runPlaces();
  const pool = config.workers?.[tier] || [];
  if (pool.length === 0) {
    return { ok: false, error: `No workers configured for tier "${tier}".` };
  }

  const eligible = [];
  const skipped = [];

  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    if (!entry?.provider || !entry?.model) {
      skipped.push({ index: i, reason: "invalid_entry" });
      continue;
    }
    const bucket = getBucket(config, entry);
    if (isExcluded(config, excludeSet, entry)) {
      skipped.push({ model: entry.model, bucket, reason: "excluded" });
      continue;
    }
    const cdKey = activeCooldownKey(config, health, entry);
    if (cdKey) {
      skipped.push({ model: entry.model, bucket, reason: `cooldown:${cdKey}` });
      continue;
    }
    if (!supportsDepth(config, entry, depth)) {
      skipped.push({ model: entry.model, bucket, reason: `depth_cap(${depth})` });
      continue;
    }
    const quota = await checkQuota(entry.provider, entry.model, bucket);
    if (!quota.available) {
      skipped.push({ model: entry.model, bucket, reason: quota.reason || "quota_hook" });
      continue;
    }
    if (envs.length && where.place) {
      const fitsPlace = (e) => (where.place === "local" ? e.local : where.place === "box" ? !e.local : e.label === where.place || e.id === where.place);
      const ok = envs.some((e) => fitsPlace(e) && !envMisfit(health, e, { provider: entry.provider }));
      if (!ok) {
        skipped.push({ model: entry.model, bucket, reason: `can't run on --place ${where.place}` });
        continue;
      }
    }
    eligible.push({ entry, bucket, idx: i });
  }

  if (eligible.length === 0) {
    return {
      ok: false,
      error: `No eligible worker for ${tier}:${depth}.`,
      skipped,
    };
  }

  // Effective weights. A bucket's weight is shared by its eligible models in this tier (so listing two
  // Claude models doesn't double Claude's share); an explicit per-entry `weight` is used as-is.
  const perBucket = new Map();
  for (const c of eligible) {
    if (typeof c.entry.weight !== "number") perBucket.set(c.bucket, (perBucket.get(c.bucket) || 0) + 1);
  }
  const mult = avoidMultiplier(config);
  const isAvoided = (c) => avoidSet.has(c.bucket) || avoidSet.has(c.entry.provider);
  for (const c of eligible) {
    c.weight =
      typeof c.entry.weight === "number"
        ? c.entry.weight
        : bucketWeight(config, c.entry, c.bucket) / perBucket.get(c.bucket);
    if (isAvoided(c)) c.weight *= mult;
  }

  // Optional soft cap on live sessions per bucket in one wave (the avoided Lead/Coordinator session counts).
  const cap = weightsCfg(config).maxSessionsPerBucket;
  let candidates = eligible;
  let capRelaxed = false;
  if (Number.isInteger(cap) && cap > 0) {
    const sessions = (c) => (batchCounts?.get(c.bucket) || 0) + (isAvoided(c) ? 1 : 0);
    const underCap = eligible.filter((c) => sessions(c) < cap);
    if (underCap.length > 0) candidates = underCap;
    else capRelaxed = true;
  }

  const live = new Set(pool.filter((e) => e?.provider && e?.model).map(entryId));
  const credits = (health.credits.workers[tier] ||= {});
  for (const id of Object.keys(credits)) if (!live.has(id)) delete credits[id];
  const { chosen } = swrrPick(
    credits,
    candidates.map((c) => ({ ...c, id: entryId(c.entry) })),
    (c) => (batchCounts?.get(c.bucket) || 0) + (isAvoided(c) ? 1 : 0)
  );
  if (batchCounts) batchCounts.set(chosen.bucket, (batchCounts.get(chosen.bucket) || 0) + 1);

  const { target, depthDropped } = buildTarget(config, chosen.entry, depth);
  const round = (n) => Math.round(n * 1000) / 1000;
  const pick = {
    ok: true,
    tier,
    depth,
    bucket: chosen.bucket,
    target,
    depthDropped,
    weight: round(chosen.weight),
    candidates: candidates.map((c) => ({ model: c.entry.model, bucket: c.bucket, weight: round(c.weight) })),
    ...(isAvoided(chosen) ? { onAvoidedBucket: true } : {}),
    ...(capRelaxed ? { capRelaxed: true } : {}),
  };
  if (envs.length) {
    const placed = chooseEnvironment(config, health, { provider: chosen.entry.provider, place: where.place, batch: where.envBatch });
    if (placed.error) return { ok: false, error: placed.error, ...(placed.skipped ? { skipped: placed.skipped } : {}) };
    applyPlacement(pick, placed.env, placed.skipped);
  } else if (where.place && where.place !== "local") {
    return { ok: false, error: placeRun ? `Run ${placeRun} has no boxes registered (boxes register).` : "No run found for this pick: pass --run <runId>, or pick from the run's swarm/ branch." };
  }
  return pick;
}

// ---------------------------------------------------------------------------------------------------
// Workstreams: one run, several Leads. Each workstream has its own ledger (<run-id>.<stream>.md) and
// branch (swarm/<run-id>--<stream>); the run ledger lists them, and an integration pass merges them.
// Leads coordinate on the run's board (<run-id>.board.md): they claim the files they will touch,
// agree shared contracts, and ask each other questions, so their work doesn't overlap.
// ---------------------------------------------------------------------------------------------------
const DEFAULT_MAX_WORKSTREAMS = 4;
const RESERVED_STREAMS = new Set(["integrate", "all", "coordinator", "board", "run"]);
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9-]+-[0-9a-f]{4}$/;
const BOARD_KINDS = ["claim", "release", "contract", "ack", "ask", "answer", "note", "done"];

function parseStreams(raw, config) {
  const max = config.defaults?.maxWorkstreams ?? DEFAULT_MAX_WORKSTREAMS;
  const names = String(raw || "")
    .split(",")
    .map((s) => slugify(s).slice(0, 24))
    .filter((s) => s && s !== "run");
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) return { error: `Duplicate workstream name(s): ${[...new Set(dupes)].join(", ")}.` };
  const reserved = names.filter((n) => RESERVED_STREAMS.has(n));
  if (reserved.length) return { error: `Reserved workstream name(s): ${reserved.join(", ")}. Pick other names.` };
  if (names.length < 2) return { error: "--streams needs at least 2 names (e.g. ios,android,web). Omit it for a single Lead." };
  if (names.length > max) return { error: `At most ${max} workstreams per run (defaults.maxWorkstreams). Split the goal into separate runs.` };
  return { streams: names };
}

const streamLedgerPath = (runId, stream) => path.join(RUNS_DIR, `${runId}.${stream}.md`);
const boardFilePath = (runId) => path.join(RUNS_DIR, `${runId}.board.md`);
const runLedgerPath = (runId) => path.join(RUNS_DIR, `${path.basename(String(runId), ".md")}.md`);

// Workstream names of a run, from its ledger files (works for active runs).
function runStreams(runId) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const prefix = `${runId}.`;
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md") && f !== `${runId}.board.md`)
    .map((f) => f.slice(prefix.length, -3))
    .filter((s) => s && !s.includes("."))
    .sort();
}

// Board lines: `- #<n> | <ISO time> | <from> → <to> | <kind> | <paths or -> | <text>`
function readBoard(runId) {
  const file = boardFilePath(runId);
  if (!fs.existsSync(file)) return null;
  const posts = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^- #(\d+) \| (\S+) \| (\S+) → (\S+) \| (\w+) \| ([^|]*) \|\s?(.*)$/);
    if (!m) continue;
    const paths = m[6].trim() === "-" ? [] : m[6].split(",").map((p) => p.trim()).filter(Boolean);
    posts.push({ n: Number(m[1]), at: m[2], from: m[3], to: m[4], kind: m[5], paths, text: m[7] });
  }
  return { file, posts };
}

function normClaim(p) {
  return String(p).trim().replace(/^\.\//, "").replace(/\/?\*.*$/, "").replace(/\/+$/, "");
}
// Two claims overlap when one is the other or contains it ("app/ui" and "app/ui/shop.gd"); "" claims everything.
function claimsOverlap(a, b) {
  const x = normClaim(a), y = normClaim(b);
  return x === "" || y === "" || x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}
// Replay claims and releases into who holds what now. `done` releases everything the stream held.
function activeClaims(posts) {
  const held = new Map();
  for (const p of posts) {
    if (!held.has(p.from)) held.set(p.from, []);
    const mine = held.get(p.from);
    if (p.kind === "claim") for (const path_ of p.paths) if (!mine.includes(path_)) mine.push(path_);
    if (p.kind === "release") held.set(p.from, p.paths.length ? mine.filter((x) => !p.paths.some((r) => claimsOverlap(r, x) && normClaim(r).length <= normClaim(x).length)) : []);
    if (p.kind === "done") held.set(p.from, []);
  }
  for (const [k, v] of held) if (!v.length) held.delete(k);
  return held;
}

// A contract post's text starts with `[owner: <stream|all>]` (and `, replaces #<n>` when it supersedes one).
// The owner implements it; `all` means each workstream implements its own side.
const CONTRACT_HEAD_RE = /^\[owner: ([a-z0-9-]+)(?:, replaces #(\d+))?\]\s*/;
function parseContract(p) {
  const m = p.text.match(CONTRACT_HEAD_RE);
  return { owner: m ? m[1] : null, replaces: m?.[2] ? Number(m[2]) : null, text: m ? p.text.slice(m[0].length) : p.text };
}
const refsPost = (text, n) => new RegExp(`#${n}(?!\\d)`).test(text);

// What the board says now: who holds which paths, which contracts are settled, which asks are open.
// A contract is settled when it has an owner and every Lead that must implement it (other than the
// proposer) has acked it. An ask closes when the asked side answers, or releases the paths it asked about.
function boardState(posts, streams) {
  const done = new Set(posts.filter((p) => p.kind === "done").map((p) => p.from));
  const contracts = posts.filter((p) => p.kind === "contract").map((p) => {
    const c = parseContract(p);
    const acks = [...new Set(posts.filter((q) => q.kind === "ack" && q.n > p.n && refsPost(q.text, p.n)).map((q) => q.from))];
    const must = c.owner === "all" ? streams.filter((s) => s !== p.from) : c.owner && c.owner !== p.from ? [c.owner] : [];
    // The Coordinator's ack ("#n verified") settles a contract it has checked on the branches itself.
    const missingAcks = acks.includes("coordinator") ? [] : must.filter((s) => !acks.includes(s));
    return { n: p.n, by: p.from, owner: c.owner, ...(c.replaces ? { replaces: c.replaces } : {}), text: c.text, acks, missingAcks };
  });
  const replaced = new Set(contracts.map((c) => c.replaces).filter(Boolean));
  for (const c of contracts) {
    c.state = replaced.has(c.n) ? "replaced" : !c.owner ? "no owner" : c.missingAcks.length ? "waiting for acks" : "settled";
  }
  const openAsks = posts
    .filter((p) => p.kind === "ask")
    .filter((p) => !posts.some((q) => q.n > p.n && (
      (q.kind === "answer" && (q.to === p.from || q.to === "all") && (p.to === "all" || q.from === p.to || q.from === "coordinator")) ||
      (q.kind === "release" && p.paths.length && (p.to === "all" || q.from === p.to) && q.paths.some((r) => p.paths.some((x) => claimsOverlap(r, x))))
    )))
    .map((p) => ({ n: p.n, from: p.from, to: p.to, paths: p.paths, text: p.text, ...(done.has(p.to) ? { note: `${p.to} has posted done; its Lead won't read this` } : {}) }));
  return { done, claims: Object.fromEntries(activeClaims(posts)), contracts, openAsks };
}

// Contracts and asks still unsettled, for one workstream (`done`) or the whole run (integration pass).
function unsettled(state, stream = null) {
  const live = state.contracts.filter((c) => c.state !== "replaced" && c.state !== "settled");
  const issues = [];
  for (const c of live) {
    if (stream && c.by !== stream && c.owner !== stream && !c.missingAcks.includes(stream)) continue;
    issues.push({ contract: c.n, by: c.by, owner: c.owner, state: c.state, ...(c.missingAcks.length ? { missingAcks: c.missingAcks } : {}), text: c.text });
  }
  for (const a of state.openAsks) {
    if (stream && a.to !== stream && a.from !== stream) continue;
    issues.push({ ask: a.n, from: a.from, to: a.to, text: a.text });
  }
  return issues;
}

// The run ledger's Workstreams rows: `- <stream> | ledger: .. | branch: .. | lead: .. | thread: .. | status: ..`
// (the Coordinator fills lead/thread/status as it dispatches each Lead).
function workstreamRows(runId) {
  const rows = {};
  let text = "";
  try { text = fs.readFileSync(runLedgerPath(runId), "utf8"); } catch { return rows; }
  const sec = text.split(/^## Workstreams\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  for (const line of sec.split("\n")) {
    const name = line.match(/^- ([a-z0-9-]+) \|/)?.[1];
    if (!name) continue;
    const field = (k) => {
      const v = line.match(new RegExp(`\\| ${k}: \`?([^|\`]+?)\`?\\s*(?:\\||$)`))?.[1]?.trim();
      return v && v !== "(pending)" ? v : null;
    };
    rows[name] = { branch: field("branch"), lead: field("lead"), thread: field("thread"), status: field("status") };
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------
// Boxes: other machines a run's workers may use. The swarm doesn't start, stop or configure them: the
// Coordinator gets a run's boxes from the user's own box skill, asks T3 what each can run (providers signed
// in, projects there) and registers that list with `boxes register`. Workers then spread evenly over this
// machine and the run's boxes, unless the Lead pins one with --place. A box is skipped only for
// correctness: the picked provider isn't signed in there, this repo's project isn't there, or it is cooled
// down. Leads always stay on this machine. finish lists the run's boxes so the Coordinator releases them.
// ---------------------------------------------------------------------------------------------------

// "git@github.com:Owner/Repo.git", "https://user:token@github.com/owner/repo", "ssh://git@host:22/o/r.git"
// -> "github.com/owner/repo", the form T3 gives as a project's repositoryIdentity.canonicalKey.
function canonicalRepoKey(url) {
  const s = String(url || "").trim();
  let host, p;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      p = decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
    if (!scp) return null;
    [, host, p] = scp;
  }
  p = p.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host && p ? `${host}/${p}`.toLowerCase() : null;
}
let repoKeyMemo;
function currentRepoKey() {
  if (repoKeyMemo !== undefined) return repoKeyMemo;
  try {
    repoKeyMemo = canonicalRepoKey(execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    repoKeyMemo = null;
  }
  return repoKeyMemo;
}

// A run's boxes live in <runId>.boxes.json, as the Coordinator registered them. finish archives it.
let cliFlags = {};
const leasePath = (runId) => path.join(RUNS_DIR, `${path.basename(String(runId))}.boxes.json`);
function readLease(runId) {
  try {
    const j = JSON.parse(fs.readFileSync(leasePath(runId), "utf8"));
    return Array.isArray(j?.machines) ? j : null;
  } catch {
    return null;
  }
}
// The run a pick belongs to: --run, else the swarm/<runId>[--<stream>] branch this checkout is on.
let runMemo;
function currentRun() {
  if (typeof cliFlags.run === "string") return cliFlags.run;
  if (runMemo !== undefined) return runMemo;
  runMemo = null;
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const rest = /^swarm\/(.+)$/.exec(branch)?.[1];
    if (rest) {
      const cands = [rest, rest.includes("--") ? rest.slice(0, rest.lastIndexOf("--")) : null].filter(Boolean);
      runMemo = cands.find((c) => fs.existsSync(runLedgerPath(c))) || null;
    }
  } catch {}
  return runMemo;
}
// Check a `boxes register` payload: the run's boxes from the box skill, with what T3 says each can run.
function parseRegisterInput(raw) {
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    return { error: `register needs a JSON array: ${err.message}` };
  }
  if (!Array.isArray(list)) return { error: "register needs a JSON array of { label, environmentId, providers, projects }." };
  const errors = [], labels = new Set(), ids = new Set();
  list.forEach((m, i) => {
    if (!m || typeof m !== "object" || typeof m.label !== "string" || !m.label || typeof m.environmentId !== "string" || !m.environmentId) {
      return errors.push(`entry ${i} needs the box's label and T3 environmentId.`);
    }
    if (labels.has(m.label) || ids.has(m.environmentId)) errors.push(`entry ${i}: ${m.label} is listed twice.`);
    labels.add(m.label);
    ids.add(m.environmentId);
    if (m.providers !== undefined && !(Array.isArray(m.providers) && m.providers.every((p) => typeof p === "string"))) errors.push(`entry ${i}: providers must be an array of provider ids.`);
    const projects = m.projects ?? {};
    if (typeof projects !== "object" || Array.isArray(projects) || !Object.values(projects).every((v) => typeof v === "string")) {
      errors.push(`entry ${i}: projects must map each project's canonicalKey (e.g. "github.com/owner/repo") to its project id there.`);
    }
  });
  if (errors.length) return { error: errors.join(" ") };
  return { machines: list.map((m) => ({ label: m.label, environmentId: m.environmentId, ...(Array.isArray(m.providers) ? { providers: m.providers } : {}), projects: m.projects || {} })) };
}

// Where a pick may go: this machine plus the run's registered boxes. Empty (no placement: it runs here)
// when the pick's run is unknown or has no boxes.
let placesMemo;
function runPlaces() {
  if (placesMemo) return placesMemo;
  const run = currentRun();
  const repo = currentRepoKey();
  const boxes = (run ? readLease(run)?.machines || [] : []).map((m) => {
    const projects = Object.fromEntries(Object.entries(m.projects || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
    return {
      id: String(m.environmentId), label: String(m.label), local: false,
      providers: Array.isArray(m.providers) ? new Set(m.providers.map(String)) : null,
      projectId: repo ? projects[repo] || null : null,
      repo,
    };
  });
  return (placesMemo = { run, envs: boxes.length ? [{ id: null, label: "local", local: true }, ...boxes] : [] });
}
function boxSummary(e) {
  return {
    label: e.label,
    ...(e.local ? { local: true } : { environmentId: e.id, providers: e.providers ? [...e.providers] : "any", projectHere: e.projectId || null }),
  };
}

const envKey = (env) => `env:${env.label}`;
function envCooldown(health, env) {
  for (const k of [envKey(env), env.id && `env:${env.id}`].filter(Boolean)) {
    const c = health.cooldowns[k];
    if (c && Date.parse(c.until) > Date.now()) return k;
  }
  return null;
}
// Why a box can't take this delegate, or null when it can. Correctness only, no policy.
function envMisfit(health, e, { provider }) {
  if (e.local) return envCooldown(health, e) ? `cooldown:${envKey(e)}` : null;
  if (e.providers && provider && !e.providers.has(provider)) return `provider ${provider} not signed in there`;
  if (!e.projectId) return e.repo ? `no project for ${e.repo} there` : "this checkout has no origin remote, so no project there matches it";
  const cd = envCooldown(health, e);
  return cd ? `cooldown:${cd}` : null;
}
/**
 * Choose where one worker runs: spread evenly over this machine and the run's boxes that can take it.
 * `place`: "local", "box" (any of the run's boxes) or a box label. Returns { env, skipped? } (env null
 * without boxes: it runs here) or { error, skipped? }.
 */
function chooseEnvironment(config, health, { provider, place = null, batch = null }) {
  const { envs, run } = runPlaces();
  if (envs.length === 0) {
    return place && place !== "local"
      ? { error: run ? `Run ${run} has no boxes registered (boxes register).` : "No run found for this pick: pass --run <runId>, or pick from the run's swarm/ branch." }
      : { env: null };
  }
  const skipped = [];
  const eligible = [];
  for (const e of envs) {
    const why = envMisfit(health, e, { provider });
    if (why) skipped.push({ environment: e.label, reason: why });
    else eligible.push(e);
  }
  let pool = eligible;
  if (place === "local") pool = eligible.filter((e) => e.local);
  else if (place === "box") pool = eligible.filter((e) => !e.local);
  else if (place) {
    const e = envs.find((x) => x.label === place || x.id === place);
    if (!e) return { error: `Unknown box "${place}". This run has: ${envs.filter((x) => !x.local).map((x) => x.label).join(", ")}.` };
    pool = eligible.filter((x) => x === e);
    if (!pool.length) return { error: `Can't place on ${e.label}: ${skipped.find((s) => s.environment === e.label)?.reason}.` };
  }
  if (!pool.length) return { error: `Nowhere to run this (${place || "any"}, ${provider}).`, skipped };
  const { chosen } = swrrPick(
    health.credits.envs,
    pool.map((e) => ({ e, id: e.label, weight: 1 })),
    (c) => batch?.get(c.id) || 0
  );
  if (batch) batch.set(chosen.id, (batch.get(chosen.id) || 0) + 1);
  return { env: chosen.e, ...(skipped.length ? { skipped } : {}) };
}
// Fold a placement into a pick: a box gets target.environmentId + projectId. `skipped` says why a box was
// passed over, so work that stays here (provider not signed in, project not on the box) shows.
function applyPlacement(pick, env, skipped) {
  if (!env) return pick;
  if (!env.local) pick.target = { ...pick.target, environmentId: env.id, projectId: env.projectId };
  pick.placement = { environment: env.label, remote: !env.local, ...(env.id ? { environmentId: env.id, projectId: env.projectId } : {}) };
  // T3 runs a task on a linked machine in that machine's checkout and refuses isolation "worktree" there.
  if (!env.local) pick.placement.note = `Runs in ${env.label}'s own checkout: leave isolation out (T3 refuses "worktree" there) and have the worker start in its own worktree from origin/<branch> (lead-brief: Machines).`;
  if (skipped?.length) pick.placement.skipped = skipped;
  return pick;
}

// The worker brief, verbatim: every worker task starts with it, then the scoped part. Returned with each
// pick so the delegating agent copies text it just read instead of retyping (and shortening) the file.
function readWorkerBrief() {
  try { return fs.readFileSync(path.join(REFERENCES_DIR, "worker-brief.md"), "utf8").trimEnd() + "\n"; } catch { return null; }
}

function parseSpec(spec, defaultDepth) {
  if (String(spec || "").includes("@")) {
    return { error: `"${spec}": tags are gone. Pick by tier:depth, and use --place local (or --place box / <label>) when the work must run somewhere in particular.` };
  }
  const [rawTier, rawDepth] = String(spec || "").split(":");
  const tier = rawTier?.trim().toLowerCase();
  const depth = rawDepth?.trim().toLowerCase() || defaultDepth || "medium";
  if (!VALID_TIERS.includes(tier)) {
    return { error: `Invalid tier "${tier}". Expected one of: ${VALID_TIERS.join(", ")}` };
  }
  if (!DEPTH_ORDER.includes(depth)) {
    return { error: `Invalid depth "${depth}". Expected one of: ${DEPTH_ORDER.join(", ")}` };
  }
  return { tier, depth };
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0];
  cliFlags = flags;

  if (!cmd || cmd === "help" || flags.help) {
    console.log(`t3-swarm router CLI

Commands:
  doctor                                   Validate config, buckets, write access & paths
  status                                   Show leads, resolved buckets, cooldowns & recent runs
  init <slug> [--goal "..."] [--streams a,b]  Create the run ledger; --streams adds one Lead per workstream
                                           (a ledger + branch each, and a board the Leads coordinate on)
  finish <run-id> [--force]                Archive a run (and its workstream ledgers/board) once Status: COMPLETE
  pick-lead [--run id] [--stream s] [--depth high]
                                           Pick the Lead (heavy pool as fallback); --run makes it stick to a run,
                                           --stream to one workstream of it (prefers a model no other stream uses)
  pick-worker <tier[:depth]> [--avoid b]   Pick one worker by quota weight (and, with boxes, where it runs)
  pick-workers <spec>... [--avoid b]       Pick a wave of workers in one call (spread over the run's boxes, if any)
  post <run-id> --from <stream> [--to s|all] [--kind k] [--paths "a,b"] "text"
                                           Post to the run's board: claim|release|contract|ack|ask|answer|note|done.
                                           A claim overlapping another stream's claim is refused until they agree.
                                           A contract needs --owner <stream|all> (who implements it); an ack
                                           names it ("#4 ok"); --replaces <n> supersedes contract #n.
  board <run-id> [--since n] [--for s]     Read the board: posts, who holds which paths, open asks, contracts
  cooldown <key> [duration] [--until t]    Put a key in cooldown (default: defaults.cooldownMinutes)
  clear-cooldown <key|all>                 Clear cooldown(s)
  boxes register|show --run <id> ['<json>']  Record or show a run's boxes (from the user's box skill + T3)

Cooldown keys (scope the cooldown to what actually ran out):
  <provider>:<model>   one model only, e.g. claudeAgent:claude-fable-5-2
  <bucket>             every model billed to that bucket, e.g. codex
  <provider>           every model on that T3 provider
  <model>              that model id on every provider
  globs                quote them, e.g. 'antigravity:claude-*'
Duration: minutes ("90") or "45m", "1h42m", "7d" (1 minute to 7 days).
--until: an ISO time, e.g. 2026-11-24T00:00:00Z (clamped to 7 days).

Options:
  --config <path>    Override config path (default: ~/.t3/swarm/config.json)
  --avoid <b1,b2>    Scale these buckets by weights.leadBucketMultiplier (default 0.5)
  --exclude <k1,k2>  Skip these for this pick (same key forms as cooldowns, e.g. claudeAgent:claude-fable-5-2)
  --force-wave       Bypass maxParallelWorkers cap on pick-workers
  --reason "..."     Optional note when setting a cooldown
  --force            finish: archive even if the ledger Status is not COMPLETE
  --run <run-id>     pick-lead: reuse this run's Lead while healthy; otherwise fail over and record it
  --stream <name>    pick-lead: the workstream this Lead owns (or "integrate" for the final merge pass,
                     refused until every workstream is COMPLETE and the board is settled; --force skips that)
  --place <where>    pick-worker(s): "local" (this machine), "box" (any of the run's boxes) or a box label

Boxes: the swarm doesn't start, stop or configure them. The Coordinator gets a run's boxes from the user's own
box skill, asks T3 what each can run (orchestrator_capabilities, t3_project_list), and registers them:
\`boxes register --run <id> '[{ "label": "box-1", "environmentId": "<id>", "providers": ["claudeAgent"],
"projects": { "github.com/owner/repo": "<project id>" } }]'\` (replaces the run's list). Workers spread evenly
over this machine and the run's boxes; --place local | box | <label> pins one. A box is skipped when the
picked provider isn't signed in there, this repo's project isn't there, or it is cooled down
(\`cooldown env:box-1 30m\`). finish lists the run's boxes so the Coordinator releases them.

Viewer (config "viewer"): { enabled: true, port: 4777 } makes init return the command that starts the
live view (scripts/swarm-viz.mjs) for the run; finish stops it. Off by default.

Weights (config "weights"): buckets {bucket: n} sets each quota bucket's share of work (default 1; 0 =
only when nothing else is available); a per-entry "weight" overrides one model in one tier.
leadSelection "priority" (default) | "weighted"; leadBucketMultiplier (default 0.5); maxSessionsPerBucket.
Status updates (config "statusUpdates"): optional { enabled: true, intervalMinutes: 15 } schedules T3
interval progress updates during Mode 2 runs (off by default).
`);
    return;
  }

  if (!KNOWN_COMMANDS.has(cmd)) {
    out({ ok: false, error: `Unknown command "${cmd}". Run with --help.` }, 1);
    return;
  }

  // Cooldown commands work even before full setup, with validation & warnings
  if (cmd === "cooldown") {
    const key = positional[1];
    if (!key) {
      out({ ok: false, error: "Usage: swarm.mjs cooldown <key> [duration] [--until <ISO time>]" }, 1);
      return;
    }
    const loaded = loadConfig(flags.config);
    const warnings = [];
    let untilMs;
    let minutes;
    if (flags.until !== undefined) {
      if (positional[2]) {
        out({ ok: false, error: "Pass either a duration or --until, not both." }, 1);
        return;
      }
      const parsedUntil = typeof flags.until === "string" ? Date.parse(flags.until) : NaN;
      if (!Number.isFinite(parsedUntil)) {
        out({ ok: false, error: `Invalid --until "${flags.until}". Use an ISO time such as 2026-11-24T00:00:00Z.` }, 1);
        return;
      }
      if (parsedUntil <= Date.now()) {
        out({ ok: false, error: `--until ${flags.until} has already passed.` }, 1);
        return;
      }
      untilMs = parsedUntil;
      const maxUntil = Date.now() + MAX_COOLDOWN_MINUTES * 60_000;
      if (untilMs > maxUntil) {
        untilMs = maxUntil;
        warnings.push(`--until is more than 7 days away; clamped to ${new Date(untilMs).toISOString()}.`);
      }
      minutes = Math.ceil((untilMs - Date.now()) / 60_000);
    } else {
      const defaultMins = loaded.ok ? loaded.config.defaults?.cooldownMinutes ?? 60 : 60;
      minutes = positional[2] ? parseDurationMinutes(positional[2]) : defaultMins;
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_COOLDOWN_MINUTES) {
        out(
          {
            ok: false,
            error: `Invalid duration "${positional[2]}". Use minutes or e.g. 45m, 1h42m, 7d (1 minute to 7 days).`,
          },
          1
        );
        return;
      }
      untilMs = Date.now() + minutes * 60_000;
    }

    const envMatches = loaded.ok && key.startsWith("env:")
      ? runPlaces().envs.filter((e) => key === envKey(e) || (e.id && key === `env:${e.id}`)).map((e) => ({ environment: e.label, remote: !e.local }))
      : [];
    const affects = envMatches.length ? envMatches : loaded.ok ? entriesMatchingKey(loaded.config, key) : [];
    if (loaded.ok && affects.length === 0) {
      warnings.push(`"${key}" matches no configured lead or worker; cooldown saved anyway.`);
    }
    const res = await withHealth(async (health) => {
      health.cooldowns[key] = {
        until: new Date(untilMs).toISOString(),
        minutes,
        reason: typeof flags.reason === "string" ? flags.reason : "quota_or_rate_limit",
        setAt: new Date().toISOString(),
      };
      let leadCheck = {};
      if (loaded.ok) {
        const depth = loaded.config.defaults?.leadDepth || "high";
        const { healthy } = await rankLeads(loaded.config, health, depth, new Set());
        const fromLeads = healthy.filter((h) => h.source === "leads");
        leadCheck = {
          healthyLeads: fromLeads.length,
          availableLeads: healthy.map((h) => `${entryId(h.lead)}${h.source === "leads" ? "" : " (heavy fallback)"}`),
        };
        if (healthy.length === 0) {
          warnings.push(
            "No Lead can run now. If only one model ran out, clear this key and cool down `<provider>:<model>` instead of the whole bucket."
          );
        } else if (fromLeads.length === 0) {
          warnings.push("Every configured lead is in cooldown; pick-lead will use the heavy worker pool.");
        }
      }
      return {
        save: true,
        payload: {
          ok: true,
          key,
          cooldown: health.cooldowns[key],
          affects,
          ...leadCheck,
          ...(warnings.length ? { warnings } : {}),
        },
      };
    });
    out(res, res.ok ? 0 : 1);
    return;
  }

  if (cmd === "clear-cooldown") {
    const key = positional[1];
    if (!key) {
      out({ ok: false, error: "Usage: swarm.mjs clear-cooldown <key|all>" }, 1);
      return;
    }
    const res = await withHealth((health) => {
      const existed = key === "all" || Object.prototype.hasOwnProperty.call(health.cooldowns, key);
      if (key === "all") health.cooldowns = {};
      else delete health.cooldowns[key];
      return {
        save: true,
        payload: { ok: true, cleared: key, existed, activeCooldowns: health.cooldowns },
      };
    });
    out(res, res.ok ? 0 : 1);
    return;
  }

  // Leads of one run coordinate here. `post` appends under a lock; a claim that overlaps another
  // workstream's active claim is refused (not recorded) so the two Leads have to agree first.
  if (cmd === "post") {
    const runId = positional[1];
    let text = positional.slice(2).join(" ").replace(/\s+/g, " ").trim();
    const kind = typeof flags.kind === "string" ? flags.kind : "note";
    const from = typeof flags.from === "string" ? flags.from : null;
    const to = typeof flags.to === "string" ? flags.to : "all";
    const paths = typeof flags.paths === "string" ? flags.paths.split(",").map((p) => p.trim()).filter(Boolean) : [];
    if (!runId || !from) {
      out({ ok: false, error: 'Usage: swarm.mjs post <run-id> --from <stream> [--to <stream|all|coordinator>] [--kind claim|release|contract|ack|ask|answer|note|done] [--paths "a,b"] [--owner <stream|all> (contract)] [--replaces <n> (contract)] "text"' }, 1);
      return;
    }
    if (!BOARD_KINDS.includes(kind)) {
      out({ ok: false, error: `Unknown --kind "${kind}". Use one of: ${BOARD_KINDS.join(", ")}.` }, 1);
      return;
    }
    const streams = runStreams(runId);
    const known = new Set([...streams, "coordinator", "integrate"]);
    if (!known.has(from) || (to !== "all" && !known.has(to))) {
      out({ ok: false, error: `--from/--to must be one of: ${[...known].join(", ")}${to !== "all" ? ", all" : ""}.` }, 1);
      return;
    }
    if (kind === "claim" && !paths.length) {
      out({ ok: false, error: 'A claim needs --paths "dir/or/file,..." (what you will edit).' }, 1);
      return;
    }
    if ((flags.owner !== undefined || flags.replaces !== undefined) && kind !== "contract") {
      out({ ok: false, error: "--owner and --replaces only go with --kind contract." }, 1);
      return;
    }
    if (kind === "contract") {
      const owner = typeof flags.owner === "string" ? flags.owner : null;
      if (!owner || (owner !== "all" && !streams.includes(owner))) {
        out({ ok: false, error: `A contract needs --owner <stream>: the workstream that implements it (one of: ${streams.join(", ")}), or --owner all when each workstream implements its own side. The owner claims the paths and acks it.` }, 1);
        return;
      }
      const replaces = flags.replaces !== undefined ? Number(String(flags.replaces).replace(/^#/, "")) : null;
      if (replaces !== null && !(Number.isInteger(replaces) && replaces > 0)) {
        out({ ok: false, error: "--replaces needs the number of the contract it supersedes (e.g. --replaces 4)." }, 1);
        return;
      }
      text = `[owner: ${owner}${replaces ? `, replaces #${replaces}` : ""}] ${text}`.trim();
    }
    const file = boardFilePath(runId);
    if (!fs.existsSync(file)) {
      out({ ok: false, error: `No board for ${runId} (it is created by \`init --streams\`).` }, 1);
      return;
    }
    const rows = workstreamRows(runId);
    const result = withFileLock(file, () => {
      const { posts } = readBoard(runId);
      const before = boardState(posts, streams);
      const contractNs = new Set(before.contracts.map((c) => c.n));
      if (kind === "claim") {
        const conflicts = [];
        for (const [owner, held] of activeClaims(posts)) {
          if (owner === from) continue;
          const hit = held.filter((h) => paths.some((p) => claimsOverlap(p, h)));
          if (hit.length) conflicts.push({ owner, paths: hit, ...(rows[owner]?.thread ? { leadThread: rows[owner].thread } : {}) });
        }
        if (conflicts.length) {
          return {
            ok: false,
            status: "conflict",
            conflicts,
            hint: "Not recorded. Ask the owner (post --kind ask --to <owner> --paths <paths>) to release it, split it, or agree a contract where one side owns the shared piece. If it blocks you, also t3_thread_send its leadThread.",
          };
        }
      }
      if (kind === "contract") {
        const r = parseContract({ text }).replaces;
        if (r && !contractNs.has(r)) return { ok: false, error: `#${r} is not a contract on this board; --replaces names the contract this one supersedes.` };
      }
      if (kind === "ack") {
        const refs = [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
        if (!refs.length || refs.some((r) => !contractNs.has(r))) {
          return { ok: false, error: `An ack names the contract it accepts: post --kind ack "#<n> ok". Contracts on this board: ${[...contractNs].map((x) => "#" + x).join(", ") || "none"}.` };
        }
      }
      const n = (posts.length ? posts[posts.length - 1].n : 0) + 1;
      const at = new Date().toISOString();
      const line = `- #${n} | ${at} | ${from} → ${to} | ${kind} | ${paths.length ? paths.join(", ") : "-"} | ${text}\n`;
      fs.appendFileSync(file, line, "utf8");
      const after = [...posts, { n, at, from, to, kind, paths, text }];
      const res = { ok: true, posted: { n, at, from, to, kind, paths, text }, claims: Object.fromEntries(activeClaims(after)) };
      const warnings = [];
      if (kind === "ask" && to !== "all" && to !== "coordinator" && before.done.has(to)) {
        warnings.push(`${to} has posted done: its Lead has finished and won't read this. Don't t3_thread_send it (that starts a new task); ask the coordinator instead (--to coordinator), and return STATUS: ESCALATE if it blocks you.`);
      }
      if (kind === "done") {
        const issues = unsettled(boardState(after, streams), from);
        if (issues.length) {
          res.unsettled = issues;
          warnings.push("Recorded, but contracts or asks involving you are unsettled (see `unsettled`). List them in your STATUS: COMPLETE; the integration pass won't start until the Coordinator settles them.");
        }
      }
      if (warnings.length) res.warnings = warnings;
      return res;
    });
    out(result, result.ok ? 0 : 1);
    return;
  }

  if (cmd === "board") {
    const runId = positional[1];
    if (!runId) {
      out({ ok: false, error: "Usage: swarm.mjs board <run-id> [--since <n>] [--for <stream>]" }, 1);
      return;
    }
    const board = readBoard(runId);
    if (!board) {
      out({ ok: false, error: `No board for ${runId}.` }, 1);
      return;
    }
    const since = Number(flags.since ?? 0) || 0;
    const forStream = typeof flags.for === "string" ? flags.for : null;
    // Contracts concern everyone, so --for keeps them along with posts to/from that workstream.
    const posts = board.posts.filter((p) => p.n > since && (!forStream || p.to === "all" || p.to === forStream || p.from === forStream || p.kind === "contract"));
    const names = runStreams(runId);
    const state = boardState(board.posts, names);
    const rows = workstreamRows(runId);
    out({
      ok: true,
      runId,
      boardPath: board.file,
      lastN: board.posts.length ? board.posts[board.posts.length - 1].n : 0,
      // Each Lead's thread comes from the run ledger's Workstreams rows, which fill in as Leads start:
      // read it here rather than from your first read of the ledger. A `done` Lead has finished.
      streams: names.map((st) => ({
        name: st,
        status: readLedgerStatus(streamLedgerPath(runId, st)),
        lead: rows[st]?.lead ?? null,
        leadThread: rows[st]?.thread ?? null,
        done: state.done.has(st),
      })),
      claims: state.claims,
      openAsks: state.openAsks,
      contracts: state.contracts,
      posts,
    });
    return;
  }

  if (cmd === "finish") {
    const runId = positional[1];
    if (!runId) {
      out({ ok: false, error: "Usage: swarm.mjs finish <run-id> [--force]" }, 1);
      return;
    }
    const fileName = runId.endsWith(".md") ? runId : `${runId}.md`;
    const src = path.join(RUNS_DIR, path.basename(fileName));
    if (!fs.existsSync(src)) {
      out({ ok: false, error: `Run file not found: ${src}` }, 1);
      return;
    }
    const runStatus = readLedgerStatus(src);
    const streamStatuses = runStreams(path.basename(fileName, ".md")).map((st) => ({ name: st, status: readLedgerStatus(streamLedgerPath(path.basename(fileName, ".md"), st)) }));
    if (runStatus !== "COMPLETE" && !flags.force) {
      out(
        {
          ok: false,
          status: "not_complete",
          runStatus,
          error:
            `Ledger Status is ${runStatus ?? "missing"}, not COMPLETE. The Lead may still be running: ` +
            "wait for its STATUS: COMPLETE. Pass --force only to archive an abandoned run.",
        },
        1
      );
      return;
    }
    const viewerStopped = stopViewer(path.basename(fileName, ".md"));
    // The run's boxes, so the Coordinator lets them go through the box skill that brought them up.
    const runBoxes = readLease(path.basename(fileName, ".md"))?.machines || [];
    ensureDir(ARCHIVE_DIR);
    const dest = path.join(ARCHIVE_DIR, path.basename(fileName));
    fs.renameSync(src, dest);
    // Companion files (e.g. <run-id>.findings-review.txt) move with the ledger.
    const prefix = `${path.basename(fileName, ".md")}.`;
    const companions = fs
      .readdirSync(RUNS_DIR)
      .filter((f) => f.startsWith(prefix))
      .map((f) => {
        const to = path.join(ARCHIVE_DIR, f);
        fs.renameSync(path.join(RUNS_DIR, f), to);
        return to;
      });
    out({
      ok: true,
      archivedTo: dest,
      ...(companions.length ? { companions } : {}),
      ...(streamStatuses.length ? { streams: streamStatuses } : {}),
      ...(viewerStopped !== null ? { viewerStopped } : {}),
      ...(runBoxes.length
        ? { boxes: runBoxes.map((m) => ({ label: m.label, environmentId: m.environmentId })), next: `Release these boxes through the box skill that brought them up, for run ${path.basename(fileName, ".md")}.` }
        : {}),
      runStatus,
      ...(runStatus !== "COMPLETE" ? { forced: true } : {}),
    });
    return;
  }

  // Config-backed commands
  const loaded = loadConfig(flags.config);
  if (!loaded.ok) {
    out(
      {
        ok: false,
        status: loaded.status,
        configPath: loaded.configPath,
        configSource: loaded.configSource || "global",
        scriptPath: SCRIPT_PATH,
        referencesDir: REFERENCES_DIR,
        hint: "Run the t3-swarm-setup skill to generate ~/.t3/swarm/config.json from your enabled T3 providers.",
        ...(loaded.error ? { error: loaded.error } : {}),
      },
      cmd === "doctor" ? 0 : 2
    );
    return;
  }

  const { config, configPath, configSource, projectOverridePath } = loaded;

  // A run's boxes: `register` records the list the Coordinator got from the box skill and T3 (it replaces the
  // run's list; [] clears it), `show` prints it. Starting and stopping boxes is the box skill's job.
  if (cmd === "boxes") {
    const verb = positional[1] || "show";
    if (!["register", "show"].includes(verb)) {
      out({ ok: false, error: "Usage: swarm.mjs boxes register|show --run <runId> ['<json>']. Boxes are started and stopped by the user's box skill, not the swarm." }, 1);
      return;
    }
    const runId = typeof flags.run === "string" ? flags.run : currentRun();
    if (!runId) {
      out({ ok: false, error: "Pass --run <runId> (or run this from the run's swarm/ branch)." }, 1);
      return;
    }
    if (!fs.existsSync(runLedgerPath(runId))) {
      out({ ok: false, error: `Run ${runId} not found in ${RUNS_DIR}: boxes belong to a run that init created.` }, 1);
      return;
    }
    if (verb === "register") {
      const raw = positional[2] !== undefined && positional[2] !== "-" ? positional[2] : fs.readFileSync(0, "utf8");
      const parsed = parseRegisterInput(raw);
      if (parsed.error) {
        out({ ok: false, error: parsed.error }, 1);
        return;
      }
      withFileLock(leasePath(runId), () => {
        if (parsed.machines.length) atomicWriteJson(leasePath(runId), { at: new Date().toISOString(), machines: parsed.machines });
        else try { fs.unlinkSync(leasePath(runId)); } catch {}
      });
    }
    placesMemo = undefined;
    cliFlags = { ...cliFlags, run: runId };
    const boxes = runPlaces().envs.filter((e) => !e.local);
    const repo = currentRepoKey();
    out({
      ok: true,
      run: runId,
      repo,
      machines: boxes.map(boxSummary),
      ...(boxes.length && !boxes.some((e) => e.projectId)
        ? { warning: repo ? `No box of this run has a project for ${repo}: picks from this checkout stay here.` : "This checkout has no origin remote, so no box's project matches it: picks stay here." }
        : {}),
    });
    return;
  }

  if (cmd === "doctor") {
    const { errors, warnings } = validateConfig(config);
    const writable = checkWritable(SWARM_HOME);
    if (!writable) {
      errors.push(`SWARM_HOME (${SWARM_HOME}) is not writable. Mode 2 requires auto or full-access runtime mode.`);
    }
    const healthRes = await withHealth((health) => ({
      save: false,
      payload: { ok: true, activeCooldowns: health.cooldowns },
    }));
    if (!healthRes.ok) {
      out(healthRes, 1);
      return;
    }

    const resolvedLeads = (config.leads || []).map((l, i) => ({
      priority: i + 1,
      provider: l?.provider,
      model: l?.model,
      bucket: l?.provider && l?.model ? getBucket(config, l) : null,
      weight: l?.provider && l?.model ? baseWeight(config, l) : null,
    }));
    const resolvedWorkers = Object.fromEntries(
      VALID_TIERS.map((t) => [
        t,
        (config.workers?.[t] || []).map((w) => ({
          provider: w?.provider,
          model: w?.model,
          bucket: w?.provider && w?.model ? getBucket(config, w) : null,
          weight: w?.provider && w?.model ? baseWeight(config, w) : null,
        })),
      ])
    );
    const wc = weightsCfg(config);
    const selection = {
      leadSelection: wc.leadSelection === "weighted" ? "weighted" : "priority",
      leadBucketMultiplier: avoidMultiplier(config),
      maxSessionsPerBucket: Number.isInteger(wc.maxSessionsPerBucket) ? wc.maxSessionsPerBucket : null,
    };

    out(
      {
        ok: errors.length === 0,
        status: errors.length === 0 ? "ready" : "invalid",
        configPath,
        configSource,
        ...(projectOverridePath ? { projectOverridePath } : {}),
        scriptPath: SCRIPT_PATH,
        referencesDir: REFERENCES_DIR,
        swarmHome: SWARM_HOME,
        writable,
        hooksLoaded: fs.existsSync(HOOKS_PATH),
        selection,
        statusUpdates: resolveStatusUpdates(config),
        viewer: resolveViewer(config),
        leads: resolvedLeads,
        workers: resolvedWorkers,
        activeCooldowns: healthRes.activeCooldowns,
        errors,
        warnings,
      },
      errors.length === 0 ? 0 : 1
    );
    return;
  }

  if (cmd === "status") {
    const healthRes = await withHealth((health) => ({
      save: false,
      payload: {
        ok: true,
        activeCooldowns: health.cooldowns,
        credits: health.credits,
        leads: (config.leads || []).map((l, i) => ({
          priority: i + 1,
          provider: l.provider,
          bucket: getBucket(config, l),
          model: l.model,
          cooldownKey: l?.provider && l?.model ? activeCooldownKey(config, health, l) : null,
        })),
      },
    }));
    if (!healthRes.ok) {
      out(healthRes, 1);
      return;
    }

    let recentRuns = [];
    if (fs.existsSync(RUNS_DIR)) {
      recentRuns = fs
        .readdirSync(RUNS_DIR)
        .filter((f) => f.endsWith(".md") && RUN_ID_RE.test(f.slice(0, -3))) // not workstream ledgers or boards
        .sort()
        .reverse()
        .slice(0, 5)
        .map((f) => {
          const fullPath = path.join(RUNS_DIR, f);
          const stat = fs.statSync(fullPath);
          return {
            runId: path.basename(f, ".md"),
            path: fullPath,
            status: readLedgerStatus(fullPath),
            updatedAt: stat.mtime.toISOString(),
            ageMinutes: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 60_000)),
            ...(() => {
              const streams = runStreams(path.basename(f, ".md"));
              return streams.length ? { streams: streams.map((st) => ({ name: st, status: readLedgerStatus(streamLedgerPath(path.basename(f, ".md"), st)) })) } : {};
            })(),
          };
        });
    }

    out({
      ok: true,
      configPath,
      configSource,
      ...(projectOverridePath ? { projectOverridePath } : {}),
      scriptPath: SCRIPT_PATH,
      referencesDir: REFERENCES_DIR,
      leads: healthRes.leads,
      activeCooldowns: healthRes.activeCooldowns,
      credits: healthRes.credits,
      statusUpdates: resolveStatusUpdates(config),
      ...(runPlaces().envs.length
        ? { boxes: { run: runPlaces().run, machines: runPlaces().envs.map((e) => ({ ...boxSummary(e), cooldown: envCooldown({ cooldowns: healthRes.activeCooldowns }, e) })) } }
        : {}),
      recentRuns,
    });
    return;
  }

  if (cmd === "init") {
    const slug = slugify(positional[1] || "task");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const rand = crypto.randomBytes(2).toString("hex");
    const runId = `${stamp}-${slug}-${rand}`;
    ensureDir(RUNS_DIR);
    const statePath = path.join(RUNS_DIR, `${runId}.md`);
    const goal =
      typeof flags.goal === "string" ? flags.goal : "(Coordinator: fill in 1-2 sentence goal)";
    const git = getGitInfo();
    const integrationBranch = git.isGitRepo ? `swarm/${runId}` : null;
    const leadBriefPath = path.join(REFERENCES_DIR, "lead-brief.md");
    const workerBriefPath = path.join(REFERENCES_DIR, "worker-brief.md");
    const maxWorkerLoops = config.defaults?.maxWorkerLoops ?? 2;
    const maxParallelWorkers = config.defaults?.maxParallelWorkers ?? 4;
    const worktreeForParallelEdits = config.defaults?.worktreeForParallelEdits !== false;
    const content = `# Swarm Run: ${runId}
- **Status:** RUNNING

## Goal & Boundaries
- **Goal:** ${goal}
- **Done criteria:** (tests/checks required before completion)
- **Verify:** targeted (workers): (narrowest test/lint command per area) | full gate (Lead only, once, on the integration branch): (command)
- **Boundaries:** (out-of-scope or constraints)
- **Config:** \`${configPath}\` (${configSource})
- **Runtime:** \`script: ${SCRIPT_PATH}\` | \`leadBrief: ${leadBriefPath}\` | \`workerBrief: ${workerBriefPath}\` | \`worktreeParallel: ${worktreeForParallelEdits}\` | \`maxLoops: ${maxWorkerLoops}\` | \`maxParallel: ${maxParallelWorkers}\`${
      git.isGitRepo
        ? `\n- **Git Base:** \`${git.branch}@${git.commit}\` (dirty: ${git.dirty}) | **Integration Branch:** \`${integrationBranch}\``
        : ""
    }

## Tasks
- [ ] (Lead fills concise rows: task | tier:depth | taskId:<id> | branch@sha | loops:0 | pending)

## Decisions
- (Append 1-line engineering decisions or resolved blockers here)
`;
    if (flags.streams !== undefined) {
      const parsedStreams = parseStreams(flags.streams, config);
      if (parsedStreams.error) {
        out({ ok: false, error: parsedStreams.error }, 1);
        return;
      }
      const { streams } = parsedStreams;
      // Worker budget is shared: N Leads each running maxParallelWorkers would multiply machine load.
      const total = config.defaults?.maxParallelWorkersTotal ?? maxParallelWorkers;
      const perStream = Math.max(1, Math.floor(total / streams.length));
      const boardPath = boardFilePath(runId);
      const branchOf = (st) => (integrationBranch ? `${integrationBranch}--${st}` : null); // not swarm/<id>/<st>: git can't nest refs under a branch
      const runtime = (extra) =>
        `\`script: ${SCRIPT_PATH}\` | \`leadBrief: ${leadBriefPath}\` | \`workerBrief: ${workerBriefPath}\` | \`worktreeParallel: ${worktreeForParallelEdits}\` | \`maxLoops: ${maxWorkerLoops}\` | \`maxParallel: ${extra.maxParallel}\` | \`board: ${boardPath}\`${extra.stream ? ` | \`stream: ${extra.stream}\`` : ""}`;
      const gitLine = (branch) =>
        git.isGitRepo ? `\n- **Git Base:** \`${git.branch}@${git.commit}\` (dirty: ${git.dirty}) | **Integration Branch:** \`${branch}\`` : "";
      const runContent = `# Swarm Run: ${runId}
- **Status:** RUNNING
- **Workstreams:** ${streams.join(", ")} (one Lead each; the integration pass merges them)

## Goal & Boundaries
- **Goal:** ${goal}
- **Done criteria:** (tests/checks required before completion)
- **Verify:** targeted (workers): (narrowest test/lint command per area) | stream gate (each Lead, once, on its stream branch): (command) | full gate (integration pass only, once, on the integration branch): (command)
- **Boundaries:** (shared by every workstream; split shared limits per workstream, e.g. "1 Android build at a time: android only")
- **Config:** \`${configPath}\` (${configSource})
- **Runtime:** ${runtime({ maxParallel: total })}${gitLine(integrationBranch)}

## Workstreams
${streams.map((st) => `- ${st} | ledger: \`${streamLedgerPath(runId, st)}\` | branch: \`${branchOf(st) ?? "(no git)"}\` | lead: (pending) | thread: (pending) | status: RUNNING`).join("\n")}

## Contracts
- (Shared interfaces every workstream honours, one owner each: API shapes, data/save formats, string keys, events, flags. Changes go through the board.)

## Tasks
- [ ] (Integration pass: merge order, conflicts, full gate result)

## Decisions
- (Append 1-line engineering decisions or resolved blockers here)
`;
      const streamContent = (st) => `# Swarm Run: ${runId} (workstream ${st})
- **Status:** RUNNING
- **Workstream:** \`${st}\` | others: ${streams.filter((x) => x !== st).join(", ")} | run ledger: \`${statePath}\` | board: \`${boardPath}\`

## Goal & Boundaries
- **Goal:** (Coordinator: this workstream's slice of the run goal)
- **Files in scope:** (paths this workstream owns; anything else needs a claim on the board first)
- **Done criteria:** (tests/checks required before this workstream is done)
- **Verify:** targeted (workers): (narrowest test/lint command per area) | stream gate (this Lead, once, on the stream branch): (command); the full gate runs once in the integration pass
- **Boundaries:** the run ledger's boundaries apply here too, plus: (this workstream's share of shared limits)
- **Config:** \`${configPath}\` (${configSource})
- **Runtime:** ${runtime({ maxParallel: perStream, stream: st })}${gitLine(branchOf(st))}

## Tasks
- [ ] (Lead fills concise rows: task | tier:depth | taskId:<id> | branch@sha | loops:0 | pending)

## Decisions
- (Append 1-line engineering decisions or resolved blockers here)
`;
      fs.writeFileSync(statePath, runContent, { encoding: "utf8", flag: "wx" });
      for (const st of streams) fs.writeFileSync(streamLedgerPath(runId, st), streamContent(st), { encoding: "utf8", flag: "wx" });
      fs.writeFileSync(
        boardPath,
        `# Board: ${runId}\n<!-- Leads post with \`swarm.mjs post\` and read with \`swarm.mjs board\`; don't edit by hand. -->\n`,
        { encoding: "utf8", flag: "wx" }
      );
      out({
        ok: true,
        runId,
        statePath,
        boardPath,
        streams: streams.map((st) => ({ name: st, statePath: streamLedgerPath(runId, st), branch: branchOf(st), maxParallel: perStream })),
        configPath,
        configSource,
        scriptPath: SCRIPT_PATH,
        referencesDir: REFERENCES_DIR,
        leadBriefPath,
        workerBriefPath,
        maxWorkerLoops,
        maxParallelWorkers: total,
        worktreeForParallelEdits,
        statusUpdates: resolveStatusUpdates(config),
        viewer: resolveViewer(config, runId),
        git,
        integrationBranch,
      });
      return;
    }

    fs.writeFileSync(statePath, content, { encoding: "utf8", flag: "wx" });
    out({
      ok: true,
      runId,
      statePath,
      configPath,
      configSource,
      scriptPath: SCRIPT_PATH,
      referencesDir: REFERENCES_DIR,
      leadBriefPath,
      workerBriefPath,
      maxWorkerLoops,
      maxParallelWorkers,
      worktreeForParallelEdits,
      statusUpdates: resolveStatusUpdates(config),
      viewer: resolveViewer(config, runId),
      git,
      integrationBranch,
    });
    return;
  }

  if (cmd === "pick-lead") {
    const depth =
      (typeof flags.depth === "string" ? flags.depth : config.defaults?.leadDepth) || "high";
    if (!DEPTH_ORDER.includes(depth)) {
      out({ ok: false, error: `Invalid depth "${depth}". Expected: ${DEPTH_ORDER.join(", ")}.` }, 1);
      return;
    }
    const excludeSet = parseCsvSet(flags.exclude);
    if (flags.run === true) {
      out({ ok: false, error: "--run needs the run id from `init`." }, 1);
      return;
    }
    const runId = typeof flags.run === "string" ? flags.run : null;
    const stream = typeof flags.stream === "string" ? slugify(flags.stream).slice(0, 24) : null;
    if (flags.stream !== undefined && (!stream || !runId)) {
      out({ ok: false, error: "--stream needs a workstream name and --run <run-id>." }, 1);
      return;
    }
    if (runId && !stream && runStreams(runId).length) {
      // A workstream Lead recovering after compaction must name its workstream, or it would make a fresh
      // pick under the plain run key (charging credits, maybe a different bucket).
      out({ ok: false, status: "stream_required", error: `Run ${runId} has workstreams (${runStreams(runId).join(", ")}). Pass --stream <name>: yours is in STATE.md's Runtime line (\`stream: ...\`); the final merge pass uses --stream integrate.` }, 1);
      return;
    }
    if (stream && stream !== "integrate" && !runStreams(runId).includes(stream)) {
      out({ ok: false, error: `Run ${runId} has no workstream "${stream}". Known: ${runStreams(runId).join(", ") || "none"}.` }, 1);
      return;
    }
    const res = await withHealth(async (health) => {
      // The integration pass merges what the workstreams built, so it waits until the board is settled:
      // every workstream COMPLETE, every contract owned and acked, no open asks. Checked on the first
      // pick only; a failover of the integration Lead goes straight through.
      if (stream === "integrate" && !health.leadPicks[`${runId}#integrate`] && !flags.force) {
        const names = runStreams(runId);
        const board = readBoard(runId);
        const issues = board ? unsettled(boardState(board.posts, names)) : [];
        for (const st of names) {
          const s = readLedgerStatus(streamLedgerPath(runId, st));
          if (s !== "COMPLETE") issues.unshift({ workstream: st, status: s || "unknown" });
        }
        if (issues.length) {
          return {
            save: false,
            payload: {
              ok: false,
              status: "board_unsettled",
              error: `Run ${runId} isn't ready for the integration pass.`,
              issues,
              hint: "Settle each issue first: a workstream not COMPLETE is still running (or needs its Lead's outcome handled); a contract with missing acks needs its owner's confirmation: check the owner's branch and `post <run> --from coordinator --kind ack \"#<n> verified\"`, or re-dispatch that Lead with the question; a contract with no owner gets a replacement (`post --from coordinator --kind contract --owner <stream> --replaces <n>`); answer open asks with `post --from coordinator --kind answer --to <asker>`. Pass --force to integrate anyway.",
            },
          };
        }
      }
      const { healthy, skipped } = await rankLeads(config, health, depth, excludeSet);

      if (healthy.length === 0) {
        return {
          save: false,
          payload: {
            ok: false,
            status: "no_healthy_lead",
            error: `No eligible Lead available for depth "${depth}" (configured leads and heavy fallback).`,
            hint:
              "Check `skipped`: if a whole bucket is cooled down for one model's limit, clear it and cool down `<provider>:<model>` instead. Then ask the user in plain text.",
            skipped,
            activeCooldowns: health.cooldowns,
          },
        };
      }

      const choice = chooseLead(config, health, healthy, runId, stream);
      const chosen = choice.chosen;
      // Leads always stay on this machine: one router and one health.json route every quota.
      const next = healthy.find((h) => h !== chosen);
      const nextFallback = next
        ? { provider: next.lead.provider, bucket: next.bucket, model: next.lead.model, source: next.source }
        : null;
      const built = buildTarget(config, chosen.lead, depth);
      const { target } = built;
      const { depthDropped } = built;
      const others = runId && stream && stream !== "integrate"
        ? Object.fromEntries(Object.entries(health.leadPicks).filter(([k]) => k.startsWith(`${runId}#`) && k !== `${runId}#${stream}`).map(([k, v]) => [k.slice(runId.length + 1), v.id]))
        : null;

      return {
        save: choice.changed,
        payload: {
          ok: true,
          ...(stream ? { stream, statePath: stream === "integrate" ? runLedgerPath(runId) : streamLedgerPath(runId, stream), boardPath: boardFilePath(runId) } : {}),
          ...(others && Object.keys(others).length ? { otherStreamLeads: others } : {}),
          ...(choice.sharedWith ? { sharedWith: choice.sharedWith, note: `No free lead; sharing a model with workstream "${choice.sharedWith}".` } : {}),
          priority: chosen.priority,
          source: chosen.source,
          selection: weightsCfg(config).leadSelection === "weighted" ? "weighted" : "priority",
          weight: chosen.weight,
          ...(runId ? { runId, sticky: choice.sticky } : {}),
          ...(choice.failoverFrom ? { failoverFrom: choice.failoverFrom, refunded: choice.refunded } : {}),
          ...(chosen.source === "heavy-fallback"
            ? { note: "Every configured lead is unavailable; using the heavy worker pool as Lead." }
            : {}),
          ...(skipped.length ? { skipped } : {}),
          depth,
          bucket: chosen.bucket,
          target,
          depthDropped,
          fallbackAvailable: Boolean(nextFallback),
          nextFallback,
          configPath,
          configSource,
          scriptPath: SCRIPT_PATH,
          leadBriefPath: path.join(REFERENCES_DIR, "lead-brief.md"),
          workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
        },
      };
    });
    out(res, res.ok ? 0 : 1);
    return;
  }

  if (cmd === "pick-worker") {
    const specArg = positional[1] || "balanced";
    const parsed = parseSpec(specArg, config.defaults?.workerDepth || "medium");
    if (parsed.error) {
      out({ ok: false, error: parsed.error }, 1);
      return;
    }

    const avoidSet = parseCsvSet(flags.avoid);
    const excludeSet = parseCsvSet(flags.exclude);
    const res = await withHealth(async (health) => {
      const pick = await selectOneWorker(config, health, parsed.tier, parsed.depth, avoidSet, excludeSet, null, {
        place: typeof flags.place === "string" ? flags.place : null,
      });
      return {
        save: pick.ok,
        payload: {
          ...pick,
          configSource,
          workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
          ...(pick.ok ? { workerBrief: readWorkerBrief() } : {}),
        },
      };
    });
    out(res, res.ok ? 0 : 1);
    return;
  }

  if (cmd === "pick-workers") {
    const specs = positional.slice(1);
    if (specs.length === 0) {
      out(
        {
          ok: false,
          error: "Usage: swarm.mjs pick-workers <tier[:depth]> [tier[:depth]...] [--avoid bucket]",
        },
        1
      );
      return;
    }

    const maxParallel = config.defaults?.maxParallelWorkers ?? 4;
    if (!flags["force-wave"] && specs.length > maxParallel) {
      out(
        {
          ok: false,
          error: `Requested ${specs.length} parallel workers, exceeding maxParallelWorkers (${maxParallel}). Split into smaller waves or pass --force-wave.`,
        },
        1
      );
      return;
    }

    const avoidSet = parseCsvSet(flags.avoid);
    const excludeSet = parseCsvSet(flags.exclude);

    const res = await withHealth(async (health) => {
      const batchCounts = new Map();
      const envBatch = new Map(); // spread one wave across machines
      const picks = [];
      for (const spec of specs) {
        const parsed = parseSpec(spec, config.defaults?.workerDepth || "medium");
        if (parsed.error) return { save: false, payload: { ok: false, error: parsed.error } };
        const pick = await selectOneWorker(config, health, parsed.tier, parsed.depth, avoidSet, excludeSet, batchCounts, {
          place: typeof flags.place === "string" ? flags.place : null,
          envBatch,
        });
        if (!pick.ok) return { save: false, payload: pick };
        picks.push(pick);
      }
      return {
        save: true,
        payload: {
          ok: true,
          count: picks.length,
          configSource,
          picks,
          workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
          workerBrief: readWorkerBrief(),
        },
      };
    });
    out(res, res.ok ? 0 : 1);
    return;
  }
}

main().catch((err) => {
  out({ ok: false, error: err instanceof Error ? err.message : String(err) }, 1);
});
