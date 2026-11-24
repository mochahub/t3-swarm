#!/usr/bin/env node
/**
 * swarm-viz.mjs — live tree view of a T3 swarm (prototype).
 *
 * Reads T3 Code's local state DB (~/.t3/userdata/statev2.sqlite) READ-ONLY, rebuilds the
 * thread tree under one root thread (Coordinator -> Lead -> Workers), and streams it to a
 * page over server-sent events: node status from each thread's latest run, edge pulses for
 * briefs/messages sent down and results sent up, and per-node activity (commands, tools).
 * Open the page in a T3 preview tab (preview_open with an environment-port target).
 *
 * Usage: node swarm-viz.mjs [--root <threadId>] [--port 4777] [--run <runId>] [--detach] [--db <path>] [--interval 1000]
 *   --root    any thread of the run (the Coordinator's, or a Lead's childThreadId); the view starts at its
 *             root. Defaults to the root of the most recently updated subagent thread.
 *   --port    first port to try; the next free one (up to +10) is used when it is taken.
 *   --run     the swarm run: writes runs/<runId>.viz.pid so `swarm.mjs finish` stops this viewer, and exits
 *             on its own once the run's ledger is archived.
 *   --detach  start in the background, print {"ok","url","pid"} once it is listening, and return.
 * Machines are named by their T3 link labels.
 *
 * The DB schema is T3-internal and unversioned: every query lives in the "T3 adapter"
 * section below so a T3 upgrade breaks (and gets fixed) in one place.
 * Needs Node >= 22.13 (node:sqlite).
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// node:sqlite prints an ExperimentalWarning on some Node versions; keep stdout clean.
const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) =>
  String(w?.message ?? w).includes("SQLite") ? undefined : origEmitWarning.call(process, w, ...rest);
const { DatabaseSync } = await import("node:sqlite");

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node swarm-viz.mjs [--root <threadId>] [--port 4777] [--run <runId>] [--detach] [--db <path>] [--interval 1000]");
  process.exit(0);
}
const DB_PATH = arg("db", path.join(os.homedir(), ".t3/userdata/statev2.sqlite"));
const SWARM_HOME = process.env.T3_SWARM_HOME || path.join(os.homedir(), ".t3/swarm"); // same override as swarm.mjs
const RUNS_DIR = path.join(SWARM_HOME, "runs");
const ARCHIVE_DIR = path.join(SWARM_HOME, "archive");
const FIRST_PORT = Number(arg("port", "4777"));
const INTERVAL = Math.max(250, Number(arg("interval", "1000")));
const RUN = arg("run", null);
const PID_FILE = RUN ? path.join(RUNS_DIR, `${path.basename(RUN)}.viz.pid`) : null;
let ROOT = arg("root", null);

// --detach: run this same command in the background (its output to a log), wait until it listens, report.
// An agent's shell may not keep a background job alive past its turn; a detached process outlives it.
if (argv.includes("--detach")) {
  const logPath = RUN ? path.join(RUNS_DIR, `${path.basename(RUN)}.viz.log`) : path.join(os.tmpdir(), `swarm-viz-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== "--detach")], { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const m = /swarm-viz: (http:\/\/\S+)/.exec(fs.readFileSync(logPath, "utf8"));
    if (m) {
      console.log(JSON.stringify({ ok: true, url: m[1], pid: child.pid, log: logPath }));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(JSON.stringify({ ok: false, error: "The viewer did not start.", log: logPath, output: fs.readFileSync(logPath, "utf8").slice(-800) }));
  process.exit(1);
}

// ---------------------------------------------------------------- T3 adapter (all schema knowledge lives here)
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const ROOT_EXPR = `CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END`;

const q = {
  latestSubagentRoot: db.prepare(`
    SELECT json_extract(payload_json, '$.lineage.rootThreadId') AS root
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
    ORDER BY updated_at DESC LIMIT 1`),
  thread: db.prepare(`
    SELECT thread_id, title, default_provider, created_at, updated_at, payload_json
    FROM orchestration_v2_projection_threads WHERE thread_id = ?`),
  descendants: db.prepare(`
    SELECT thread_id, title, default_provider, created_at, updated_at, payload_json
    FROM orchestration_v2_projection_threads
    WHERE ${ROOT_EXPR} = ? AND deleted_at IS NULL`),
  latestRun: db.prepare(`
    SELECT ordinal, status, requested_at, completed_at,
           json_extract(payload_json, '$.modelSelection.model') AS model,
           json_extract(payload_json, '$.startedAt') AS started_at
    FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1`),
  // Only small extracted fields leave SQLite; command output and tool results stay behind.
  itemsAfter: db.prepare(`
    SELECT ${itemCols()} FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND ordinal > ? ORDER BY ordinal`),
  itemById: db.prepare(`
    SELECT ${itemCols()} FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ?`),
};

function itemCols() {
  const j = (p) => `json_extract(payload_json, '${p}')`;
  return `turn_item_id AS id, thread_id AS threadId, type, status, ordinal, updated_at AS updatedAt,
    ${j("$.startedAt")} AS startedAt, ${j("$.completedAt")} AS completedAt,
    ${j("$.toolName")} AS toolName, substr(${j("$.title")}, 1, 200) AS title,
    ${j("$.childThreadId")} AS childThreadId, ${j("$.subagentId")} AS subagentId,
    ${j("$.remoteChild.threadId")} AS remoteThread, ${j("$.remoteChild.environmentId")} AS remoteEnv, ${j("$.remoteChild.label")} AS remoteLabel,
    CASE WHEN type = 'subagent' THEN substr(${j("$.result")}, 1, 600) END AS resultHead,
    ${j("$.providerInstanceId")} AS providerInstanceId,
    CASE WHEN type = 'subagent' THEN substr(${j("$.prompt")}, 1, 400) END AS promptHead,
    CASE WHEN type = 'dynamic_tool' THEN ${j("$.input.target.environmentId")} END AS toolEnv,
    CASE WHEN type = 'dynamic_tool' THEN substr(${j("$.output.content")}, 1, 400) END AS toolOut,
    coalesce(${j("$.environmentId")}, ${j("$.target.environmentId")}, ${j("$.childEnvironmentId")}) AS environmentId,
    ${j("$.senderThreadId")} AS senderThreadId, ${j("$.inputIntent")} AS inputIntent,
    ${j("$.createdBy")} AS createdBy, ${j("$.outcome")} AS outcome,
    ${j("$.source.kind")} AS sourceKind, ${j("$.source.childThreadId")} AS sourceChild,
    substr(${j("$.text")}, 1, CASE WHEN type = 'user_message' THEN 20000 ELSE 600 END) AS text,
    CASE WHEN type = 'command_execution' THEN substr(${j("$.input")}, 1, 1200) END AS cmd,
    CASE WHEN type = 'dynamic_tool' THEN substr(coalesce(${j("$.input.title")}, ${j("$.input.file_path")},
      ${j("$.input.pattern")}, ${j("$.input.query")}, ${j("$.input.command")}, ${j("$.input.url")}), 1, 160) END AS toolArg,
    CASE WHEN type = 'dynamic_tool' THEN coalesce(${j("$.input.threadId")}, ${j("$.input.taskId")}) END AS toolTarget`;
}

/** One consistent, short read transaction per tick. Never leaves a reader open. */
function readTx(fn) {
  db.exec("BEGIN");
  try {
    return fn();
  } finally {
    try {
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch {}
    }
  }
}

