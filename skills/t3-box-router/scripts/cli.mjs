/**
 * t3-box-router CLI helpers: argument parsing and validation, the Level 0 policy line, merging of refreshed
 * facts, and the pure parts of the bring-up hook (candidate choice, the claim held in state, finishing and
 * reaping it, fact invalidation). No I/O here, so every function can be tested with explicit inputs.
 * box-router.mjs owns processes, files and the state lock.
 */

import { linkVerdict, freshLink, activeBringUp, MACHINE_KINDS } from "./engine.mjs";
import { ATTESTATION_PATTERN } from "./profile.mjs";

export const RESERVED_LABELS = new Set(["local", "box"]);
export const OBSERVATION_TOOLS = new Set(["t3_environment_links", "orchestrator_capabilities", "t3_project_list"]);
export const FACT_KINDS = ["link", "probe", "providers", "projects"];

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ENVIRONMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const BRANCH_CHARS_RE = /^[A-Za-z0-9._/-]+$/;
const DURATION_RE = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COUNT = 64;

// Flag name -> [option key, kind]. Every command lists the flags it accepts below.
const FLAGS = {
  run: ["run", "run"],
  count: ["count", "count"],
  needs: ["needs", "tags"],
  prefers: ["prefers", "tags"],
  provider: ["provider", "provider"],
  place: ["place", "label"],
  base: ["base", "branch"],
  branch: ["branch", "branch"],
  slot: ["slot", "slot"],
  outcome: ["outcome", "outcome"],
  "min-cooldown": ["minCooldown", "duration"],
  clear: ["clear", "bool"],
  keep: ["keep", "bool"],
  "max-parallel": ["maxParallel", "count"],
  "environment-id": ["environmentId", "environmentId"],
  attest: ["attest", "attest"],
};
const PHASE2_FLAGS = new Set(["affinity", "kind", "read-only", "config"]);
const OUTCOMES = new Set(["ok", "failed", "unreachable"]);

