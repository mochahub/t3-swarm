/**
 * t3-box-router hook runner (Node 18+, built-in modules only). Every user hook (bringUp, tearDown, keepAlive,
 * handoff, fetch) runs through runHook:
 *   - only the configured argument vector, no shell;
 *   - one JSON object on stdin, never the router's state;
 *   - stdout and stderr discarded (they could carry tokens), so a service the hook starts never inherits a pipe;
 *   - its own process group, stopped with SIGTERM then SIGKILL at the timeout; a router told to stop kills every
 *     group still running before it exits. A process that leaves that group (setsid) escapes.
 *   - an optional result file (T3_BOXES_RESULT_FILE) in a private 0700 directory, of which at most
 *     RESULT_MAX_BYTES are read after the hook exits. Its raw text is returned only to the caller, which must
 *     reduce it (parseStartedMarker) and never print or store it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bringUpArgvProblem } from "./store.mjs";

export const HOOK_BUSY_EXIT = 75; // EX_TEMPFAIL: the hook's own idle check found the box busy.
export const HOOK_KILL_GRACE_MS = 5_000; // SIGTERM to SIGKILL
export const HOOK_BACKSTOP_MS = 2_000; // SIGKILL to giving up on the exit event
// A claim's deadline: the timeout, both grace periods and a margin. Past it, any transaction finalizes the claim.
export const HOOK_CLAIM_MARGIN_MS = 10_000;
export const RESULT_MAX_BYTES = 4096;

const errorMessage = (e) => (e instanceof Error ? e.message : String(e));

/** The claim deadline for a hook with this timeout, in epoch ms. */
export function claimDeadline(now, timeoutMs) {
  return now + timeoutMs + HOOK_KILL_GRACE_MS + HOOK_BACKSTOP_MS + HOOK_CLAIM_MARGIN_MS;
}

/** Shape, then file checks for a hook argument vector. `field` names it in the message. Returns a message or null. */
export function hookArgvProblem(argv, field = "bringUp") {
  const shape = bringUpArgvProblem(argv);
  if (shape) return field === "bringUp" ? shape : shape.replaceAll("bringUp", field);
  try {
    if (!fs.statSync(argv[0]).isFile()) return `${field}[0] ${argv[0]} is not a file.`;
    fs.accessSync(argv[0], fs.constants.X_OK);
  } catch {
    return `${field}[0] ${argv[0]} is missing or not executable.`;
  }
  return null;
}

// Process groups of hooks still running. If the router itself is told to stop (a caller's command timeout sends
// SIGTERM, SIGINT or SIGHUP), it kills these groups before exiting, so a hook never outlives its router unless
// the router is SIGKILLed. A claim then lapses at its deadline and the reaper expires the box's facts.
const liveHookGroups = new Set();
const STOP_SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 };
function onStopSignal(sig) {
  for (const pgid of liveHookGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  process.exit(128 + STOP_SIGNALS[sig]);
}
function trackHookGroup(pgid) {
  if (process.platform === "win32" || !pgid) return;
  if (!liveHookGroups.size) for (const sig of Object.keys(STOP_SIGNALS)) process.on(sig, onStopSignal);
  liveHookGroups.add(pgid);
}
function untrackHookGroup(pgid) {
  if (!liveHookGroups.delete(pgid) || liveHookGroups.size) return;
  for (const sig of Object.keys(STOP_SIGNALS)) process.off(sig, onStopSignal);
}

function makeResultDir() {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "t3-boxes-hook-"));
  } catch {
    return null;
  }
}

// At most RESULT_MAX_BYTES + 1 bytes, so the caller can tell a file that was cut short. Never follows a symlink
// the hook may have put in place of the file.
function readResult(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(RESULT_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, Math.min(n, RESULT_MAX_BYTES)).toString("utf8"), truncated: n > RESULT_MAX_BYTES };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // closed
      }
    }
  }
}

/**
 * Run a hook to completion or its bound. Resolves { outcome, detail, exitCode?, signal?, resultText?,
 * resultTruncated? } and never rejects. outcome: "up" (exit 0), "refused-busy" (exit 75), "failed", "timeout".
 *   name        the hook name, passed as T3_BOXES_HOOK
 *   label       the machine label, passed as T3_BOXES_LABEL
 *   idleCheck   true sets T3_BOXES_IDLE_CHECK=required
 *   resultFile  true offers T3_BOXES_RESULT_FILE and returns what the hook wrote there (bounded, raw: reduce it)
 */