// ---------------------------------------------------------------- model
const TERMINAL = new Set(["completed", "failed", "cancelled", "declined", "interrupted", "rolled_back"]);
const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running"]);

const nodes = new Map(); // threadId -> node
const itemsByThread = new Map(); // threadId -> { maxOrdinal, open: Map<id, status>, items: [] }
const subagentToThread = new Map(); // subagent node id (= ledger taskId) -> child threadId
const childInfo = new Map(); // child threadId -> what its parent's subagent item says about it
const taskEnv = new Map(); // delegated task id -> the environment the Lead's delegate_task sent it to
const envLabels = new Map(); // linked T3 environment id -> its label (the machine name you gave it)
function readEnvLabels() {
  try {
    for (const r of db.prepare("SELECT environment_id, label FROM peer_environment_links").all()) envLabels.set(r.environment_id, r.label);
  } catch { /* older T3 without linked environments */ }
}
const events = []; // communication + activity events, chronological
const seenEventKeys = new Set();
let ledger = null;
let lastTickAt = null;
let lastError = null;
let version = 0;

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function upsertThread(row) {
  const p = safeJson(row.payload_json);
  const id = row.thread_id;
  let n = nodes.get(id);
  if (!n) {
    n = { id, role: id === ROOT ? "coordinator" : "agent", activity: null, recent: [], brief: null, lastText: null, toolCalls: 0, commands: 0 };
    nodes.set(id, n);
  }
  n.remote = false;
  n.machine = null;
  n.title = row.title;
  n.parentId = id === ROOT ? null : p.lineage?.parentThreadId ?? null;
  n.provider = p.providerInstanceId ?? row.default_provider;
  n.model = n.model ?? p.modelSelection?.model ?? null;
  n.effort = (p.modelSelection?.options || []).find?.((o) => o.id === "effort")?.value ?? null;
  n.createdAt = row.created_at;
  n.updatedAt = row.updated_at;
  n.branch = p.branch ?? null;
  n.taskId = p.forkedFrom?.type === "node" ? p.forkedFrom.nodeId : null;
  if (n.taskId) subagentToThread.set(n.taskId, id);
}

function pushEvent(ev) {
  const key = ev.key;
  if (seenEventKeys.has(key)) return null;
  seenEventKeys.add(key);
  ev.seq = events.length;
  events.push(ev);
  return ev;
}

