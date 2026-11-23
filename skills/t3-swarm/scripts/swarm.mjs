#!/usr/bin/env node
/**
 * t3-swarm router & state CLI (zero external dependencies, Node 18+).
 *
 * Manages:
 *   - Machine-local config (~/.t3/swarm/config.json, optional .t3-swarm.json project override)
 *   - Provider cooldowns & round-robin cursors (~/.t3/swarm/health.json)
 *   - Single-file run state ledgers (~/.t3/swarm/runs/<run-id>.md)
 *   - Lead failover selection & tier:depth worker routing with anti-cannibalization
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REFERENCES_DIR = path.join(SKILL_DIR, "references");

const SWARM_HOME = process.env.T3_SWARM_HOME || path.join(os.homedir(), ".t3", "swarm");
const DEFAULT_CONFIG_PATH = path.join(SWARM_HOME, "config.json");
const HEALTH_PATH = path.join(SWARM_HOME, "health.json");
const RUNS_DIR = path.join(SWARM_HOME, "runs");

const DEPTH_ORDER = ["low", "medium", "high", "deep"];
const VALID_TIERS = ["heavy", "balanced", "fast"];

/**
 * Extension hook for proactive quota checks.
 * Returns { available: boolean, reason?: string }.
 * Replace or extend if your environment exposes a sanctioned quota check.
 */
async function checkQuota(_provider, _model) {
  return { available: true };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function resolveConfigPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const projectOverride = path.join(process.cwd(), ".t3-swarm.json");
  if (fs.existsSync(projectOverride)) return projectOverride;
  return DEFAULT_CONFIG_PATH;
}

