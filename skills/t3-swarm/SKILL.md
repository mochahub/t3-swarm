---
name: t3-swarm
description: >-
  Three-tier multi-provider orchestration for T3 Code (Coordinator -> Failover Lead -> Tiered Workers).
  Use ONLY in top-level user conversations when the user explicitly requests swarm mode, asks to delegate
  a focused coding task (Mode 1), or when a session grows into multi-workstream/parallel work (ask the user
  in one line before escalating to Mode 2). Never auto-activate for simple questions or quick edits.
  Ignore completely if your prompt contains a standalone line [SWARM ROLE: LEAD] or [SWARM ROLE: WORKER].
---

# t3-swarm — Coordinator Playbook

> **ROLE GUARD (READ FIRST):** This skill applies **only** to top-level user conversations where you are the Front-Door Coordinator. If your prompt contains a standalone line `[SWARM ROLE: LEAD]` or `[SWARM ROLE: WORKER]` (note: T3 may prepend a metadata header above it), **stop reading and ignore this skill completely**—follow only your delegated brief.

## Operating Modes (Switch Freely Mid-Session)

- **Mode 0 — Direct (Default):** Q&A, brainstorming, explanations, quick 1-turn edits. Do it yourself with zero orchestration overhead.
- **Mode 1 — Direct Worker (Light):** Focused 1-track coding or research (1–3 files) that benefits from a dedicated worker without Lead/ledger ceremony.
- **Mode 2 — Full Swarm (Opt-in):** Multi-workstream builds, parallel edits, or high-stakes refactors. **Never auto-activate Mode 2.** Enter Mode 2 only when:
  1. The user explicitly asks (*"use the swarm"*, *"spin up the lead"*, etc.), **OR**
  2. The session grows multi-track and you ask in one concise line (*"This is getting multi-track—want me to switch to swarm mode, or keep it lightweight?"*) and they say yes.

Users can drop back to Mode 0 or Mode 1 at any time.

---

## Preflight (Before Mode 1 or Mode 2)

Locate `scripts/swarm.mjs` inside this skill's directory (if your harness does not expose the skill path directly, check `~/.t3/swarm/config.json`'s `scriptPath` or fall back in order to `~/.gemini/config/plugins/t3-swarm/skills/t3-swarm/scripts/swarm.mjs`, `~/.gemini/config/skills/t3-swarm/scripts/swarm.mjs`, `~/.claude/skills/t3-swarm/scripts/swarm.mjs`, `~/.codex/skills/t3-swarm/scripts/swarm.mjs`, `~/.agents/skills/t3-swarm/scripts/swarm.mjs`) and run:

```bash
node "<script-path>" doctor
```

- If `status` is `"unconfigured"`, hand off to the **`t3-swarm-setup`** skill to generate `~/.t3/swarm/config.json` from the user's enabled T3 providers, then continue.
- If `ok` is `false` (e.g. unwritable `~/.t3/swarm` or corrupt `health.json`), report the error clearly instead of proceeding blindly.
- Call `orchestrator_capabilities` once per thread before your first `delegate_task`.

---

## Quota Cooldowns — Scope Them to What Ran Out

A cooldown broader than the limit hides healthy models: one model's weekly cap, recorded as a cooldown on the whole `claudeAgent` bucket, also hides a healthy Opus. Read the error, then pick the narrowest key:

| The error says… | Key | Example |
| :--- | :--- | :--- |
| One model's cap (weekly model limit, "Fable limit") | `<provider>:<model>` | `cooldown claudeAgent:claude-fable-5-2 --until <reset ISO>` |
| A model family on a shared harness ("third-party quota") | quoted glob | `cooldown 'antigravity:claude-*' 2h` |
| The whole account or plan ("individual quota", "usage limit reached") | bucket | `cooldown codex --until <reset ISO>` |
| Transient 429 / overloaded with no reset time | bucket, short | `cooldown codex 15m` |

- When the error gives a reset time ("resets in 1h42m", "until Nov 24"), pass it as a duration (`1h42m`, `7d`) or `--until <ISO time>`; don't leave the 60-minute default on a limit that lasts a day.
- Always quote globs (zsh fails on an unquoted `*`).
- Read the `cooldown` output: `affects` lists every configured model you just blocked, and `warnings` says when no Lead is left. If that's wider than intended, `clear-cooldown <key>` and use a narrower one.

---

## Mode 1 — Direct Worker Flow (No Lead, No Ledger)

1. Pick `(tier, depth)` in one snap judgment:
   - **Tier:** `fast` (search/docs/boilerplate/checks) · `balanced` *(default)* (features/tests/clear bugs) · `heavy` (tricky bugs/architecture)
   - **Depth:** `low` (obvious path) · `medium` *(default)* · `high` (subtle edge cases/debugging) · `deep` *(rare)*
2. Run (optionally pass `--avoid <your-own-bucket>` when other buckets are healthy):
   ```bash
   node "<script-path>" pick-worker <tier>:<depth>
   ```
3. Read `references/worker-brief.md` and pass it **unchanged** (keeping `[SWARM ROLE: WORKER]` as line 1), appending the scoped goal, files in scope, done-criteria, and a **targeted** verification command (the narrowest test/lint that covers the change, not the full suite).
   - Choose `isolation: "shared"` for quick single-track edits on a clean checkout and for read-only review/research, or `isolation: "worktree"` if the working tree has unrelated dirty changes or the edit is risky.
   - Pass the returned `target` object unchanged to `delegate_task`. Never hand-pick a model outside `config.json`.