export function runHook(argv, input, timeoutMs, { name = "bringUp", label = input?.label ?? "", idleCheck = true, resultFile = false } = {}) {
  return new Promise((resolve) => {
    const dir = resultFile ? makeResultDir() : null;
    const file = dir ? path.join(dir, "result") : null;
    const env = { ...process.env, T3_BOXES_HOOK: name, T3_BOXES_LABEL: String(label) };
    if (idleCheck) env.T3_BOXES_IDLE_CHECK = "required";
    else delete env.T3_BOXES_IDLE_CHECK;
    if (file) env.T3_BOXES_RESULT_FILE = file;
    else delete env.T3_BOXES_RESULT_FILE;

    const cleanup = () => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", "ignore", "ignore"],
        env,
        shell: false,
        // Its own process group, so a timeout stops everything the hook started, not just the hook.
        detached: process.platform !== "win32",
      });
    } catch (e) {
      cleanup();
      return resolve({ outcome: "failed", detail: `Could not start: ${errorMessage(e)}` });
    }
    let settled = false;
    let timedOut = false;
    const timers = [];
    trackHookGroup(child.pid);
    const settle = (r) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      untrackHookGroup(child.pid);
      try {
        child.stdin?.destroy();
        child.unref();
      } catch {
        // already closed
      }
      if (file && r.outcome === "up") {
        const res = readResult(file);
        if (res) Object.assign(r, { resultText: res.text, resultTruncated: res.truncated });
      }
      cleanup();
      resolve(r);
    };
    const stop = (sig) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop("SIGTERM");
        timers.push(
          setTimeout(() => {
            stop("SIGKILL");
            timers.push(
              setTimeout(
                () => settle({ outcome: "timeout", detail: `No exit within ${timeoutMs} ms; sent SIGTERM, then SIGKILL, and stopped waiting.` }),
                HOOK_BACKSTOP_MS,
              ),
            );
          }, HOOK_KILL_GRACE_MS),
        );
      }, timeoutMs),
    );
    child.on("error", (e) => settle({ outcome: "failed", detail: `Could not start: ${e.code || errorMessage(e)}` }));
    child.on("exit", (code, signal) => {
      if (timedOut) {
        // Whatever the hook left in its group is stopped too; a service it started before the timeout is not
        // trusted to be in a known state.
        stop("SIGKILL");
        return settle({ outcome: "timeout", detail: `No exit within ${timeoutMs} ms; stopped.`, ...(signal ? { signal } : { exitCode: code }) });
      }
      if (code === 0) return settle({ outcome: "up", detail: "Hook exited 0.", exitCode: 0 });
      if (code === HOOK_BUSY_EXIT) {
        return settle({ outcome: "refused-busy", detail: "The hook's idle check found the box busy (exit 75). Nothing was changed.", exitCode: code });
      }
      settle({ outcome: "failed", detail: signal ? `Hook ended by ${signal}.` : `Hook exited ${code}.`, ...(signal ? { signal } : { exitCode: code }) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}

/**
 * Reduce a hook's result file to whether it started the box: true, false, or null when absent, cut short,
 * ambiguous or about another box. Accepted forms, nothing else:
 *   STARTED <label> yes|no        (one or more identical lines; other lines are ignored)
 *   {"started": true|false, "label"?: "<label>"}   (the whole file is one JSON object)
 * Only the boolean is ever kept: no other text or field from the file reaches results or state.
 */
export function parseStartedMarker(text, label, { truncated = false } = {}) {
  if (truncated || typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.started !== "boolean") return null;
    if (obj.label !== undefined && obj.label !== label) return null;
    return obj.started;
  }
  const seen = new Set();
  for (const line of s.split(/\r?\n/)) {
    const m = /^STARTED\s+(\S+)\s+(\S+)\s*$/.exec(line.trim());
    if (!m) {
      if (/^STARTED\b/.test(line.trim())) return null; // a malformed marker is ambiguous, not absent
      continue;
    }
    if (m[1] !== label) return null;
    if (m[2] !== "yes" && m[2] !== "no") return null;
    seen.add(m[2]);
  }
  if (seen.size !== 1) return null;
  return seen.has("yes");
}