function loadConfig(explicitPath) {
  const configPath = resolveConfigPath(explicitPath);
  if (!fs.existsSync(configPath)) {
    return { ok: false, status: "unconfigured", configPath };
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return { ok: true, configPath, config };
  } catch (err) {
    return {
      ok: false,
      status: "invalid_config",
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function loadHealth() {
  const health = readJson(HEALTH_PATH, { cooldowns: {}, cursors: {} }) || {
    cooldowns: {},
    cursors: {},
  };
  health.cooldowns = health.cooldowns || {};
  health.cursors = health.cursors || {};

  // Auto-prune expired cooldowns
  const now = Date.now();
  let changed = false;
  for (const [provider, entry] of Object.entries(health.cooldowns)) {
    if (!entry?.until || Date.parse(entry.until) <= now) {
      delete health.cooldowns[provider];
      changed = true;
    }
  }
  if (changed && fs.existsSync(HEALTH_PATH)) {
    writeJson(HEALTH_PATH, health);
  }
  return health;
}

function saveHealth(health) {
  writeJson(HEALTH_PATH, health);
}

function getBucket(entry) {
  if (entry.bucket) return entry.bucket;
  if (typeof entry.model === "string" && entry.model.includes("/")) {
    return entry.model.split("/")[0];
  }
  return entry.provider;
}

function isInCooldown(health, key) {
  const entry = health.cooldowns[key];
  if (!entry?.until) return false;
  return Date.parse(entry.until) > Date.now();
}

function isEntryInCooldown(health, entry) {
  return isInCooldown(health, entry.provider) || isInCooldown(health, getBucket(entry));
}

function depthRank(depth) {
  const idx = DEPTH_ORDER.indexOf(depth);
  return idx === -1 ? 1 : idx; // default medium
}

function supportsDepth(config, entry, depth) {
  const providerCfg = config.providers?.[entry.provider] || {};
  const maxDepth = entry.maxDepth ?? providerCfg.maxDepth ?? null;
  if (!maxDepth) return true;
  return depthRank(depth) <= depthRank(maxDepth);
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

  if (depthOption && mergedDepthMap[depth] !== undefined) {
    options[depthOption] = mergedDepthMap[depth];
  }

  const target = {
    providerInstanceId: entry.provider,
    model: entry.model,
  };
  if (Object.keys(options).length > 0) {
    target.options = options;
  }
  return target;
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

function out(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(exitCode);
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

function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== "object") {
    errors.push("Config must be a JSON object.");
    return { errors, warnings };
  }
  if (!Array.isArray(config.leads) || config.leads.length === 0) {
    warnings.push("No leads configured (Mode 2 requires at least one lead).");
  }
  if (!config.workers || typeof config.workers !== "object") {
    errors.push("Missing `workers` object.");
  } else {
    for (const tier of VALID_TIERS) {
      if (!Array.isArray(config.workers[tier]) || config.workers[tier].length === 0) {
        warnings.push(`Worker tier "${tier}" is empty.`);
      }
    }
  }
  return { errors, warnings };
}

async function selectOneWorker(config, health, tier, depth, avoidSet, excludeSet, batchUsedProviders) {
  const pool = config.workers?.[tier] || [];
  if (pool.length === 0) {
    return { ok: false, error: `No workers configured for tier "${tier}".` };
  }

  // Filter to healthy, non-excluded, depth-compatible candidates
  const eligible = [];
  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    const bucket = getBucket(entry);
    if (excludeSet.has(entry.provider) || excludeSet.has(bucket)) continue;
    if (isEntryInCooldown(health, entry)) continue;
    if (!supportsDepth(config, entry, depth)) continue;
    const quota = await checkQuota(entry.provider, entry.model);
    if (!quota.available) continue;
    eligible.push({ entry, bucket, idx: i });
  }

  if (eligible.length === 0) {
    return {
      ok: false,
      error: `No healthy worker available for ${tier}:${depth}. Check cooldowns or config.`,
    };
  }

  // Anti-cannibalization: prefer buckets/providers NOT in avoidSet; fallback smoothly if none left
  const antiCannibal = config.defaults?.antiCannibalization !== false;
  const preferred =
    antiCannibal && avoidSet.size > 0
      ? eligible.filter((c) => !avoidSet.has(c.bucket) && !avoidSet.has(c.entry.provider))
      : eligible;
  const bucket = preferred.length > 0 ? preferred : eligible;
  const fellBackToAvoided = preferred.length === 0 && avoidSet.size > 0;

  // Within a batched pick-workers call, prefer quota buckets not yet used in this batch
  const freshInBatch =
    batchUsedProviders && batchUsedProviders.size > 0
      ? bucket.filter((c) => !batchUsedProviders.has(c.bucket))
      : bucket;
  const finalCandidates = freshInBatch.length > 0 ? freshInBatch : bucket;

  // Persistent round-robin cursor per tier
  const cursor = Number.isInteger(health.cursors[tier]) ? health.cursors[tier] : 0;
  // Find first candidate at or after cursor in pool order
  let chosen =
    finalCandidates.find((c) => c.idx >= cursor) || finalCandidates[0];

  health.cursors[tier] = (chosen.idx + 1) % pool.length;
  if (batchUsedProviders) {
    batchUsedProviders.add(chosen.bucket);
  }

  return {
    ok: true,
    tier,
    depth,
    bucket: chosen.bucket,
    target: buildTarget(config, chosen.entry, depth),
    fellBackToAvoided,
  };
}

function parseSpec(spec, defaultDepth) {
  const [rawTier, rawDepth] = String(spec || "").split(":");
  const tier = rawTier?.trim().toLowerCase();
  const depth = (rawDepth?.trim().toLowerCase() || defaultDepth || "medium");
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
  doctor                                   Validate config, cooldowns, and paths
  status                                   Show active cooldowns, config summary, recent runs
  init <slug> [--goal "..."]               Create a single-file STATE.md ledger for Mode 2
  pick-lead [--depth high] [--exclude p]   Pick highest-priority healthy Lead target
  pick-worker <tier[:depth]> [--avoid p]   Pick one load-balanced worker target
  pick-workers <spec>... [--avoid p]       Pick a batch of workers across providers in one call
  cooldown <provider> [minutes]            Mark provider in cooldown (default from config)
  clear-cooldown <provider|all>            Clear provider cooldown(s)

Options:
  --config <path>    Override config path (default: .t3-swarm.json or ~/.t3/swarm/config.json)
  --avoid <p1,p2>    Deprioritize provider(s) (anti-cannibalization with active Lead)
  --exclude <p1,p2>  Hard-exclude provider(s) for this pick
  --reason "..."     Optional note when setting a cooldown
`);
    process.exit(0);
  }

  // Commands that don't require a config to exist
  if (cmd === "cooldown") {
    const provider = positional[1];
    if (!provider) out({ ok: false, error: "Usage: swarm.mjs cooldown <provider> [minutes]" }, 1);
    const loaded = loadConfig(flags.config);
    const defaultMins = loaded.ok ? loaded.config.defaults?.cooldownMinutes ?? 60 : 60;
    const minutes = positional[2] ? Number(positional[2]) : defaultMins;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      out({ ok: false, error: `Invalid minutes: ${positional[2]}` }, 1);
    }
    const health = loadHealth();
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    health.cooldowns[provider] = {
      until,
      minutes,
      reason: typeof flags.reason === "string" ? flags.reason : "quota_or_rate_limit",
      setAt: new Date().toISOString(),
    };
    saveHealth(health);
    out({ ok: true, provider, cooldown: health.cooldowns[provider] });
  }

  if (cmd === "clear-cooldown") {
    const provider = positional[1];
    if (!provider) out({ ok: false, error: "Usage: swarm.mjs clear-cooldown <provider|all>" }, 1);
    const health = loadHealth();
    if (provider === "all") {
      health.cooldowns = {};
    } else {
      delete health.cooldowns[provider];
    }
    saveHealth(health);
    out({ ok: true, cleared: provider, activeCooldowns: health.cooldowns });
  }

  // Config-backed commands
  const loaded = loadConfig(flags.config);
  if (!loaded.ok) {
    out(
      {
        ok: false,
        status: loaded.status,
        configPath: loaded.configPath,
        scriptPath: SCRIPT_PATH,
        referencesDir: REFERENCES_DIR,
        hint: "Run the t3-swarm-setup skill to generate ~/.t3/swarm/config.json from your enabled T3 providers.",
        ...(loaded.error ? { error: loaded.error } : {}),
      },
      cmd === "doctor" ? 0 : 2
    );
  }

  const { config, configPath } = loaded;
  const health = loadHealth();

  if (cmd === "doctor") {
    const { errors, warnings } = validateConfig(config);
    out({
      ok: errors.length === 0,
      status: errors.length === 0 ? "ready" : "invalid",
      configPath,
      scriptPath: SCRIPT_PATH,
      referencesDir: REFERENCES_DIR,
      swarmHome: SWARM_HOME,
      leadsCount: config.leads?.length || 0,
      workerCounts: Object.fromEntries(
        VALID_TIERS.map((t) => [t, config.workers?.[t]?.length || 0])
      ),
      activeCooldowns: health.cooldowns,
      errors,
      warnings,
    });
  }

  if (cmd === "status") {
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
      scriptPath: SCRIPT_PATH,
      referencesDir: REFERENCES_DIR,
      leads: (config.leads || []).map((l, i) => ({
        priority: i + 1,
        provider: l.provider,
        bucket: getBucket(l),
        model: l.model,
        inCooldown: isEntryInCooldown(health, l),
      })),
      activeCooldowns: health.cooldowns,
      cursors: health.cursors,
      recentRuns,
    });
  }

  if (cmd === "init") {
    const slug = slugify(positional[1] || "task");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runId = `${stamp}-${slug}`;
    ensureDir(RUNS_DIR);
    const statePath = path.join(RUNS_DIR, `${runId}.md`);
    const goal =
      typeof flags.goal === "string" ? flags.goal : "(Coordinator: fill in 1–3 sentence goal)";
    const content = `# Swarm Run: ${runId}

## Goal & Boundaries
- **Goal:** ${goal}
- **Done criteria:** (tests/checks required before completion)
- **Boundaries:** (out-of-scope or constraints)

## Tasks
- [ ] (Lead fills concise checklist: task | tier:depth | branch/files | outcome)

## Decisions
- (Append 1-line engineering decisions or resolved blockers here)
`;
    fs.writeFileSync(statePath, content, "utf8");
    out({
      ok: true,
      runId,
      statePath,
      scriptPath: SCRIPT_PATH,
      referencesDir: REFERENCES_DIR,
      leadBriefPath: path.join(REFERENCES_DIR, "lead-brief.md"),
      workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
      maxWorkerLoops: config.defaults?.maxWorkerLoops ?? 2,
    });
  }

  if (cmd === "pick-lead") {
    const depth =
      (typeof flags.depth === "string" ? flags.depth : config.defaults?.leadDepth) || "high";
    if (!DEPTH_ORDER.includes(depth)) {
      out({ ok: false, error: `Invalid depth "${depth}".` }, 1);
    }
    const excludeSet = parseCsvSet(flags.exclude);
    const leads = config.leads || [];
    const healthy = [];
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const bucket = getBucket(lead);
      if (excludeSet.has(lead.provider) || excludeSet.has(bucket)) continue;
      if (isEntryInCooldown(health, lead)) continue;
      if (!supportsDepth(config, lead, depth)) continue;
      const quota = await checkQuota(lead.provider, lead.model);
      if (!quota.available) continue;
      healthy.push({ lead, bucket, priority: i + 1 });
    }

    if (healthy.length === 0) {
      out(
        {
          ok: false,
          status: "no_healthy_lead",
          error: "All configured Leads are in cooldown or excluded.",
          activeCooldowns: health.cooldowns,
        },
        1
      );
    }

    const chosen = healthy[0];
    const nextFallback = healthy[1]
      ? {
          provider: healthy[1].lead.provider,
          bucket: healthy[1].bucket,
          model: healthy[1].lead.model,
        }
      : null;

    out({
      ok: true,
      priority: chosen.priority,
      depth,
      bucket: chosen.bucket,
      target: buildTarget(config, chosen.lead, depth),
      fallbackAvailable: Boolean(nextFallback),
      nextFallback,
      scriptPath: SCRIPT_PATH,
      leadBriefPath: path.join(REFERENCES_DIR, "lead-brief.md"),
      workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
    });
  }

  if (cmd === "pick-worker") {
    const specArg = positional[1] || "balanced";
    const parsed = parseSpec(specArg, config.defaults?.workerDepth || "medium");
    if (parsed.error) out({ ok: false, error: parsed.error }, 1);

    const avoidSet = parseCsvSet(flags.avoid);
    const excludeSet = parseCsvSet(flags.exclude);
    const res = await selectOneWorker(
      config,
      health,
      parsed.tier,
      parsed.depth,
      avoidSet,
      excludeSet,
      null
    );
    if (!res.ok) out(res, 1);
    saveHealth(health);
    out({
      ...res,
      workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
    });
  }

  if (cmd === "pick-workers") {
    const specs = positional.slice(1);
    if (specs.length === 0) {
      out(
        {
          ok: false,
          error: "Usage: swarm.mjs pick-workers <tier[:depth]> [tier[:depth]...] [--avoid provider]",
        },
        1
      );
    }
    const avoidSet = parseCsvSet(flags.avoid);
    const excludeSet = parseCsvSet(flags.exclude);
    const batchUsedProviders = new Set();
    const picks = [];

    for (const spec of specs) {
      const parsed = parseSpec(spec, config.defaults?.workerDepth || "medium");
      if (parsed.error) out({ ok: false, error: parsed.error }, 1);
      const res = await selectOneWorker(
        config,
        health,
        parsed.tier,
        parsed.depth,
        avoidSet,
        excludeSet,
        batchUsedProviders
      );
      if (!res.ok) out(res, 1);
      picks.push(res);
    }

    saveHealth(health);
    out({
      ok: true,
      count: picks.length,
      picks,
      workerBriefPath: path.join(REFERENCES_DIR, "worker-brief.md"),
    });
  }

  out({ ok: false, error: `Unknown command "${cmd}". Run with --help.` }, 1);
}

main().catch((err) => {
  out({ ok: false, error: err instanceof Error ? err.message : String(err) }, 1);
});
