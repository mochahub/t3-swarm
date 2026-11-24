---
name: t3-swarm
description: >-
  Three-tier multi-provider orchestration for T3 Code (Coordinator -> Failover Lead -> Tiered Workers).
  Use ONLY in top-level user conversations when the user explicitly requests swarm mode, asks to delegate
  a focused coding task (Mode 1), or when a session grows into multi-workstream/parallel work (ask the user
  in one line before escalating to Mode 2). Never auto-activate for simple questions or quick edits.
  Ignore completely if your prompt or compacted context indicates a delegated Lead or Worker role
  (e.g. [SWARM ROLE: LEAD] or [SWARM ROLE: WORKER]).
---

# t3-swarm — Coordinator Playbook

> **ROLE GUARD (READ FIRST):** This skill applies **only** to top-level user conversations where you are the Front-Door Coordinator. If your prompt or compacted context indicates you are a delegated Lead or Worker (e.g. a standalone line `[SWARM ROLE: LEAD]` or `[SWARM ROLE: WORKER]`, even if T3 prepends metadata above it or compaction summarizes it), **stop reading and ignore this skill completely**—follow only your delegated brief.

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

## Quota Weights

Routing follows `weights` in `config.json`: each billing bucket gets work in proportion to its weight (e.g. Claude 10, Codex 5, Gemini 1), and `--avoid <bucket>` scales that bucket down (×0.5 by default) instead of excluding it. Don't hand-pick a different model to spare a quota; if the shares are wrong, change the weights through `t3-swarm-setup`. A weight of `0` means "only when nothing else is available".

---

## Mode 1 — Direct Worker Flow (No Lead, No Ledger)

1. Pick `(tier, depth)` in one snap judgment:
   - **Tier:** `fast` (search/docs/boilerplate/checks) · `balanced` *(default)* (features/tests/clear bugs) · `heavy` (tricky bugs/architecture)
   - **Depth:** `low` (obvious path) · `medium` *(default)* · `high` (subtle edge cases/debugging) · `deep` *(rare)*
2. Run (pass `--avoid <your-own-bucket>` so your own quota is weighted down):
   ```bash
   node "<script-path>" pick-worker <tier>:<depth>
   ```
