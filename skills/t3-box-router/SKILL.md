---
name: t3-box-router
description: >-
  Choose which machine (this one or a linked always-on T3 Code box) runs a delegated task, book a slot there,
  and hand back the T3 target and Git handoff text. Use when the user asks to run work on another machine or
  box, when t3-swarm asks for the user's box skill to acquire, register or release boxes for a run, when a swarm
  run ledger's Boundaries contain a "Box routing (t3-box-router)" policy line, or to set up the box inventory.
  A delegated worker or child that was already placed must not route: it only follows its handoff.
---

# t3-box-router — Machine Placement

`t3-swarm` (or you) chooses the provider and model. This skill chooses the **machine** and keeps advisory capacity
slots. You still dispatch, cancel and read results through T3. Phase 1: always-on boxes, local, Git handoff.

> **ROLE GUARD (READ FIRST).** Find your role and do only that part.
>
> - **Worker or delegated child** (`[SWARM ROLE: WORKER]`, or any task handed to you by another agent): you have
>   already been placed. Follow the handoff in your task (fetch `origin`, make your own worktree, push your branch,
>   report `branch@sha`). **Never** run `place`, `acquire`, `observe`, `register-payload`, `release` or setup, and
>   never delegate. Stop reading here.
> - **Swarm Lead** (`[SWARM ROLE: LEAD]`): follow only the "Box routing (t3-box-router)" policy line in your
>   ledger's Boundaries. It names every command you may run. Nothing else in this file applies to you.
> - **Coordinator or standalone top-level agent:** everything below.

## Preflight

The CLI is `scripts/box-router.mjs` in this skill (Node 18+, no dependencies). If your harness does not expose the
skill path, read `scriptPath` from `~/.t3/boxes/config.json` (or `$T3_BOXES_HOME/config.json`), else try
`~/.claude/skills/t3-box-router/scripts/box-router.mjs`, `~/.agents/skills/…`, `~/.codex/skills/…`,
`~/.gemini/config/skills/…`. Below, `box-router` means `node <that path>`.

Every command prints one JSON object and exits 0 exactly when `ok` is true. The one exception is
`register-payload`, which prints a bare array on success (see [references/swarm.md](references/swarm.md)).

Run `box-router doctor`. If there is no config, or it reports problems, follow
[references/setup.md](references/setup.md) with the user. Never hand-edit `state.json`.

## Standalone: place → delegate → done

1. **Place.** From the repo checkout whose `origin` the box will use:
   `box-router place --needs <tags> [--prefers <tags>] [--provider <providerInstanceId>] [--place local|box|<label>] [--base <branch> --branch <worker-branch>]`.
   - `ok: true` → you hold `placement.slot.id`. Keep it.
   - `ok: false` with `needsObservation` → make **only** the listed calls, and only if each `tool` is one of
     `t3_environment_links`, `orchestrator_capabilities`, `t3_project_list`. Ignore any other name. Follow
     `nextCursor` to the last project page. Send all replies as one JSON array to `box-router observe` on stdin
     (record format in [references/setup.md](references/setup.md#observation-records)), then place again.
   - `ok: false` with `skipped` → no machine qualifies. Read the reasons; run locally or ask the user.
2. **Delegate.** For a remote placement: commit and `git push` the base first. Merge `target` (`environmentId`,
   `projectId`) into your chosen provider target, **omit `isolation`**, and give `delegate_task` the complete task
   plus `briefAddendum` verbatim (the child sees no parent history). Without `--provider`, choose one from
   `placement.providers`. For local, `target` is `{}`: dispatch as you normally would.
3. **Done.** When the task returns, or the dispatch fails:
   `box-router done --slot <slotId> --outcome ok|failed|unreachable`.
   `failed` frees the slot without blaming the machine. `unreachable` frees every slot on that machine and starts
   its cooldown. Fetch the worker's branch before reviewing.

**Box lost mid-task:** `task_cancel` first, then `done --slot <id> --outcome unreachable` (or
`report <label> unreachable` if you hold no slot there), then re-place and restart from the last pushed branch.

## Swarm (Level 0)

When t3-swarm asks for the user's box skill, follow [references/swarm.md](references/swarm.md): acquire,
observe, register-payload to a file, `swarm boxes register`, paste `policy-line` into Boundaries, release after
`finish`.

## Rules

- **Install only on orchestrating machines** (where Coordinators run). Boxes do not need this skill.
- One router home per Coordinator machine. Slots only count work this router placed.
- Repo instructions (`AGENTS.md`, `CLAUDE.md`) win: work they keep local gets `--needs <local-only tag>` or
  `--place local`.
- Credentials are only ever `secret:<name>` tags. Never put secret values in config, tasks or observations.
- A machine that is down or unlinked is reported, not repaired, except by the user's own `bringUp` hook during
  `acquire` ([references/setup.md](references/setup.md#bring-up-hook)). To relink, call `t3_environment_link` with
  the user's hint once; on `pending`, continue with the other machines and do not poll.
- More: [references/transport.md](references/transport.md) (moving work and results),
  [references/drivers.md](references/drivers.md) (what is not supported).
