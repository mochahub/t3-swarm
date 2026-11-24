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
  "cooldown",
  "clear-cooldown",
]);
const DEFAULT_BUCKET_ALIASES = {
  "openai-codex": "codex",
};
const MAX_COOLDOWN_MINUTES = 10080; // 7 days

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

function acquireLock(timeoutMs = 3000) {
  ensureDir(SWARM_HOME);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Recover stale lock older than 10 seconds
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 10_000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock ${LOCK_PATH}`);
      }
      sleepSync(25);
    }
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // ignore
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
    return { ok: true, health: { cooldowns: {}, credits: { workers: {}, leads: {} }, leadPicks: {} }, mutated: false };
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
    if (excludeSet.has(lead.provider) || excludeSet.has(bucket)) {
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
function chooseLead(config, health, healthy, runId) {
  const weighted = weightsCfg(config).leadSelection === "weighted";
  const prior = runId ? health.leadPicks[runId] : null;
  let refunded = false;
  if (prior) {
    const same = healthy.find((h) => entryId(h.lead) === prior.id);
    if (same) return { chosen: same, sticky: true, changed: false };
    if (prior.charge > 0 && Date.now() - Date.parse(prior.at) < LEAD_REFUND_WINDOW_MS) {
      health.credits.leads[prior.id] = (Number(health.credits.leads[prior.id]) || 0) + prior.charge;
      refunded = true;
    }
  }

  let chosen = healthy[0];
  let charge = 0;
  const fromLeads = healthy.filter((h) => h.source === "leads");
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
  if (runId) {
    health.leadPicks[runId] = {
      id: entryId(chosen.lead),
      at: new Date().toISOString(),
      charge,
      ...(prior ? { failoverFrom: prior.id } : {}),
    };
  }
  return {
    chosen,
    sticky: false,
    changed: Boolean(runId) || charge > 0 || refunded,
    ...(prior ? { failoverFrom: prior.id, refunded } : {}),
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
  return { errors, warnings };
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

async function selectOneWorker(config, health, tier, depth, avoidSet, excludeSet, batchCounts) {
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
    if (excludeSet.has(entry.provider) || excludeSet.has(bucket)) {
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
  return {
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
}

function parseSpec(spec, defaultDepth) {
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

  if (!cmd || cmd === "help" || flags.help) {
    console.log(`t3-swarm router CLI

Commands:
  doctor                                   Validate config, buckets, write access & paths
  status                                   Show leads, resolved buckets, cooldowns & recent runs
  init <slug> [--goal "..."]               Create a single-file STATE.md ledger for Mode 2
  finish <run-id> [--force]                Archive a run whose ledger says Status: COMPLETE
  pick-lead [--run id] [--depth high]      Pick the Lead (heavy pool as fallback); --run makes it stick to a run
  pick-worker <tier[:depth]> [--avoid b]   Pick one worker by quota weight
  pick-workers <spec>... [--avoid b]       Pick a wave of workers in one call
  cooldown <key> [duration] [--until t]    Put a key in cooldown (default: defaults.cooldownMinutes)
  clear-cooldown <key|all>                 Clear cooldown(s)

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
  --exclude <b1,b2>  Hard-exclude bucket(s)/provider(s) for this pick
  --force-wave       Bypass maxParallelWorkers cap on pick-workers
  --reason "..."     Optional note when setting a cooldown
  --force            finish: archive even if the ledger Status is not COMPLETE
  --run <run-id>     pick-lead: reuse this run's Lead while healthy; otherwise fail over and record it

Weights (config "weights"): buckets {bucket: n} sets each quota bucket's share of work (default 1; 0 =
only when nothing else is available); a per-entry "weight" overrides one model in one tier.
leadSelection "priority" (default) | "weighted"; leadBucketMultiplier (default 0.5); maxSessionsPerBucket.
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

    const affects = loaded.ok ? entriesMatchingKey(loaded.config, key) : [];
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
    const statusMatch = fs.readFileSync(src, "utf8").match(/^\s*-\s*\*\*Status:\*\*\s*`?([A-Za-z_]+)/m);
    const runStatus = statusMatch ? statusMatch[1].toUpperCase() : null;
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
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 5)
        .map((f) => path.join(RUNS_DIR, f));
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
    const content = `# Swarm Run: ${runId}
- **Status:** RUNNING

## Goal & Boundaries
- **Goal:** ${goal}
- **Done criteria:** (tests/checks required before completion)
- **Verify:** targeted (workers): (narrowest test/lint command per area) | full gate (Lead only, once, on the integration branch): (command)
- **Boundaries:** (out-of-scope or constraints)
- **Config:** \`${configPath}\` (${configSource})${
      git.isGitRepo
        ? `\n- **Git Base:** \`${git.branch}@${git.commit}\` (dirty: ${git.dirty}) | **Integration Branch:** \`${integrationBranch}\``
        : ""
    }

## Tasks
- [ ] (Lead fills concise rows: task | tier:depth | taskId:<id> | branch@sha | loops:0 | pending)

## Decisions
- (Append 1-line engineering decisions or resolved blockers here)
`;
    fs.writeFileSync(statePath, content, { encoding: "utf8", flag: "wx" });
    out({
      ok: true,
      runId,
      statePath,
      configPath,
      configSource,
      scriptPath: SCRIPT_PATH,
      referencesDir: REFERENCES_DIR,
      leadBriefPath: path.join(REFERENCES_DIR, "lead-brief.md"),
      workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
      maxWorkerLoops: config.defaults?.maxWorkerLoops ?? 2,
      maxParallelWorkers: config.defaults?.maxParallelWorkers ?? 4,
      worktreeForParallelEdits: config.defaults?.worktreeForParallelEdits !== false,
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
    const res = await withHealth(async (health) => {
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

      const choice = chooseLead(config, health, healthy, runId);
      const chosen = choice.chosen;
      const next = healthy.find((h) => h !== chosen);
      const nextFallback = next
        ? { provider: next.lead.provider, bucket: next.bucket, model: next.lead.model, source: next.source }
        : null;
      const { target, depthDropped } = buildTarget(config, chosen.lead, depth);

      return {
        save: choice.changed,
        payload: {
          ok: true,
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
      const pick = await selectOneWorker(
        config,
        health,
        parsed.tier,
        parsed.depth,
        avoidSet,
        excludeSet,
        null
      );
      return {
        save: pick.ok,
        payload: {
          ...pick,
          configSource,
          workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
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
      const picks = [];
      for (const spec of specs) {
        const parsed = parseSpec(spec, config.defaults?.workerDepth || "medium");
        if (parsed.error) return { save: false, payload: { ok: false, error: parsed.error } };
        const pick = await selectOneWorker(
          config,
          health,
          parsed.tier,
          parsed.depth,
          avoidSet,
          excludeSet,
          batchCounts
        );
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