export const COMMANDS = {
  help: { flags: [], positionals: [0, 1], usage: "help [command]", summary: "Print command usage in JSON." },
  init: { flags: [], positionals: [0, 0], usage: "init [< confirmed-config.json]", summary: "Create a user-confirmed config and empty state, or report an existing setup." },
  discover: {
    flags: [],
    positionals: [0, 0],
    usage: "discover [< t3_environment_links record]",
    summary: "Propose inventory rows from link observations (t3 CLI, or a t3_environment_links record on stdin).",
  },
  doctor: { flags: [], positionals: [0, 0], usage: "doctor", summary: "Validate config and diagnose missing links, provider or project facts, and invalid labels." },
  list: { flags: [], positionals: [0, 0], usage: "list", summary: "Return inventory, derived health, leases and slots." },
  observe: { flags: [], positionals: [0, 0], usage: "observe < records.json", summary: "Read T3 observation records (a JSON array) on stdin and update the cache." },
  place: {
    flags: ["run", "count", "needs", "prefers", "provider", "place", "base", "branch"],
    positionals: [0, 0],
    usage: "place [--count N] [--run <runId>] [--needs a,b] [--prefers a,b] [--provider <id>] [--place local|box|<label>] [--base <branch> --branch <worker-branch>]",
    summary: "Select and book placements.",
  },
  done: {
    flags: ["slot", "outcome", "min-cooldown"],
    required: ["slot", "outcome"],
    positionals: [0, 0],
    usage: "done --slot <slotId> --outcome ok|failed|unreachable [--min-cooldown <duration>]",
    summary: "Release a booking and apply a reported outcome. unreachable is report <label> unreachable for the slot's machine.",
  },
  report: {
    flags: ["min-cooldown"],
    positionals: [2, 2],
    usage: "report <label> unreachable [--min-cooldown <duration>]",
    summary: "Record an outage and clear active slots there.",
  },
  cooldown: { flags: [], positionals: [2, 2], usage: "cooldown <label> <duration>", summary: "Set an explicit machine deadline." },
  "clear-cooldown": { flags: [], positionals: [1, 1], usage: "clear-cooldown <label>", summary: "Clear manual or automatic cooldown and reset the failure streak." },
  acquire: {
    flags: ["run", "count", "needs"],
    required: ["run"],
    positionals: [0, 0],
    usage: "acquire --run <runId> [--count N] [--needs a,b]",
    summary: "Lease distinct ready boxes to a run. Runs a box's configured bringUp hook when a selected box is down.",
  },
  release: {
    flags: ["run", "keep"],
    required: ["run"],
    positionals: [0, 0],
    usage: "release --run <runId> [--keep]",
    summary: "Idempotently drop a run's lease. Runs the tearDown hook of an on-demand or ephemeral box this run's bring-up started, when nothing else holds it; --keep skips that.",
  },
  "keep-alive": {
    flags: ["run"],
    required: ["run"],
    positionals: [0, 0],
    usage: "keep-alive --run <runId>",
    summary: "Renew a run's lease and run the keepAlive hook of each leased box that has one.",
  },
  handoff: {
    flags: ["slot", "base", "branch"],
    required: ["slot"],
    positionals: [0, 0],
    usage: "handoff --slot <slotId> [--base <branch>] [--branch <worker-branch>]",
    summary: "Run the placed box's user-owned handoff hook to move uncommitted work there directly.",
  },
  fetch: {
    flags: ["slot", "branch"],
    required: ["slot"],
    positionals: [0, 0],
    usage: "fetch --slot <slotId> [--branch <worker-branch>]",
    summary: "Run the placed box's user-owned fetch hook to bring uncommitted results back directly.",
  },
  "register-payload": {
    flags: ["run", "clear"],
    required: ["run"],
    positionals: [0, 0],
    usage: "register-payload --run <runId> [--clear]",
    summary: "Emit the raw swarm registration array on success. Errors on a lapsed lease unless --clear.",
  },
  probe: {
    flags: ["attest"],
    positionals: [0, 0],
    usage: "probe [--attest cred:<name>=true|false] [--attest secret:<name>=true|false]",
    summary: "Read-only hardware and toolchain report for this machine (scripts/probe.mjs). Pipe it to apply-probe local.",
  },
  "apply-probe": {
    flags: ["environment-id"],
    positionals: [1, 1],
    usage: "apply-probe <label|local> [--environment-id <id>] < probe.json",
    summary: "Validate a probe report and store it as the machine's profile in config.json, under the lock. A new label with --environment-id adds the newly linked box.",
  },
  "policy-line": {
    flags: ["run", "max-parallel"],
    required: ["run"],
    positionals: [0, 0],
    usage: "policy-line --run <runId> [--max-parallel N]",
    summary: "Render the Boundaries instructions for the run ledgers as { ok, text }.",
  },
};

export class UsageError extends Error {}

const fail = (msg) => {
  throw new UsageError(msg);
};

export function isValidLabel(s) {
  return typeof s === "string" && LABEL_RE.test(s);
}