const short = (s, n = 140) => {
  if (!s) return "";
  const line = String(s).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};
// Drop leading `VAR=value` assignments and `cd dir &&` so a command is shown (and named) by what runs.
function bareCmd(t) {
  let c = String(t || "").trim(), prev;
  do {
    prev = c;
    c = c.replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)[^\s;&]*|[^\s;&]*)\s*(?:;|&&)?\s*/, "")
      .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
  } while (c !== prev);
  return c || String(t || "");
}
const clip = (s, n) => (s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : null); // keeps newlines, for the detail pane
const toolShort = (t) => String(t || "").replace(/^mcp__t3-code__/, "").replace(/^mcp__([^_]+(?:_[^_]+)*)__/, "$1:");

/** Turn one item (new or changed) into node state + events. */
function absorbItem(it, isNewItem, prevStatus) {
  const n = nodes.get(it.threadId);
  if (!n) return [];
  const out = [];
  const ts = it.completedAt || it.startedAt || it.updatedAt;

  // --- communication: something sent DOWN into this thread
  if (it.type === "user_message" && isNewItem) {
    const first = n.brief == null;
    if (first) {
      const raw = it.text || "";
      if (/\[SWARM ROLE: LEAD\]/.test(raw)) n.role = "lead";
      else if (/\[SWARM ROLE: WORKER\]/.test(raw)) n.role = "worker";
      n.brief = briefBody(raw);
    }
    const from = it.senderThreadId && nodes.has(it.senderThreadId) ? it.senderThreadId : it.createdBy === "user" ? "you" : null;
    if (from) {
      const kind = from === "you" ? "prompt" : first ? "brief" : it.inputIntent === "steer" ? "steer" : "message";
      out.push(pushEvent({
        key: `msg:${it.id}`, ts: it.startedAt || ts, kind, from, to: it.threadId,
        label: kind === "brief" ? short(n.title) : short(briefBody(it.text)),
      }));
    }
  }

  // --- communication: a child's result coming UP (subagent item lives in the parent thread)
  if (it.type === "subagent") {
    // A child on another machine has no local thread: T3 records it as `remoteChild` (that machine's
    // environment and thread id), so it gets an id of its own here.
    const childId = it.childThreadId || (it.remoteThread ? `remote:${it.remoteEnv}:${it.remoteThread}` : null);
    if (it.subagentId && childId) subagentToThread.set(it.subagentId, childId);
    // What the parent knows about this child. If the child's thread isn't in this machine's DB
    // (delegated to another machine), this is all we can show for it.
    if (childId) childInfo.set(childId, {
      parentId: it.threadId, title: it.title, status: it.status, provider: it.providerInstanceId,
      // the brief the parent sent says the role, even when the child's own thread is elsewhere
      role: /\[SWARM ROLE: LEAD\]/.test(it.promptHead || "") ? "lead" : /\[SWARM ROLE: WORKER\]/.test(it.promptHead || "") ? "worker" : null,
      environmentId: it.remoteEnv || it.environmentId || (it.subagentId && taskEnv.get(it.subagentId)) || null,
      machineLabel: it.remoteLabel || null, result: it.resultHead || null, startedAt: it.startedAt, completedAt: it.completedAt,
    });
    if (TERMINAL.has(it.status) && it.status !== prevStatus && childId) {
      const child = nodes.get(childId);
      out.push(pushEvent({
        key: `result:${it.id}:${it.status}`, ts: it.completedAt || ts, kind: it.status === "completed" ? "result" : "failure",
        from: childId, to: it.threadId, label: short(child?.lastText || it.resultHead || it.title || it.status),
      }));
    }
  }

  // --- where a delegate went: the delegate_task call names target.environmentId; its result names the taskId
  if (it.type === "dynamic_tool" && toolShort(it.toolName) === "delegate_task" && it.toolEnv && it.toolOut) {
    const tid = String(it.toolOut).match(/"taskId"\s*:\s*"([^"]+)"/)?.[1];
    if (tid) taskEnv.set(tid, it.toolEnv);
  }

  // --- communication: parent checking on / waiting for / messaging a child
  if (it.type === "dynamic_tool" && isNewItem) {
    const tn = toolShort(it.toolName);
    if (["task_status", "t3_thread_read", "t3_thread_wait", "task_cancel", "t3_thread_interrupt"].includes(tn) && it.toolTarget) {
      const target = nodes.has(it.toolTarget) ? it.toolTarget : subagentToThread.get(it.toolTarget);
      if (target && nodes.has(target)) {
        out.push(pushEvent({ key: `poll:${it.id}`, ts: it.startedAt || ts, kind: tn.startsWith("task_cancel") || tn.endsWith("interrupt") ? "cancel" : "poll", from: it.threadId, to: target, label: tn }));
      }
    }
  }

  // --- the root talking back to you
  if (it.type === "assistant_message" && it.threadId === ROOT && TERMINAL.has(it.status) && it.status !== prevStatus) {
    out.push(pushEvent({ key: `reply:${it.id}`, ts, kind: "reply", from: ROOT, to: "you", label: short(it.text) }));
  }

  // --- per-node activity (not edges)
  if (it.type === "assistant_message" && it.text) n.lastText = it.text;
  let act = null;
  if (it.type === "command_execution") { act = { kind: "cmd", text: short(bareCmd(it.cmd), 200) }; if (isNewItem) n.commands++; }
  else if (it.type === "dynamic_tool") { act = { kind: "tool", text: short(`${toolShort(it.toolName)}${it.toolArg ? " " + it.toolArg : ""}`, 120) }; if (isNewItem) n.toolCalls++; }
  else if (it.type === "file_change") act = { kind: "edit", text: "editing files" };
  else if (it.type === "reasoning") act = { kind: "think", text: "thinking" };
  else if (it.type === "assistant_message") act = { kind: "say", text: short(it.text, 120) };
  else if (it.type === "subagent") act = { kind: "spawn", text: `${it.status === "running" ? "running" : it.status}: ${short(it.title, 80)}` };
  if (act) {
    act.status = it.status;
    act.ts = it.startedAt || ts;
    if (!TERMINAL.has(it.status) || !n.activity || (n.activity.ts || "") <= act.ts) n.activity = act;
    // Per-node history only; activity isn't broadcast as events (at 100 agents that's thousands a minute).
    if (isNewItem && (act.kind === "cmd" || act.kind === "tool" || act.kind === "edit")) {
      n.recent.push(act);
      if (n.recent.length > 12) n.recent.shift();
    }
  }
  return out.filter(Boolean);
}

