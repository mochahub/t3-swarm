#!/usr/bin/env node
/**
 * t3-swarm router & state CLI (zero external dependencies, Node 18+).
 *
 * Manages:
 *   - Machine-local config (~/.t3/swarm/config.json) + opt-in safe project override (.t3-swarm.json)
 *   - Locked, atomic provider/bucket cooldowns & round-robin cursors (~/.t3/swarm/health.json)
 *   - Single-file run state ledgers (~/.t3/swarm/runs/<run-id>.md)
 *   - Lead failover selection & tier:depth worker routing with bucket-level anti-cannibalization
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
    return { ok: true, health: { cooldowns: {}, cursors: {} }, mutated: false };
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

  health.cooldowns = health.cooldowns && typeof health.cooldowns === "object" ? health.cooldowns : {};
  health.cursors = health.cursors && typeof health.cursors === "object" ? health.cursors : {};

  // Auto-prune expired cooldowns
  const now = Date.now();
  let mutated = false;
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

function isInCooldown(health, key) {
  const entry = health.cooldowns[key];
  if (!entry?.until) return false;
  return Date.parse(entry.until) > Date.now();
}

function isEntryInCooldown(config, health, entry) {
  const bucket = getBucket(config, entry);
  return isInCooldown(health, entry.provider) || isInCooldown(health, bucket);
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

  if (!Array.isArray(config.leads) || config.leads.length === 0) {
    warnings.push("No leads configured (Mode 2 requires at least one lead).");
  } else {
    config.leads.forEach((l, i) => checkEntry(l, `leads[${i}]`));
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

  return { errors, warnings };
}

function collectKnownTargets(config) {
  const known = new Set(Object.keys(config.providers || {}));
  for (const l of config.leads || []) {
    if (l?.provider) known.add(l.provider);
    if (l?.provider && l?.model) known.add(getBucket(config, l));
  }
  for (const tier of VALID_TIERS) {
    for (const w of config.workers?.[tier] || []) {
      if (w?.provider) known.add(w.provider);
      if (w?.provider && w?.model) known.add(getBucket(config, w));
    }
  }
  return known;
}

async function selectOneWorker(config, health, tier, depth, avoidSet, excludeSet, batchUsedBuckets) {
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
    if (isEntryInCooldown(config, health, entry)) {
      skipped.push({ model: entry.model, bucket, reason: "cooldown" });
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

  const antiCannibal = config.defaults?.antiCannibalization !== false;
  const preferred =
    antiCannibal && avoidSet.size > 0
      ? eligible.filter((c) => !avoidSet.has(c.bucket) && !avoidSet.has(c.entry.provider))
      : eligible;
  const bucketPool = preferred.length > 0 ? preferred : eligible;
  const fellBackToAvoided = preferred.length === 0 && avoidSet.size > 0;

  const freshInBatch =
    batchUsedBuckets && batchUsedBuckets.size > 0
      ? bucketPool.filter((c) => !batchUsedBuckets.has(c.bucket))
      : bucketPool;
  const finalCandidates = freshInBatch.length > 0 ? freshInBatch : bucketPool;

  const cursor = Number.isInteger(health.cursors[tier]) ? health.cursors[tier] : 0;
  const chosen = finalCandidates.find((c) => c.idx >= cursor) || finalCandidates[0];

  health.cursors[tier] = (chosen.idx + 1) % pool.length;
  if (batchUsedBuckets) {
    batchUsedBuckets.add(chosen.bucket);
  }

  const { target, depthDropped } = buildTarget(config, chosen.entry, depth);
  return {
    ok: true,
    tier,
    depth,
    bucket: chosen.bucket,
    target,
    depthDropped,
    fellBackToAvoided,
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
  finish <run-id>                          Archive a completed run file to ~/.t3/swarm/archive/
  pick-lead [--depth high] [--exclude b]   Pick highest-priority healthy Lead target
  pick-worker <tier[:depth]> [--avoid b]   Pick one load-balanced worker target
  pick-workers <spec>... [--avoid b]       Pick a batch of workers across buckets in one call
  cooldown <bucket> [minutes]              Mark quota bucket (or provider) in cooldown (1..10080m)
  clear-cooldown <bucket|all>              Clear cooldown(s)

Options:
  --config <path>    Override config path (default: ~/.t3/swarm/config.json)
  --avoid <b1,b2>    Deprioritize bucket(s)/provider(s) (anti-cannibalization)
  --exclude <b1,b2>  Hard-exclude bucket(s)/provider(s) for this pick
  --force-wave       Bypass maxParallelWorkers cap on pick-workers
  --reason "..."     Optional note when setting a cooldown
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
      out({ ok: false, error: "Usage: swarm.mjs cooldown <bucket> [minutes]" }, 1);
      return;
    }
    const loaded = loadConfig(flags.config);
    const defaultMins = loaded.ok ? loaded.config.defaults?.cooldownMinutes ?? 60 : 60;
    const minutes = positional[2] ? Number(positional[2]) : defaultMins;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_COOLDOWN_MINUTES) {
      out(
        {
          ok: false,
          error: `Invalid minutes "${positional[2]}". Must be between 1 and ${MAX_COOLDOWN_MINUTES}.`,
        },
        1
      );
      return;
    }
    let warning = null;
    if (loaded.ok) {
      const known = collectKnownTargets(loaded.config);
      if (!known.has(key)) {
        warning = `"${key}" is not a configured provider or bucket (${[...known].join(", ")}); cooldown saved anyway.`;
      }
    }
    const res = await withHealth((health) => {
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      health.cooldowns[key] = {
        until,
        minutes,
        reason: typeof flags.reason === "string" ? flags.reason : "quota_or_rate_limit",
        setAt: new Date().toISOString(),
      };
      return {
        save: true,
        payload: {
          ok: true,
          bucket: key,
          cooldown: health.cooldowns[key],
          ...(warning ? { warning } : {}),
        },
      };
    });
    out(res, res.ok ? 0 : 1);
    return;
  }

  if (cmd === "clear-cooldown") {
    const key = positional[1];
    if (!key) {
      out({ ok: false, error: "Usage: swarm.mjs clear-cooldown <bucket|all>" }, 1);
      return;
    }
    const res = await withHealth((health) => {
      if (key === "all") health.cooldowns = {};
      else delete health.cooldowns[key];
      return {
        save: true,
        payload: { ok: true, cleared: key, activeCooldowns: health.cooldowns },
      };
    });
    out(res, res.ok ? 0 : 1);
    return;
  }

  if (cmd === "finish") {
    const runId = positional[1];
    if (!runId) {
      out({ ok: false, error: "Usage: swarm.mjs finish <run-id>" }, 1);
      return;
    }
    const fileName = runId.endsWith(".md") ? runId : `${runId}.md`;
    const src = path.join(RUNS_DIR, path.basename(fileName));
    if (!fs.existsSync(src)) {
      out({ ok: false, error: `Run file not found: ${src}` }, 1);
      return;
    }
    ensureDir(ARCHIVE_DIR);
    const dest = path.join(ARCHIVE_DIR, path.basename(fileName));
    fs.renameSync(src, dest);
    out({ ok: true, archivedTo: dest });
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
    }));
    const resolvedWorkers = Object.fromEntries(
      VALID_TIERS.map((t) => [
        t,
        (config.workers?.[t] || []).map((w) => ({
          provider: w?.provider,
          model: w?.model,
          bucket: w?.provider && w?.model ? getBucket(config, w) : null,
        })),
      ])
    );

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
        cursors: health.cursors,
        leads: (config.leads || []).map((l, i) => ({
          priority: i + 1,
          provider: l.provider,
          bucket: getBucket(config, l),
          model: l.model,
          inCooldown: isEntryInCooldown(config, health, l),
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
      cursors: healthRes.cursors,
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

## Goal & Boundaries
- **Goal:** ${goal}
- **Done criteria:** (tests/checks required before completion)
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
    const res = await withHealth(async (health) => {
      const leads = config.leads || [];
      const healthy = [];
      const skipped = [];

      for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        if (!lead?.provider || !lead?.model) {
          skipped.push({ priority: i + 1, reason: "invalid_entry" });
          continue;
        }
        const bucket = getBucket(config, lead);
        if (excludeSet.has(lead.provider) || excludeSet.has(bucket)) {
          skipped.push({ priority: i + 1, model: lead.model, bucket, reason: "excluded" });
          continue;
        }
        if (isEntryInCooldown(config, health, lead)) {
          skipped.push({ priority: i + 1, model: lead.model, bucket, reason: "cooldown" });
          continue;
        }
        if (!supportsDepth(config, lead, depth)) {
          skipped.push({ priority: i + 1, model: lead.model, bucket, reason: `depth_cap(${depth})` });
          continue;
        }
        const quota = await checkQuota(lead.provider, lead.model, bucket);
        if (!quota.available) {
          skipped.push({ priority: i + 1, model: lead.model, bucket, reason: quota.reason || "quota_hook" });
          continue;
        }
        healthy.push({ lead, bucket, priority: i + 1 });
      }

      if (healthy.length === 0) {
        return {
          save: false,
          payload: {
            ok: false,
            status: "no_healthy_lead",
            error: `No eligible Lead available for depth "${depth}".`,
            skipped,
            activeCooldowns: health.cooldowns,
          },
        };
      }

      const chosen = healthy[0];
      const nextFallback = healthy[1]
        ? {
            provider: healthy[1].lead.provider,
            bucket: healthy[1].bucket,
            model: healthy[1].lead.model,
          }
        : null;
      const { target, depthDropped } = buildTarget(config, chosen.lead, depth);

      return {
        save: false,
        payload: {
          ok: true,
          priority: chosen.priority,
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
      const batchUsedBuckets = new Set();
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
          batchUsedBuckets
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