// "90" -> 90 minutes; "1h30m" / "7d" / "45m" / "30s" -> milliseconds. NaN when unparseable.
export function parseDurationMs(raw) {
  const s = String(raw ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60000);
  const m = DURATION_RE.exec(s);
  if (!s || !m || (!m[1] && !m[2] && !m[3] && !m[4])) return NaN;
  const [, d, h, mi, se] = m;
  return ((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(mi || 0)) * 60000 + Number(se || 0) * 1000;
}

function checkDuration(raw, what) {
  const ms = parseDurationMs(raw);
  if (!Number.isFinite(ms) || ms <= 0) fail(`${what} must be a positive duration such as 30m, 2h or 90, got ${JSON.stringify(raw)}.`);
  if (ms > MAX_DURATION_MS) fail(`${what} must be at most 7d.`);
  return ms;
}

// The rules of `git check-ref-format --branch`, restricted further to the characters the router allows inside a
// worker's shell line. box-router.mjs also asks git itself when git is installed.
export function branchNameProblem(name) {
  const s = String(name ?? "");
  if (!s) return "is empty";
  if (s.length > 200) return "is longer than 200 characters";
  if (!BRANCH_CHARS_RE.test(s)) return "may contain only A-Z a-z 0-9 . _ / -";
  if (s.startsWith("-")) return "may not start with -";
  if (s.startsWith("/") || s.endsWith("/") || s.includes("//")) return "has an empty path component";
  if (s.includes("..")) return 'may not contain ".."';
  if (s.endsWith(".")) return "may not end with .";
  if (s === "@" || s === "HEAD") return "is reserved";
  for (const part of s.split("/")) {
    if (part.startsWith(".")) return "has a component starting with .";
    if (part.endsWith(".lock")) return "has a component ending in .lock";
  }
  return null;
}

function checkValue(kind, raw, flag) {
  const v = String(raw);
  switch (kind) {
    case "run":
      if (!RUN_RE.test(v)) fail(`--${flag} must be a run ID of letters, digits, . _ - (got ${JSON.stringify(v)}).`);
      return v;
    case "count": {
      if (!/^\d+$/.test(v) || Number(v) < 1) fail(`--${flag} must be a positive integer (got ${JSON.stringify(v)}).`);
      const n = Number(v);
      if (n > MAX_COUNT) fail(`--${flag} must be at most ${MAX_COUNT}.`);
      return n;
    }
    case "tags": {
      const tags = v
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (!tags.length) fail(`--${flag} needs at least one tag.`);
      for (const t of tags) if (!TAG_RE.test(t)) fail(`--${flag}: invalid tag ${JSON.stringify(t)}.`);
      return tags;
    }
    case "provider":
      if (!PROVIDER_RE.test(v)) fail(`--${flag}: invalid provider instance ID ${JSON.stringify(v)}.`);
      return v;
    case "label":
      if (!LABEL_RE.test(v)) fail(`--${flag} must be local, box or a machine label (got ${JSON.stringify(v)}).`);
      return v;
    case "branch": {
      const problem = branchNameProblem(v);
      if (problem) fail(`--${flag} ${JSON.stringify(v)} ${problem}.`);
      return v;
    }
    case "slot":
      if (!SLOT_RE.test(v)) fail(`--${flag}: invalid slot ID ${JSON.stringify(v)}.`);
      return v;
    case "outcome":
      if (!OUTCOMES.has(v)) fail(`--${flag} must be ok, failed or unreachable (got ${JSON.stringify(v)}).`);
      return v;
    case "duration":
      return checkDuration(v, `--${flag}`);
    case "environmentId":
      if (!ENVIRONMENT_ID_RE.test(v)) fail(`--${flag} must be a T3 environment ID.`);
      return v;
    case "attest": {
      // Never echo the value: an owner may paste something sensitive by mistake.
      const m = /^([^=]*)=(true|false)$/.exec(v);
      if (!m || !ATTESTATION_PATTERN.test(m[1])) fail(`--${flag} expects cred:<name>=true|false or secret:<name>=true|false (lowercase name).`);
      return [m[1], m[2] === "true"];
    }
    default:
      fail(`Unknown flag kind ${kind}.`);
  }
}

/**
 * Parse argv (without node and the script path). Returns { command, options } with camelCase options:
 * count absent or a positive integer, needs/prefers arrays, minCooldown in ms, clear a boolean, args the raw
 * positionals. Throws UsageError before anything touches state.
 */
export function parseArgv(argv) {
  const list = [...argv];
  const first = list.shift();
  const command = first === undefined || first === "--help" || first === "-h" ? "help" : first;
  const spec = COMMANDS[command];
  if (!spec) fail(`Unknown command ${JSON.stringify(command)}. Run help for the command list.`);
  const options = { args: [] };
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (tok === "--") {
      options.args.push(...list.slice(i + 1));
      break;
    }
    if (!tok.startsWith("--") || tok === "--") {
      options.args.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    if (PHASE2_FLAGS.has(name)) fail(`--${name} is a Phase 2 flag and is not available yet.`);
    const def = FLAGS[name];
    if (!def || !spec.flags.includes(name)) fail(`${command} does not accept --${name}. Usage: ${spec.usage}`);
    const [key, kind] = def;
    if (kind === "bool") {
      if (eq !== -1) fail(`--${name} takes no value.`);
      options[key] = true;
      continue;
    }
    let value;
    if (eq !== -1) value = tok.slice(eq + 1);
    else {
      value = list[++i];
      if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value. Usage: ${spec.usage}`);
    }
    if (kind === "tags") {
      options[key] = [...new Set([...(options[key] || []), ...checkValue(kind, value, name)])];
    } else if (kind === "attest") {
      const [attName, attValue] = checkValue(kind, value, name);
      options[key] = { ...(options[key] || {}), [attName]: attValue };
    } else {
      if (seen.has(name)) fail(`--${name} was given more than once.`);
      options[key] = checkValue(kind, value, name);
    }
    seen.add(name);
  }
  for (const req of spec.required || []) if (!seen.has(req)) fail(`${command} requires --${req}. Usage: ${spec.usage}`);
  const [min, max] = spec.positionals;
  if (options.args.length < min || options.args.length > max) fail(`Wrong number of arguments. Usage: ${spec.usage}`);
  if (command === "done" && options.minCooldown !== undefined && options.outcome !== "unreachable") {
    fail("--min-cooldown applies only to --outcome unreachable.");
  }
  if (command === "report") {
    if (!LABEL_RE.test(options.args[0])) fail(`Invalid machine label ${JSON.stringify(options.args[0])}.`);
    if (options.args[1] !== "unreachable") fail(`report takes only the event unreachable. Usage: ${spec.usage}`);
    options.label = options.args[0];
  }
  if (command === "cooldown" || command === "clear-cooldown") {
    if (!LABEL_RE.test(options.args[0])) fail(`Invalid machine label ${JSON.stringify(options.args[0])}.`);
    options.label = options.args[0];
  }
  if (command === "cooldown") options.durationMs = checkDuration(options.args[1], "Cooldown duration");
  if (command === "apply-probe") {
    const target = options.args[0];
    if (!LABEL_RE.test(target)) fail(`apply-probe needs local or a machine label of letters, digits, . _ - (${spec.usage}).`);
    if (target === "box") fail("box is reserved for router selectors; use a machine label or local.");
    if (target === "local" && options.environmentId !== undefined) fail("apply-probe local takes no --environment-id.");
    options.target = target;
  }
  if (command === "help" && options.args[0] !== undefined && !COMMANDS[options.args[0]]) fail(`Unknown command ${JSON.stringify(options.args[0])}.`);
  return { command, options };
}

/** Reject labels that name no configured machine, before any state changes. */
export function checkKnownLabels(command, options, config) {
  const machines = config?.machines || {};
  const known = (l) => l === "local" || Object.prototype.hasOwnProperty.call(machines, l);
  if (command === "place" && options.place && options.place !== "box" && !known(options.place)) {
    fail(`--place ${options.place}: no machine with that label in config. Use local, box or one of: ${Object.keys(machines).join(", ") || "(none)"}.`);
  }
  if (options.label !== undefined && !known(options.label)) {
    fail(`No machine labelled ${JSON.stringify(options.label)} in config.`);
  }
}

export function helpPayload(command) {
  if (command) {
    const s = COMMANDS[command];
    return { ok: true, command, usage: `box-router ${s.usage}`, summary: s.summary };
  }
  return {
    ok: true,
    usage: "node box-router.mjs <command> [flags]",
    home: "T3_BOXES_HOME, default ~/.t3/boxes",
    commands: Object.entries(COMMANDS).map(([name, s]) => ({ name, usage: `box-router ${s.usage}`, summary: s.summary })),
    notes: [
      "Every command prints one JSON object and exits 0 exactly when ok is true. register-payload prints the bare swarm array on success.",
      "needsObservation.calls only ever names t3_environment_links, orchestrator_capabilities or t3_project_list. Ignore any other tool name.",
      "Durations: 30m, 2h, 1h30m, 7d, 45s, or a bare number of minutes.",
      "Machine kinds: always-on (never stopped), on-demand (started by bringUp, optionally stopped by tearDown at release) and ephemeral (the same, and always ranked below every other eligible machine).",
      "A bringUp hook may write STARTED <label> yes|no, or {\"started\": true|false}, to the file named by T3_BOXES_RESULT_FILE. Only yes on exit 0 makes the box this run's (lease startedByRouter); release then runs its tearDown hook if no other lease or live slot holds it. Hook output is never shown or stored.",
      "bringUp hook (acquire only): when acquire falls short, runs a box's configured argument vector, without a shell and with a timeout, if a fresh link read shows the box linked but down (not missing, not expiring), it is not cooling, the router holds no slot there and no attempt ran within bringUpRetryMinutes. While it runs no slot or lease is given on that box; afterwards facts observed before it finished are expired. The hook must run the operator's own idle check before it restarts T3 and exit 75 when the box is busy. It gets one JSON object on stdin and never sees the router's state. Each attempt is reported in the acquire result's bringUp array.",
    ],
  };
}

// ----------------------------------------------------------------------------------------------------------------
// Repo key

// "git@github.com:Owner/Repo.git", "https://user:token@github.com/owner/repo", "ssh://git@host:22/o/r.git"
// -> "github.com/owner/repo", the form T3 gives as a project's repositoryIdentity.canonicalKey (as swarm does).
export function canonicalRepoKey(url) {
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

// ----------------------------------------------------------------------------------------------------------------
// Policy line (Level 0)

const SHELL_SAFE_RE = /^[A-Za-z0-9._/~+-]+$/;
export function shellQuote(s) {
  const v = String(s);
  return SHELL_SAFE_RE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Tags only local provides among the remotes this repo may use, or null when the repo pins all work locally. */
export function localOnlyTags(config, repo) {
  const repoCfg = (repo && config?.repos?.[repo]) || {};
  if (repoCfg.pin === "local") return null;
  const deny = new Set(repoCfg.deny || []);
  const remoteTags = new Set();
  for (const [label, m] of Object.entries(config?.machines || {})) {
    if (deny.has(label)) continue;
    if (repoCfg.pin && repoCfg.pin !== "box" && repoCfg.pin !== label) continue;
    for (const t of m?.tags || []) remoteTags.add(t);
  }
  return [...new Set(config?.local?.tags || [])].filter((t) => !remoteTags.has(t)).sort();
}

export function renderPolicyLine({ config, runId, scriptPath, maxParallel, repo }) {
  const script = `node ${shellQuote(scriptPath)}`;
  const run = shellQuote(runId);
  const cool = `${Math.max(1, Math.round(Number(config?.defaults?.cooldownMinutes) || 30))}m`;
  const local = localOnlyTags(config, repo);
  const localLine =
    local === null
      ? "- This repo's trusted config pins all work to this machine: place --place local only."
      : `- Needs that keep work on this machine in this repo: ${local.length ? local.join(", ") : "none"}.`;
  return [
    "Box routing (t3-box-router). Where this differs from the Lead brief, this wins.",
    "- Place first, then pick. For every worker and every gate:",
    `  ${script} place --run ${run} --count <n> [--needs <tags>]`,
    "  Pass each returned label to swarm as --place <label> (--place local for a local placement).",
    "  No unpinned swarm picks and no swarm pick with --place box in this run: they bypass the router and book no",
    `  slot. For "any box" (a gate, for example) ask the router: place --run ${run} --place box, then pin its label.`,
    `- The wave cap of ${maxParallel} covers local placements. Box placements are bounded by the router's slots: pick`,
    "  them in their own call per label, with --force-wave when a box's share is larger than the cap.",
    "- Append each placement's briefAddendum to that worker's task. When the worker returns, or the dispatch fails:",
    `  ${script} done --slot <slotId> --outcome ok|failed|unreachable`,
    `- Box lost: task_cancel first. Then swarm.mjs cooldown env:<label> ${cool} AND`,
    `  done --slot <slotId> --outcome unreachable --min-cooldown ${cool}`,
    `  (or report <label> unreachable --min-cooldown ${cool} when you hold no slot there).`,
    "  Clearing a cooldown also needs both stores: clear-cooldown <label> here and swarm clear-cooldown env:<label>.",
    "- place answers needsObservation: if it asks only for t3_environment_links, make that read-only call and send",
    '  the reply to observe on stdin as [{"tool":"t3_environment_links","args":{},"pages":[<the reply>]}].',
    "  For anything else, place on another machine or locally and note it for the Coordinator.",
    localLine,
  ].join("\n");
}

// ----------------------------------------------------------------------------------------------------------------
// Observation records, fact patches and bring-up

/** Shape check for observe input. Returns an error string naming the bad record, or null. */
export function observationRecordsProblem(records) {
  if (!Array.isArray(records)) return "observe expects a JSON array of records on stdin.";
  if (!records.length) return "observe got an empty array.";
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const where = `Record ${i}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) return `${where} is not an object.`;
    if (!OBSERVATION_TOOLS.has(r.tool)) return `${where}: tool must be one of ${[...OBSERVATION_TOOLS].join(", ")} (got ${JSON.stringify(r.tool)}).`;
    if (r.args !== undefined && (typeof r.args !== "object" || r.args === null || Array.isArray(r.args))) return `${where}: args must be an object.`;
    if (r.tool !== "t3_environment_links" && typeof r.args?.environmentId !== "string") return `${where}: ${r.tool} needs args.environmentId.`;
    if (!Array.isArray(r.pages) || !r.pages.length) return `${where}: pages must be a non-empty array of raw tool replies.`;
    if (r.pages.some((p) => !p || typeof p !== "object" || Array.isArray(p))) return `${where}: every page must be a JSON object.`;
  }
  return null;
}

export const ts = (v) => (typeof v === "number" ? v : v == null ? NaN : Date.parse(v));

/**
 * After a bring-up hook ran, every fact about that box observed before the hook finished is suspect. Mark those
 * envelopes stale so the next decision has to see fresh link, provider and project facts. Newer facts stay.
 */
export function expireFactsBefore(state, labels, cutoffMs) {
  const observations = { ...(state.observations || {}) };
  let changed = false;
  for (const label of labels) {
    const cur = observations[label];
    if (!cur) continue;
    const next = { ...cur };
    for (const kind of FACT_KINDS) {
      const env = cur[kind];
      if (!env || !(ts(env.observedAt) < cutoffMs)) continue;
      if (ts(env.validUntil) <= cutoffMs) continue;
      next[kind] = { ...env, validUntil: typeof env.validUntil === "number" ? cutoffMs : new Date(cutoffMs).toISOString() };
      changed = true;
    }
    observations[label] = next;
  }
  return changed ? { ...state, observations } : state;
}

export function activeSlotCount(state, label, now, environmentId) {
  return Object.values(state?.slots || {}).filter((s) => (s?.label === label || (environmentId && s?.environmentId === environmentId)) && !(ts(s.expiresAt) <= now)).length;
}

/**
 * Boxes whose bringUp hook may help this acquisition. A box qualifies only when it has a hook, would satisfy the
 * request's hard constraints, has a fresh link read whose verdict (engine.linkVerdict, the same one list and
 * place use) is a recognized down status on a valid link, is not cooling, has no hook running, had no attempt
 * within retryMs, and holds no router slot. A missing link (value null), a gone or expiring link, an unknown
 * status and stale evidence never qualify: facts come first.
 * Returns { candidates: [{label, priority, ephemeral}], skipped: [{label, outcome, reason}] }, candidates in rank
 * order: ephemeral boxes last, then priority, then label.
 * outcome is "in-progress" (a hook runs there now), "recent" (inside the retry window) or "skipped".
 */
export function bringUpCandidates({ config, state, options, repo, now, exclude = new Set(), retryMs = 10 * 60000 }) {
  const repoCfg = (repo && config?.repos?.[repo]) || {};
  const needs = [...new Set([...(options?.needs || []), ...(repoCfg.needs || [])])];
  const deny = new Set(repoCfg.deny || []);
  const candidates = [];
  const skipped = [];
  const skip = (label, reason, outcome = "skipped") => skipped.push({ label, outcome, reason });
  for (const [label, m] of Object.entries(config?.machines || {})) {
    if (!Array.isArray(m?.bringUp) || !m.bringUp.length) continue;
    if (exclude.has(label) || RESERVED_LABELS.has(label)) continue;
    if (m.kind && !MACHINE_KINDS.includes(m.kind)) continue;
    if (deny.has(label)) continue;
    if (repoCfg.pin && repoCfg.pin !== "box" && repoCfg.pin !== label) continue;
    const tags = new Set(m.tags || []);
    if (!needs.every((t) => tags.has(t))) continue;

    const running = activeBringUp(state, label, now, m.environmentId);
    if (running) {
      skip(label, `A bring-up hook is running there (deadline ${new Date(ts(running.deadline)).toISOString()}). Retry acquire after it finishes.`, "in-progress");
      continue;
    }
    const link = freshLink(config, state, label, now);
    if (!link) {
      skip(label, "No fresh link observation. Observe links before a bring-up is considered.");
      continue;
    }
    const v = linkVerdict(config, link, now);
    if (!v || v.state === "ready") continue; // reachable: nothing to bring up
    if (v.state === "unlinked") {
      skip(label, `${v.reason} A bring-up cannot relink or renew a link.`);
      continue;
    }
    if (!v.down) {
      skip(label, `${v.reason} A bring-up needs a recognized down status.`);
      continue;
    }
    const until = state?.health?.[label]?.cooldownUntil;
    if (until && ts(until) > now) {
      skip(label, `Cooling until ${new Date(ts(until)).toISOString()}. clear-cooldown first to allow a bring-up.`);
      continue;
    }
    const last = state?.bringUp?.[label];
    // The retry window throttles bring-ups only: a box torn down at release may be brought up again at once.
    if (last && last.hook !== "tearDown" && last.finishedAt != null && ts(last.finishedAt) + retryMs > now) {
      skip(
        label,
        `A bring-up finished at ${new Date(ts(last.finishedAt)).toISOString()} (${last.outcome}). Not repeated before ${new Date(ts(last.finishedAt) + retryMs).toISOString()}; observe facts and retry, or report the box.`,
        "recent",
      );
      continue;
    }
    const held = activeSlotCount(state, label, now, m.environmentId);
    if (held) {
      skip(label, `${held} router slot(s) held there. Refusing to run a bring-up that could restart T3.`);
      continue;
    }
    candidates.push({ label, priority: Number(m.priority) || 0, ephemeral: m.kind === "ephemeral" });
  }
  // Same ranking as placement: an ephemeral box (the one that may cost money) is started last, then by priority.
  candidates.sort(
    (a, b) => Number(a.ephemeral) - Number(b.ephemeral) || b.priority - a.priority || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return { candidates, skipped };
}

/**
 * Choose and claim bring-ups in one step, for use inside a single state transaction: the candidate checks
 * (slots, cooldown, running hook, retry window) and the claim see the same state, so concurrent acquires and
 * places can never start a second hook or book a slot past the check. While the claim stands, the engine gives
 * no slot or lease on that box.
 *   limit       how many hooks this acquisition may start (its shortfall)
 *   unusable    Map label -> problem, for hooks whose executable failed the check made before the transaction
 *   makeClaim   (label) -> claim record { id, run, pid, startedAt, deadline }; environmentId is added from config
 * Returns { state, claimed: [{label, claim}], report: [{label, outcome, detail}] }.
 */
export function planBringUps({ config, state, options, repo, now, exclude, retryMs, limit, unusable = new Map(), makeClaim }) {
  const { candidates, skipped } = bringUpCandidates({ config, state, options, repo, now, exclude, retryMs });
  const report = skipped.map((s) => ({ label: s.label, outcome: s.outcome, detail: s.reason }));
  const claimed = [];
  let bringUp = { ...(state?.bringUp || {}) };
  for (const c of candidates) {
    if (claimed.length >= limit) break;
    if (unusable.has(c.label)) {
      report.push({ label: c.label, outcome: "skipped", detail: unusable.get(c.label) });
      continue;
    }
    // The claim names the environment the hook is about to start. Adoption and tear-down later act only while
    // the label still maps to it, so a label reassigned in config never inherits this start.
    const claim = { ...makeClaim(c.label), environmentId: config.machines[c.label].environmentId };
    bringUp[c.label] = claim;
    claimed.push({ label: c.label, claim });
  }
  return { state: claimed.length ? { ...state, bringUp } : state, claimed, report };
}

/** Outcomes after which the box may have changed, so earlier facts about it are expired. */
const INVALIDATING_OUTCOMES = new Set(["up", "stopped", "failed", "timeout", "abandoned"]);

/**
 * Record a finished hook and, unless nothing could have changed (refused-busy), expire every fact about the box
 * observed before finishedAt, in the same step that lifts the claim: the box never becomes eligible on facts
 * from before the hook. A claim already reaped or replaced keeps its record, but the facts are still expired.
 * `extra.started` (a bringUp's confirmed start: true, false or null) is recorded only as a boolean.
 */
export function finishBringUp(state, label, claimId, outcome, finishedAt, extra = {}) {
  const cur = state?.bringUp?.[label];
  const invalidates = INVALIDATING_OUTCOMES.has(outcome);
  const at = new Date(finishedAt).toISOString();
  let next = state;
  if (cur && cur.id === claimId && cur.finishedAt == null) {
    const { pid, ...rest } = cur;
    const started = typeof extra.started === "boolean" ? { started: extra.started } : {};
    next = { ...state, bringUp: { ...state.bringUp, [label]: { ...rest, finishedAt: at, outcome, ...started, ...(invalidates ? { invalidatedAt: at } : {}) } } };
  } else if (invalidates && cur && !(ts(cur.invalidatedAt) >= finishedAt)) {
    next = { ...state, bringUp: { ...state.bringUp, [label]: { ...cur, invalidatedAt: at } } };
  }
  return invalidates ? expireFactsBefore(next, [label], finishedAt) : next;
}

/**
 * Finalize every claim whose deadline has passed (its router died or hung) as "abandoned" and expire that box's
 * facts. Run inside every transaction before deciding anything. A dead owner alone is not enough: the hook runs
 * in its own process group and may still be restarting T3 until the deadline.
 */
export function reapBringUps(state, now) {
  let next = state;
  for (const [label, b] of Object.entries(state?.bringUp || {})) {
    if (!b || typeof b !== "object" || b.finishedAt != null) continue;
    if (ts(b.deadline) > now) continue;
    next = finishBringUp(next, label, b.id, "abandoned", now);
  }
  return next;
}

/** How many boxes an acquire result still lacks, or 0 when facts are pending or nothing is missing. */
export function acquireShortfall(result, requested) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return 0;
  if (result.needsObservation) return 0;
  const leased = Array.isArray(result.machines) ? result.machines.length : 0;
  if (Number.isInteger(result.shortfall) && result.shortfall > 0) return result.shortfall;
  return Math.max(0, (requested || 1) - leased);
}