const stripRole = (t) => String(t || "").replace(/^Act as the [^\n]*\n+/, "").replace(/^\[SWARM ROLE: [A-Z]+\]\s*/m, "");

// Briefs are the unchanged template from ../references plus the task-specific part; show only the latter.
const TEMPLATE_TAILS = ["worker-brief.md", "lead-brief.md"].map((f) => {
  try {
    const lines = fs.readFileSync(new URL(`../references/${f}`, import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1];
  } catch { return null; }
}).filter(Boolean);
function briefBody(text) {
  const t = String(text || "");
  for (const tail of TEMPLATE_TAILS) {
    const i = t.indexOf(tail);
    if (i >= 0 && t.slice(i + tail.length).trim()) return t.slice(i + tail.length).trim();
  }
  return stripRole(t).trim();
}

function syncItems(threadId) {
  let st = itemsByThread.get(threadId);
  if (!st) { st = { maxOrdinal: -1, open: new Map() }; itemsByThread.set(threadId, st); }
  const fresh = [];
  // 1. items whose status may still change (PK lookups, bounded)
  for (const [id, prev] of [...st.open]) {
    const it = q.itemById.get(id);
    if (!it) { st.open.delete(id); continue; }
    if (it.status !== prev.status || it.updatedAt !== prev.updatedAt) {
      fresh.push(...absorbItem(it, false, prev.status));
      if (TERMINAL.has(it.status)) st.open.delete(id);
      else st.open.set(id, { status: it.status, updatedAt: it.updatedAt });
    }
  }
  // 2. brand-new items (ordinal is monotonic per thread)
  for (const it of q.itemsAfter.all(threadId, st.maxOrdinal)) {
    st.maxOrdinal = Math.max(st.maxOrdinal, it.ordinal);
    fresh.push(...absorbItem(it, true, null));
    if (!TERMINAL.has(it.status)) st.open.set(it.id, { status: it.status, updatedAt: it.updatedAt });
  }
  return fresh;
}

function computeStatuses() {
  const memo = new Map();
  const kidsOf = new Map();
  for (const k of nodes.values()) { if (!kidsOf.has(k.parentId)) kidsOf.set(k.parentId, []); kidsOf.get(k.parentId).push(k); }
  const status = (n) => {
    if (memo.has(n.id)) return memo.get(n.id);
    memo.set(n.id, "idle"); // cycle guard
    const r = n.run;
    let s;
    if (!r) s = "idle";
    else if (r.status === "waiting") s = "waiting";
    else if (ACTIVE_RUN.has(r.status)) s = "working";
    else if (["failed", "interrupted", "cancelled", "rolled_back"].includes(r.status)) s = "failed";
    else if ((kidsOf.get(n.id) || []).some((k) => ["working", "delegating", "waiting"].includes(status(k)))) s = "delegating";
    else s = n.role === "worker" || n.role === "agent" ? "done" : "idle";
    memo.set(n.id, s);
    return s;
  };
  for (const n of nodes.values()) n.status = status(n);
}

// ---------------------------------------------------------------- ledger (swarm-aware extras, optional)
// A Lead's branch names its run, and its workstream when the run has several Leads:
// swarm/<run-id> (one Lead) or swarm/<run-id>--<stream>.
function parseSwarmBranch(branch) {
  if (!branch?.startsWith("swarm/")) return null;
  const rest = branch.slice("swarm/".length), i = rest.indexOf("--");
  return i > 0 ? { runId: rest.slice(0, i), stream: rest.slice(i + 2) } : { runId: rest, stream: null };
}
function ledgerTasks(text, stream) {
  const tasks = [];
  const sec = text.split(/^## Tasks\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  for (const line of sec.split("\n")) {
    if (!line.startsWith("- ") || line.startsWith("- [ ] (")) continue;
    const parts = line.slice(2).split(" | ").map((s) => s.trim());
    const head = parts[0];
    const label = head.split(/\s+/)[0];
    const taskPart = parts.find((p) => p.startsWith("taskId:"));
    tasks.push({
      label, desc: head.slice(label.length).trim(), tier: parts[1] && !parts[1].startsWith("taskId:") ? parts[1] : null,
      taskId: taskPart ? taskPart.slice("taskId:".length) : null, state: short(parts[parts.length - 1], 90), stream,
    });
  }
  return tasks;
}
const ledgerStatus = (text) => text.match(/\*\*Status:\*\*\s*`?([A-Za-z_]+)/)?.[1]?.toUpperCase() ?? null;
// Board lines (written by swarm.mjs post): `- #<n> | <ISO> | <from> → <to> | <kind> | <paths or -> | <text>`
function readBoardPosts(file) {
  const posts = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^- #(\d+) \| (\S+) \| (\S+) → (\S+) \| (\w+) \| ([^|]*) \|\s?(.*)$/);
      if (m) posts.push({ n: Number(m[1]), at: m[2], from: m[3], to: m[4], kind: m[5], paths: m[6].trim() === "-" ? [] : m[6].split(",").map((x) => x.trim()), text: m[7] });
    }
  } catch {}
  return posts;
}
function claimsFrom(posts) {
  const norm = (x) => String(x).replace(/^\.\//, "").replace(/\/?\*.*$/, "").replace(/\/+$/, "");
  const held = new Map();
  for (const p of posts) {
    const mine = held.get(p.from) || [];
    if (p.kind === "claim") for (const x of p.paths) if (!mine.includes(x)) mine.push(x);
    if (p.kind === "release") { held.set(p.from, p.paths.length ? mine.filter((x) => !p.paths.some((r) => norm(x) === norm(r) || norm(x).startsWith(norm(r) + "/"))) : []); continue; }
    if (p.kind === "done") { held.set(p.from, []); continue; }
    held.set(p.from, mine);
  }
  return Object.fromEntries([...held].filter(([, v]) => v.length));
}

// Which run ledger belongs to this tree. A Lead's branch names it (swarm/<run-id>[--<stream>]) once the
// Lead has switched to it; before that (and for an integration Lead still on a T3-named branch) the
// ledger is found by an agent's thread or task id in it: the Workstreams rows hold each Lead's thread.
let ledgerId = null, ledgerScanAt = 0;
function findLedgerFile() {
  const leads = [...nodes.values()].filter((n) => n.branch?.startsWith("swarm/"));
  const fromBranch = leads.length ? parseSwarmBranch(leads[0].branch).runId : null;
  if (fromBranch) ledgerId = fromBranch;
  const inDir = (id) => [RUNS_DIR, ARCHIVE_DIR].map((d) => path.join(d, id + ".md")).find((f) => fs.existsSync(f)) ?? null;
  if (ledgerId) return inDir(ledgerId);
  if (Date.now() - ledgerScanAt < 10_000) return null;
  ledgerScanAt = Date.now();
  const ids = [...nodes.values()].flatMap((n) => [n.taskId, n.id === ROOT ? null : n.id]).filter(Boolean);
  for (const dir of [RUNS_DIR, ARCHIVE_DIR]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /-[0-9a-f]{4}\.md$/.test(f)).map((f) => path.join(dir, f)); } catch {}
    // newest first; the archive can be long
    files.sort((a, b) => (fs.statSync(b).mtimeMs || 0) - (fs.statSync(a).mtimeMs || 0));
    for (const f of files.slice(0, 50)) {
      let t = "";
      try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
      if (ids.some((id) => t.includes(id))) { ledgerId = path.basename(f, ".md"); return f; }
    }
  }
  return null;
}