4. **Failure handling:**
   - Quota/rate-limit error → scope the cooldown (see *Quota Cooldowns*), re-run `pick-worker`, and retry once.
   - Returned without a `STATUS:` line (e.g. it ended its turn while a test ran in the background) → it is not done. Inspect its diff, then send one finishing pass or finish the small remainder yourself; don't restart from scratch.
   - Technical blocker/stuck → bump once (`medium → high` or `balanced → heavy`) rather than retrying the exact same tier.
5. **Verify before reporting:** Check the worker's reported diff/files and verification output before summarizing cleanly for the user.

---

## Mode 2 — Full Swarm Flow (Coordinator → Failover Lead → Workers)

1. **Initialize single-file state (`<50` lines):**
   ```bash
   node "<script-path>" init "<short-slug>" --goal "<1-2 sentence goal>"
   ```
   - Fill in crisp done-criteria and boundaries in the returned `statePath`.
   - Fill the **Verify** line from the project's own docs (AGENTS.md, CONTRIBUTING, test runner help): the targeted commands workers run per area, and the one full gate the Lead runs on the integration branch. Size it to the risk: a few UI or copy tweaks need their targeted UI tests and a screenshot, not the full suite.
   - **Git safety:** Check `git.dirty` from `init`. If the working tree has uncommitted edits, either launch the Lead with `isolation: "worktree"` (recommended so the user's uncommitted work is never touched) or ask the user whether to commit/stash first.

2. **Pick the active Lead:**
   - Default depth is `high`; use `--depth deep` only for genuinely hard architecture or large cross-system refactors (never `max`/`ultra` unless the user asks).
   ```bash
   node "<script-path>" pick-lead --depth high
   ```
   *(If the user says a bucket/provider is low on quota, run `swarm.mjs cooldown <bucket>` first.)*

3. **Dispatch the Lead (`delegate_task`):**
   - Load `references/lead-brief.md` **unchanged** at the top (so `[SWARM ROLE: LEAD]` stays on line 1) and substitute `{{STATE_PATH}}`, `{{SCRIPT_PATH}}`, `{{CONFIG_PATH}}`, `{{WORKER_BRIEF_PATH}}`, `{{LEAD_BUCKET}}` (from `pick-lead`'s `bucket` field), `{{WORKTREE_PARALLEL}}`, and `{{MAX_LOOPS}}`.
   - Call `delegate_task` with the returned `target` unchanged, `mode: "async"`, and `isolation: "worktree"` when isolating from a dirty/main checkout. End your turn and wait for completion.
   - **From here on the Lead owns its worktree and the integration branch.** Until it returns `STATUS: COMPLETE`, don't run tests or gates there, don't commit, merge or cherry-pick from it, and don't run `finish`.

4. **Handle Lead Outcome (Cap at 2 Lead failovers per run):**
   - **Finished without a `STATUS:` line** (T3 reports the delegated task finished, but the last message is progress like "waiting for the tests"): the Lead is **not** done, and it may still be running.
     1. Read the Lead's thread once (`t3_thread_read`). If a run or background task is still active, end your turn and wait for the next completion notice. Don't poll in a loop.
     2. If it has truly stopped, send the same Lead thread one follow-up: *"Finish the remaining work, update STATE.md, and end with STATUS: COMPLETE or STATUS: ESCALATE."* Don't take over its worktree.
     3. If it stopped because of quota, treat it as a hot failover (below).
   - **Quota / rate-limit / mid-run exhaustion (Hot Failover):**
     1. Scope the cooldown to what ran out (see *Quota Cooldowns*), e.g. `cooldown claudeAgent:claude-fable-5-2 --until <reset>` for a model cap, or the bucket for an account limit.
     2. Run `node "<scriptPath>" pick-lead --depth <same-depth>` to get the next Lead. When every configured lead is out it falls back to the heavy worker pool (`"source": "heavy-fallback"`); that's expected.
     3. Re-dispatch `delegate_task` with `lead-brief.md` unchanged at the top, and **append** a failover note at the end: *"Resuming after Lead failover — inspect `STATE.md`, check any recorded `taskId`s / git branches first so you don't duplicate or clash with prior work, and continue from remaining unchecked tasks."*
     4. If no Lead is available or 2 failovers have already occurred, check in with the user **in a plain-text message** listing concrete options (e.g. clear a too-broad cooldown, wait until a reset time, or name a model to lead). Don't use an interactive question tool for this: some clients can't submit it, and the swarm then sits idle until someone notices.
   - **Non-quota Lead crash/error:** Inspect `STATE.md`, retry once on the next healthy Lead (or report clearly to the user if systemic).
   - **`STATUS: ESCALATE` (rare 1%):** Translate the Lead's question + options into plain English for the user. Once answered, log the decision in `statePath` and re-dispatch the active Lead with the user's answer **appended after** `lead-brief.md`.
   - **`STATUS: COMPLETE`:** Only now may you touch the integration branch. Merge it onto the base if the user wants it landed, translate the verified changes, integration branch/commit, and test evidence into a crisp, human-friendly summary, then archive the run via `node "<scriptPath>" finish <runId>`. `finish` refuses unless the ledger's `Status:` line says `COMPLETE`; if it refuses, the Lead hasn't finished. Use `--force` only for a run you are abandoning.