3. Start the worker's `task` with the pick output's `workerBrief` **copied verbatim** (it is `references/worker-brief.md`; keep `[SWARM ROLE: WORKER]` as line 1), then append the scoped goal, files in scope, done-criteria, and a **targeted** verification command (the narrowest test/lint that covers the change, not the full suite).
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
   - **Run each Verify command once before dispatch** (they should pass, or fail only where the goal says): a command that doesn't run on this machine costs every Lead and worker a detour.
   - **Git safety:** Check `git.dirty` from `init`. If the working tree has uncommitted edits, either launch the Lead with `isolation: "worktree"` (recommended so the user's uncommitted work is never touched) or ask the user whether to commit/stash first.
   - **Boxes, right after `init`:** if the user has a box skill and the plan has independent work for boxes, get the run's boxes from it and register them (*Boxes* below). Otherwise every worker runs on this machine.

2. **Pick the active Lead:**
   - Default depth is `high`; use `--depth deep` only for genuinely hard architecture or large cross-system refactors (never `max`/`ultra` unless the user asks).
   ```bash
   node "<script-path>" pick-lead --depth high --run <runId>
   ```
   - Always pass `--run <runId>` (from `init`). The Lead choice then sticks to the run: calling `pick-lead` again returns the same Lead while it is healthy, so a check never changes it. With `weights.leadSelection: "weighted"`, leads rotate across runs by weight.
   *(If the user says a bucket/provider is low on quota, run `swarm.mjs cooldown <bucket>` first.)*

3. **Dispatch the Lead (`delegate_task`):**
   - Load `references/lead-brief.md` **unchanged** at the top (so `[SWARM ROLE: LEAD]` stays on line 1) and substitute `{{STATE_PATH}}`, `{{SCRIPT_PATH}}`, `{{CONFIG_PATH}}` (`pick-lead`'s `configPath`), `{{WORKER_BRIEF_PATH}}`, `{{LEAD_BUCKET}}` (from `pick-lead`'s `bucket` field), `{{WORKTREE_PARALLEL}}`, `{{MAX_LOOPS}}`, `{{MAX_PARALLEL}}` (`init`'s `maxParallelWorkers`, or the workstream's `maxParallel`), and `{{STREAM}}` (`the whole run` for a single Lead; the workstream name otherwise).
   - Call `delegate_task` with the returned `target` unchanged, `mode: "async"`, and `isolation: "worktree"` when isolating from a dirty/main checkout.
   - **Optional periodic status updates (Mode 2 only):** If `init` returned `statusUpdates.enabled: true` (or the user asked for periodic updates on this run), call `schedule_task` once with `title: "Swarm status: <slug>"`, `bindToCurrentThread: true`, `schedule: { type: "interval", everyMs: <everyMs> }`, and a concise prompt referencing `<runId>`, `<statePath>`, and the Lead's `childThreadId`:
     - On each tick, read `<statePath>` and call `t3_thread_read` (`view: "messages"`, `limit: 5`; `view: "activity"` only if messages are stale) on the active Lead thread (`<childThreadId>`, or the latest failover Lead in this thread). If the Lead is waiting on workers, `t3_thread_list(includeSubagents: true)` gives running/completed worker counts.
     - **Never interrupt the Lead or touch workers:** do **not** call `t3_thread_send` on a running/waiting Lead, and do **not** call `t3_thread_read` on worker threads (reading a child's final result marks it delivered before the Lead gets it).
     - **Self-cleanup & delivered results:** if `<statePath>` is already `COMPLETE`, `ESCALATE`, or archived—or `t3_thread_read` returns the Lead's final result (which marks it delivered)—call `delete_scheduled_task` immediately and handle the outcome normally. If `t3_thread_read` shows the Lead thread is `cancelled`, `interrupted`, missing, or `failed` with no active workers, call `delete_scheduled_task` immediately, report the stopped state once, and do **not** revive or fail over a user-cancelled/interrupted run.
     - Otherwise post a concise 3–5 line update (elapsed time, done / in-flight / remaining tasks, current focus or blockers, and a rough ETA from elapsed time and remaining waves) and end your turn.
     - If `schedule_task` is unavailable in this environment, skip with a 1-line note rather than blocking the run.
   - **Live view (only when `init` returned `viewer.enabled: true`):** run `viewer.start` with the Lead's `childThreadId` in place of `<first Lead's childThreadId>`. It returns `{ "url" }` once the viewer is listening; open that in a T3 preview tab, or give the user the link. `finish` stops it. Don't start it otherwise.
   - End your turn and wait for completion.
   - **From here on the Lead owns its worktree and the integration branch.** Until it returns `STATUS: COMPLETE`, don't run tests or gates there, don't commit, merge or cherry-pick from it, and don't run `finish`.

4. **Handle Lead Outcome (Cap at 2 Lead failovers per run):**
   - **Stop any active status schedule** (`delete_scheduled_task`) whenever the run reaches `STATUS: COMPLETE`, `STATUS: ESCALATE` (re-create if resumed), is aborted/cancelled, or the user drops back to direct mode (if `scheduledTaskId` was lost to compaction, use `list_scheduled_tasks` outside a scheduled run to find and delete it). When aborting a run, use `task_cancel` on the Lead (which cancels its delegated workers too), delete any status schedule, and archive the abandoned ledger with `swarm.mjs finish <runId> --force` if the user doesn't plan to resume it (it lists the run's boxes: release them through the box skill). On a hot failover with an active schedule, update its prompt with the new Lead's `childThreadId` via `schedule_task({ scheduledTaskId, prompt })` so check-ins stay compaction-safe.
   - **Finished without a `STATUS:` line** (T3 reports the delegated task finished, but the last message is progress like "waiting for the tests"): the Lead is **not** done, and it may still be running.
     1. Read the Lead's thread once (`t3_thread_read`). If a run or background task is still active, end your turn and wait for the next completion notice. Don't poll in a loop.
     2. If it has truly stopped, send the same Lead thread one follow-up: *"Finish the remaining work, update STATE.md, and end with STATUS: COMPLETE or STATUS: ESCALATE."* Don't take over its worktree.
     3. If it stopped because of quota, treat it as a hot failover (below).
   - **Quota / rate-limit / mid-run exhaustion (Hot Failover):**
     1. Scope the cooldown to what ran out (see *Quota Cooldowns*), e.g. `cooldown claudeAgent:claude-fable-5-2 --until <reset>` for a model cap, or the bucket for an account limit.
     2. Run `node "<scriptPath>" pick-lead --depth <same-depth> --run <runId>` to get the next Lead; it records the failover (`failoverFrom`) and, when the failed Lead died within 15 minutes, gives it its turn back. When every configured lead is out it falls back to the heavy worker pool (`"source": "heavy-fallback"`); that's expected.
     3. Re-dispatch `delegate_task` with `lead-brief.md` unchanged at the top, and **append** a failover note at the end: *"Resuming after Lead failover — inspect `STATE.md`, check any recorded `taskId`s / git branches first so you don't duplicate or clash with prior work, and continue from remaining unchecked tasks."*
     4. If no Lead is available or 2 failovers have already occurred, check in with the user **in a plain-text message** listing concrete options (e.g. clear a too-broad cooldown, wait until a reset time, or name a model to lead). Don't use an interactive question tool for this: some clients can't submit it, and the swarm then sits idle until someone notices.
   - **Non-quota Lead crash/error:** Inspect `STATE.md`, then retry once on another Lead with `pick-lead --run <runId> --exclude <provider>:<model>` (the crashed Lead isn't in cooldown, so without `--exclude` the run's sticky pick returns it again). Report clearly to the user if the failure looks systemic.
   - **`STATUS: ESCALATE` (rare 1%):** Translate the Lead's question + options into plain English for the user. Once answered, log the decision in `statePath` and re-dispatch the active Lead with the user's answer **appended after** `lead-brief.md`.
   - **`STATUS: COMPLETE`:** Only now may you touch the integration branch. Merge it onto the base if the user wants it landed, translate the verified changes, integration branch/commit, and test evidence into a crisp, human-friendly summary, then archive the run via `node "<scriptPath>" finish <runId>`, and release any `boxes` it lists through the box skill (its `next` says so). `finish` refuses unless the ledger's `Status:` line says `COMPLETE`; if it refuses, the Lead hasn't finished. Use `--force` only for a run you are abandoning.

---

## Mode 2 with several Leads (workstreams)

One feature often has independent tracks: iOS, Android and web; or game, store listing and website. Give each its own Lead so they run in parallel, and let the Leads coordinate on the run's **board** so their work doesn't overlap.

**Split only when** the tracks can start at once (none needs another's output first), each is big enough for its own waves, and what they share can be written down as contracts (API shapes, data/save formats, string keys, events, flags). Otherwise keep one Lead. At most 4 workstreams.

1. **Init:** `node "<script-path>" init "<slug>" --goal "..." --streams ios,android,web`. It creates the run ledger (`statePath`), one ledger per workstream (`streams[].statePath`, branch `swarm/<runId>--<stream>`, `maxParallel` = the worker budget split between them) and the board (`boardPath`).
   - **Run ledger:** goal, done criteria, the Verify line (including the one full gate), Boundaries shared by everyone. Split shared limits explicitly ("1 Android build at a time: android only"). Seed **Contracts** with every shared interface you already know, one owner each.
   - **Each workstream ledger:** its slice of the goal, **Files in scope**, done criteria and its stream gate. Give every shared file one owner: lockfiles, version bumps, changelog and store text, shared config.
   - **Put the owners on the board before any Lead starts**, so the Leads negotiate from facts: `post <runId> --from <owner> --kind claim --paths "<shared files>"` for each shared file, and `post <runId> --from coordinator --kind contract --owner <stream> "<interface>"` for each known contract (its owner acks it when it starts).
2. **Pick and dispatch one Lead per workstream:** `pick-lead --depth high --run <runId> --stream <name>` (it prefers a different model for each workstream, and says so when it has to share). Dispatch each with `lead-brief.md` unchanged, `{{STATE_PATH}}` = that workstream's ledger, `{{STREAM}}` = its name, `{{MAX_PARALLEL}}` = its `maxParallel`, and always `isolation: "worktree"`: each Lead switches its checkout to its own branch. After each dispatch, fill its row in the run ledger's **Workstreams** (`lead:` model, `thread:` childThreadId) right away: Leads read each other's threads from it through `board`.
3. **Status updates:** one schedule for the run; its prompt lists every Lead's thread and workstream ledger. Update it when a workstream fails over. **Live view** (when enabled): start it once, after the first Lead is dispatched.
4. **Outcomes, per workstream:** the Lead-outcome rules above apply to each one separately: failover with `pick-lead --run <runId> --stream <name>` (max 2 per workstream), the same follow-up for a Lead that stopped without `STATUS:`. One workstream's `ESCALATE` doesn't stop the others. If two Leads escalate a disagreement, decide it, record it in the run ledger's Contracts or Decisions, and `t3_thread_send` the decision to both. Mark each row's `status:` as it finishes.
5. **Integration pass, once every workstream is `COMPLETE`:** `pick-lead --run <runId> --stream integrate` (dispatched with `isolation: "worktree"` too). It refuses (`board_unsettled`) while a workstream isn't COMPLETE, a contract lacks its owner's ack, or an ask is open; settle each as its `hint` says (a Lead's `STATUS: COMPLETE` lists what it left unsettled), or pass `--force` when you have decided to integrate anyway. Then dispatch it with `lead-brief.md` unchanged (`{{STATE_PATH}}` = the run ledger, `{{STREAM}}` = `integration pass`) and append: *"Integration pass: fetch and merge each workstream branch from the Workstreams table into the integration branch, contract owners first. Delegate non-trivial conflicts to workers. Run the full gate once (on a box when the run has one, unless the repo's instructions keep it on this machine), record results in Tasks, set Status COMPLETE."* Add an `- integrate | branch: swarm/<runId> | lead: <model> | thread: <childThreadId> | status: RUNNING` row to Workstreams so the viewer can place it. Its `STATUS: COMPLETE` is the run's; continue with the normal COMPLETE step. `finish` archives the workstream ledgers and the board with the run.

## Boxes (optional, brought up per run)

The swarm never starts, stops or configures a box, and holds no routing policy. Boxes (boat.dev, e2b, a spare computer, anything) come from the user's own box skill; the swarm only uses the ones you register for a run.

1. **Get them:** if a box skill is installed, load it and ask it for this run's boxes, passing the `runId` so the same run can release them later. You need a `label` and an `environmentId` for each. Ask only when the plan has independent work for boxes, and for no more than that work needs. Bringing a box up can take minutes, and boxes may be billed. If the box skill gives you fewer than you asked for, or none, the run goes on with what it has.
2. **Register:** for each box, with its `environmentId`: `orchestrator_capabilities` (`providers[].providerInstanceId` where `canRunChildTask` is true) and `t3_project_list` (each project's `repositoryIdentity.canonicalKey` and `id`; follow `nextCursor`). Then `boxes register --run <runId> '[{ "label": "box-1", "environmentId": "<id>", "providers": ["claudeAgent", "codex"], "projects": { "github.com/owner/repo": "<project id>" } }]'`. It replaces the run's list (`[]` clears it). The output shows each box's `projectHere` (matched by this repo's `origin`) and warns when none has the project.
3. **Use:** workers spread evenly over this machine and the run's boxes. A Lead pins one with `--place local`, `--place box` (any of the run's boxes) or `--place <label>`. A box is skipped, with the reason in `placement.skipped`, only when the picked provider isn't signed in there, this repo's project isn't there, or it is cooled down. A run uses only its own boxes. Picks find their run from the `swarm/<runId>` branch, or `--run`.
4. **Release:** `finish` (also with `--force`) lists the run's `boxes` with a `next`: release them through the box skill, with the `runId`. The swarm doesn't release them for you.

**Restoring boxes mid-run:** a Lead whose box stops answering cools it down (`cooldown env:<label> 30m`), re-picks, and notes it in its ledger. When you next act (a status tick, a failover, a Lead's outcome), ask the box skill again and register the whole list.

**A usable box** is reachable in T3, has this repo's project with push access to `origin`, and has the providers signed in. `placement.skipped` says which one is missing.

- **Leads stay on this machine**, so one router and one `health.json` keep every quota and cooldown in one place.
- **Picks carry the box:** a box pick has `target.environmentId` and `target.projectId`: pass `target` unchanged to `delegate_task`.
- **The repo's own instructions win:** `AGENTS.md`/`CLAUDE.md` decide how to build, test and gate, and which work must stay on this machine (`--place local`). The swarm doesn't encode project rules.
- **Git across machines:** a box only sees `origin`, and its own checkout may lag behind it. Before dispatching to a box, the Lead pushes its integration branch and tells the worker to start from `origin/<branch>`; box workers push their branch back to `origin`, and Leads fetch before merging. T3 runs a task on a box in that box's own checkout, shared by every task there, and refuses `isolation: "worktree"`: a box worker makes its own worktree from `origin/<branch>` first (`lead-brief.md` *Machines* has the wording).
- **Gates run on a box** when the run has one (`--place box`), so this machine stays responsive, unless the repo's instructions keep a gate here.
- **Live view:** `scripts/swarm-viz.mjs` draws the run, with agents on other machines in a labelled frame. It runs only when config has `viewer: { enabled: true }` (Mode 2 step 3).