// `- <stream> | ledger: .. | branch: .. | lead: .. | thread: .. | status: ..` (the Coordinator fills thread)
function rowField(line, k) {
  const v = line.match(new RegExp(`\\| ${k}: \`?([^|\`]+?)\`?\\s*(?:\\||$)`))?.[1]?.trim();
  return v && v !== "(pending)" ? v : null;
}
const CONTRACT_HEAD_RE = /^\[owner: ([a-z0-9-]+)(?:, replaces #(\d+))?\]\s*/;

function readLedger() {
  for (const n of nodes.values()) if (n.branch?.startsWith("swarm/")) n.stream = parseSwarmBranch(n.branch)?.stream ?? null;
  // `swarm.mjs finish` moves a COMPLETE ledger (and its workstream ledgers and board) from runs/ to archive/
  const file = findLedgerFile();
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const dir = path.dirname(file), id = path.basename(file, ".md");
  const goal = text.match(/\*\*Goal:\*\*\s*([^\n]+)/)?.[1]?.trim() ?? null;
  const tasks = ledgerTasks(text, null);
  // workstreams: one ledger each, and the board they coordinate on
  const streams = [];
  for (const line of (text.split(/^## Workstreams\s*$/m)[1]?.split(/^## /m)[0] ?? "").split("\n")) {
    const name = line.match(/^- ([a-z0-9-]+) \|/)?.[1];
    if (!name) continue;
    let sText = "";
    try { sText = fs.readFileSync(path.join(dir, `${id}.${name}.md`), "utf8"); } catch {}
    // the row's thread is authoritative; the branch is the fallback for rows not filled in yet
    const thread = rowField(line, "thread");
    const lead = (thread && nodes.get(thread)) || [...nodes.values()].find((l) => l.branch?.startsWith("swarm/") && l.stream === name);
    if (lead) lead.stream = name;
    streams.push({ name, leadId: lead?.id ?? null, status: ledgerStatus(sText) || rowField(line, "status")?.match(/^\w+/)?.[0]?.toUpperCase() || null });
    tasks.push(...ledgerTasks(sText, name));
  }
  const board = streams.length ? readBoardPosts(path.join(dir, `${id}.board.md`)) : [];
  const claims = claimsFrom(board);
  for (const st of streams) st.claims = claims[st.name] || [];
  const contracts = board.filter((p) => p.kind === "contract").map((p) => {
    const m = p.text.match(CONTRACT_HEAD_RE);
    return {
      n: p.n, by: p.from, owner: m ? m[1] : null, text: short(m ? p.text.slice(m[0].length) : p.text, 160),
      acks: [...new Set(board.filter((q) => q.kind === "ack" && q.n > p.n && new RegExp(`#${p.n}(?!\\d)`).test(q.text)).map((q) => q.from))],
    };
  });
  return { file, runId: id, status: ledgerStatus(text), goal: short(goal, 240), tasks, streams, board, contracts };
}

// Board posts become events between Leads ("all" fans out to every other Lead on the page). A post
// whose sender or addressee has no card yet (its Lead's row isn't filled in, or its thread hasn't
// appeared) waits for a later tick instead of being skipped for good.
let boardSeen = 0;
function boardEvents() {
  if (!ledger?.streams?.length) return [];
  const leadOf = (name) => name === "coordinator" ? ROOT : ledger.streams.find((s) => s.name === name)?.leadId ?? null;
  const out = [];
  for (const p of ledger.board) {
    if (p.n <= boardSeen) continue;
    const from = leadOf(p.from) ?? (p.from === "integrate" ? ROOT : null);
    const to = p.to === "all" ? "leads" : leadOf(p.to) ?? (p.to === "integrate" ? ROOT : null);
    if (!from || !to) {
      // give up on a post after a minute (its stream may never get a card, e.g. a Lead on another machine)
      if (Date.now() - Date.parse(p.at) < 60_000) break;
      boardSeen = p.n;
      continue;
    }
    boardSeen = p.n;
    const what = p.paths.length ? p.paths.join(", ") : p.text.replace(CONTRACT_HEAD_RE, "");
    out.push(pushEvent({ key: `board:${ledger.runId}:${p.n}`, ts: p.at, kind: "board", sub: p.kind, from, to, label: short(`${p.kind}: ${what}`, 120) }));
  }
  return out.filter(Boolean);
}

// ---------------------------------------------------------------- tick
let rootResolved = false;
function resolveRoot() {
  if (ROOT && !rootResolved) {
    // --root may name any thread of the run (a Lead's childThreadId): start at the run's root.
    const row = q.thread.get(ROOT);
    let lineageRoot = null;
    try { lineageRoot = JSON.parse(row?.payload_json || "{}")?.lineage?.rootThreadId || null; } catch {}
    if (lineageRoot) ROOT = lineageRoot;
    rootResolved = Boolean(row);
  }
  if (ROOT) return ROOT;
  const r = q.latestSubagentRoot.get();
  if (!r?.root) throw new Error("No subagent threads found; pass --root <threadId>.");
  return r.root;
}

let ledgerReadAt = 0;
function tick() {
  const fresh = [];
  if (!ledgerReadAt) readEnvLabels(); // machine names before the first cards are made
  readTx(() => {
    ROOT = resolveRoot();
    const rootRow = q.thread.get(ROOT);
    if (!rootRow) throw new Error(`Root thread ${ROOT} not found.`);
    upsertThread(rootRow);
    for (const row of q.descendants.all(ROOT)) upsertThread(row);
    // parents before children so senderThreadId lookups resolve
    const order = [...nodes.values()].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    for (const n of order) {
      if (n.remote) continue; // no local thread to read
      const r = q.latestRun.get(n.id);
      n.run = r ? { ordinal: r.ordinal, status: r.status, startedAt: r.started_at || r.requested_at, completedAt: r.completed_at } : null;
      if (r?.model) n.model = r.model;
      fresh.push(...syncItems(n.id));
    }
    // Children whose thread is not in this DB (e.g. delegated to another machine): show them
    // from their parent's subagent item, marked remote, instead of dropping them.
    for (const [cid, c] of childInfo) {
      if (!nodes.has(c.parentId)) continue;
      const existing = nodes.get(cid);
      if (existing && !existing.remote) continue;
      if (!existing && q.thread.get(cid)) continue; // local thread outside this tree's lineage index; skip
      const n = existing || { id: cid, recent: [], brief: null, lastText: null, toolCalls: 0, commands: 0, activity: null };
      Object.assign(n, {
        remote: true, machine: (c.environmentId && envLabels.get(c.environmentId)) || c.machineLabel || c.environmentId || null,
        lastText: n.lastText || c.result || null,
        parentId: c.parentId, title: c.title || "Subagent",
        role: c.role || (n.role === "agent" || !n.role ? "worker" : n.role), provider: c.provider || null, createdAt: c.startedAt,
        run: { ordinal: 1, status: c.status === "running" ? "running" : c.status, startedAt: c.startedAt, completedAt: c.completedAt },
      });
      nodes.set(cid, n);
    }
  });
  // A child that runs on another machine but is mirrored here still gets that machine's name.
  for (const n of nodes.values()) {
    const env = !n.remote && n.taskId && taskEnv.get(n.taskId);
    if (env) n.machine = envLabels.get(env) || env;
  }
  computeStatuses();
  // A result's label is the child's final message; on the first (history) pass the parent's
  // subagent item can be read before the child's messages, so fill those labels in now.
  for (const ev of fresh) {
    if ((ev.kind === "result" || ev.kind === "failure") && nodes.get(ev.from)?.lastText) ev.label = short(nodes.get(ev.from).lastText);
  }
  if (Date.now() - ledgerReadAt > 3000) {
    ledgerReadAt = Date.now();
    readEnvLabels();
    ledger = readLedger();
    fresh.push(...boardEvents());
    if (ledger) for (const t of ledger.tasks) {
      const tid = t.taskId && (subagentToThread.get(t.taskId) || [...nodes.values()].find((n) => n.taskId === t.taskId)?.id);
      if (tid && nodes.has(tid)) Object.assign(nodes.get(tid), { ledgerLabel: t.label, tier: t.tier, ledgerState: t.state });
    }
  }
  lastTickAt = new Date().toISOString();
  return fresh.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}

function snapshot() {
  const ns = [...nodes.values()].map((n) => ({
    id: n.id, parentId: n.parentId, title: n.title, role: n.role, provider: n.provider, model: n.model, effort: n.effort,
    status: n.status, createdAt: n.createdAt, run: n.run, activity: n.activity, recent: n.recent.slice(-8),
    brief: clip(String(n.brief || "").replace(/^-{3,}\s*/, ""), 2000), lastText: clip(n.lastText, 1200), toolCalls: n.toolCalls, commands: n.commands,
    ledgerLabel: n.ledgerLabel ?? null, tier: n.tier ?? null, ledgerState: n.ledgerState ?? null,
  }));
  const pending = (ledger?.tasks || []).filter((t) => !t.taskId).map((t) => ({ label: t.label, desc: t.desc, tier: t.tier, state: t.state, stream: t.stream ?? null }));
  return {
    v: version, root: ROOT, now: new Date().toISOString(), lastTickAt, lastError,
    ledger: ledger && { runId: ledger.runId, status: ledger.status, goal: ledger.goal }, pending, nodes: ns,
  };
}

// ---------------------------------------------------------------- v2: small summaries as diffs, long text on demand
// At 100 agents a full snapshot with briefs is ~0.5 MB; sending it every second is wasteful.
// v2 sends each agent's summary once, then only the agents that changed; elapsed times are
// computed in the page from run.startedAt, so an agent that is just "working" doesn't change.
function liteNode(n) {
  return {
    id: n.id, parentId: n.parentId, title: n.title, role: n.role, provider: n.provider, model: n.model, effort: n.effort,
    status: n.status, createdAt: n.createdAt, run: n.run, activity: n.activity, toolCalls: n.toolCalls, commands: n.commands,
    ledgerLabel: n.ledgerLabel ?? null, tier: n.tier ?? null, ledgerState: n.ledgerState ?? null,
    remote: !!n.remote, machine: n.machine ?? null, stream: n.stream ?? null,
  };
}
function meta() {
  const pending = (ledger?.tasks || []).filter((t) => !t.taskId).map((t) => ({ label: t.label, desc: t.desc, tier: t.tier, state: t.state, stream: t.stream ?? null }));
  return {
    root: ROOT, now: new Date().toISOString(), lastTickAt, lastError, pending,
    ledger: ledger && { runId: ledger.runId, status: ledger.status, goal: ledger.goal },
    ...(ledger?.streams?.length ? { streams: ledger.streams, contracts: ledger.contracts } : {}),
  };
}
const sentLite = new Map(); // id -> JSON last broadcast
function v2Diff() {
  const upserts = [], seen = new Set();
  for (const n of nodes.values()) {
    const l = liteNode(n), s = JSON.stringify(l);
    seen.add(n.id);
    if (sentLite.get(n.id) !== s) { sentLite.set(n.id, s); upserts.push(l); }
  }
  const removed = [...sentLite.keys()].filter((id) => !seen.has(id));
  for (const id of removed) sentLite.delete(id);
  return { upserts, removed };
}
const v2Init = () => ({ meta: meta(), nodes: [...nodes.values()].map(liteNode), events });

// ---------------------------------------------------------------- server
const clients = new Set();   // v1 page (full snapshots)
const v2clients = new Set(); // v2 page (diffs)
function broadcast(set, type, data) {
  if (!set.size) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

let runCheckedAt = 0;
function loop() {
  // finish archives the run's ledger (and stops this viewer); exit on our own if that signal was missed
  if (RUN && Date.now() - runCheckedAt > 10_000) {
    runCheckedAt = Date.now();
    if (!fs.existsSync(path.join(RUNS_DIR, `${path.basename(RUN)}.md`))) shutdown();
  }
  let fresh = [];
  try {
    fresh = tick();
    lastError = null;
    version++;
  } catch (err) {
    lastError = String(err?.message || err);
  }
  if (clients.size) broadcast(clients, "state", { snapshot: snapshot(), events: fresh });
  const d = v2Diff(); // always, so the baseline stays current even with no page open
  broadcast(v2clients, "tick", { meta: meta(), ...d, events: fresh });
}
const sse = (res) => res.writeHead(200, {
  "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no",
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    res.write(`retry: 2000\n\n`);
    res.write(`event: init\ndata: ${JSON.stringify({ snapshot: snapshot(), events })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/v2/events") {
    sse(res);
    res.write(`retry: 2000\n\n`);
    res.write(`event: init\ndata: ${JSON.stringify(v2Init())}\n\n`);
    v2clients.add(res);
    req.on("close", () => v2clients.delete(res));
    return;
  }
  if (url.pathname === "/v2/state") { // polling fallback: full summaries + events since a seq
    const since = Number(url.searchParams.get("since") ?? -1);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ ...v2Init(), events: events.filter((e) => e.seq > since) }));
    return;
  }
  if (url.pathname === "/api/node") { // one agent's long text, fetched when its panel is open
    const n = nodes.get(url.searchParams.get("id") || "");
    res.writeHead(n ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(n ? {
      id: n.id, brief: clip(String(n.brief || "").replace(/^-{3,}\s*/, ""), 4000), lastText: clip(n.lastText, 2000), recent: n.recent.slice(-10),
    } : { error: "unknown agent" }));
    return;
  }
  if (url.pathname === "/api/state") {
    const since = Number(url.searchParams.get("since") ?? -1);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ snapshot: snapshot(), events: events.filter((e) => e.seq > since) }));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(readPage());
    return;
  }
  res.writeHead(404).end("not found");
});
setInterval(() => { for (const res of [...clients, ...v2clients]) res.write(`: hb\n\n`); }, 15000);

// first tick before listening so the page opens with history; history is read thread by
// thread, so put it in time order once (later ticks arrive in order)
try { tick(); } catch (err) { lastError = String(err?.message || err); }
events.sort((a, b) => (a.ts || "").localeCompare(b.ts || "")).forEach((e, i) => { e.seq = i; });
setInterval(loop, INTERVAL);
let port = FIRST_PORT;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && port < FIRST_PORT + 10) return server.listen(++port, "127.0.0.1");
  console.error(`swarm-viz: ${err.message}`);
  process.exit(1);
});
server.on("listening", () => {
  const url = `http://127.0.0.1:${port}`;
  if (PID_FILE) {
    try { fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, url, root: ROOT }) + "\n"); } catch {}
  }
  console.log(`swarm-viz: ${url}  root=${ROOT}  nodes=${nodes.size}  events=${events.length}`);
});
server.listen(port, "127.0.0.1");
function shutdown() {
  try { db.close(); } catch {}
  try {
    if (PID_FILE && JSON.parse(fs.readFileSync(PID_FILE, "utf8")).pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------- page
// The page lives next to this script and is read on every request, so it can change
// without restarting the server.
const PAGE_FILE = new URL("./swarm-viz.html", import.meta.url);
function readPage() {
  try { return fs.readFileSync(PAGE_FILE, "utf8"); }
  catch (err) { return `<!doctype html><p>swarm-viz.html is missing next to swarm-viz.mjs (${String(err.message)})</p>`; }
}
