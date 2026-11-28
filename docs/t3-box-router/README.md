# t3-box-router

Pick the machine a [T3 Code](https://t3.codes) task runs on: this one, or one of a few always-on linked boxes.
`t3-swarm` (or the agent itself) still picks the provider and model; the router picks the machine, books a
short-lived slot there, explains why, and returns the T3 target plus the Git handoff text for the worker.

- **Standalone** from any T3 harness: `place` → `delegate_task` → `done`.
- **With t3-swarm** as the user's "box skill", using today's swarm commands (Level 0): `acquire`, `observe`,
  `register-payload`, `policy-line`, `release`, `keep-alive`.

It is a zero-dependency Node 18+ CLI that runs on demand. There is no daemon, queue or monitor. Design,
rationale and evidence: [SPEC.md](SPEC.md) (historical; the references below describe the integrated CLI).

## What this release does, and what it doesn't

| Included | Not included |
| --- | --- |
| Local, always-on, on-demand and ephemeral machines with stable T3 environment IDs | Cloud provisioning, spend, pricing |
| Hard `--needs`, soft `--prefers`, strict priority tiers, `maxConcurrent` slots, exclusive tags; ephemeral ranks last | Weights, affinity, per-repo priorities or caps |
| Fixed 30-minute cooldown, `recovering` limited to one slot | Growing backoff |
| Cached T3 facts with expiry (links 15 min, providers and projects 24 h) | Reading T3's private files or databases |
| Hardware and toolchain profiles from a read-only probe, applied automatically | Credential detection (owner attestations only) |
| User-owned `bringUp`, `tearDown`, `keepAlive`, `handoff` and `fetch` hooks; teardown only for boxes the run started | Hooks the router writes, link renewal, repo override file |
| Git handoff through `origin` with per-task worktrees; user-owned handoff and fetch hooks for uncommitted work | Snapshots the router makes itself, SSH fetch, artifact pull |
| Level 0 swarm integration through a generated policy line | Changes to swarm itself (Level 1) |

## Install

> [!IMPORTANT]
> Install on the **orchestrating machine only**: the harness where your Coordinator or standalone agent runs.
> Boxes never need it; a worker on a box only follows its handoff text. Use `--copy` so harnesses that scan
> `~/.agents/skills/` globally don't load it into worker sessions. The skill's role guard tells workers and
> delegated children to ignore it, and tells swarm Leads to follow only their policy line.

```bash
npx skills@latest add mochahub/skills --skill t3-box-router -g -a claude-code --copy
```

Install it next to `t3-swarm` if you use the swarm. One router home per Coordinator machine: slots only count work
that this router placed.

## Set up

Ask your agent to "set up t3-box-router". It follows
[setup.md](../../skills/t3-box-router/references/setup.md):

1. `discover` proposes a row per linked environment, from `t3 environment list --json` when the `t3` CLI is
   installed, otherwise from a `t3_environment_links` reply the agent pipes in.
2. You confirm labels (keep T3's link labels; `local` and `box` are reserved), tags, priority, `maxConcurrent`,
   exclusive tags, and that each box can push to `origin`. `init` writes `~/.t3/boxes/config.json`
   (`T3_BOXES_HOME` overrides the directory). Start from
   [config.example.json](../../skills/t3-box-router/references/config.example.json).
3. `doctor`, then one test placement, then `done` to return the slot. Then probe each new box as in
   [probe.md](../../skills/t3-box-router/references/probe.md).

"Box first until full, then local": give the box priority 10 and six slots and local priority 0 and four slots.
A batch of seven fills six on the box and one locally. Tags only local has (for example `ios-sim`) keep that
work local regardless of priority.

## Standalone recipe

```sh
box_router() { node "$HOME/.claude/skills/t3-box-router/scripts/box-router.mjs" "$@"; }
git push -u origin feature/base
box_router place --needs linux --provider claudeAgent --base feature/base --branch feature/worker-1
# ok:false + needsObservation → make the listed T3 reads, pipe them to `box_router observe`, place again
```

Then call `delegate_task` with `target` = your provider plus the placement's `environmentId` and `projectId`, no
`isolation`, and the full task with `briefAddendum` appended. When it returns:

```sh
box_router done --slot <slotId> --outcome ok   # failed: task problem; unreachable: machine lost
git fetch origin feature/worker-1
```

If the box drops mid-task: `task_cancel`, then `done --outcome unreachable`, then place again and continue from
the last pushed branch.

## Swarm recipe (Level 0)

The full sequence is in [swarm.md](../../skills/t3-box-router/references/swarm.md). The parts that matter most:

- On a cold cache the first `acquire` exits nonzero with `needsObservation`. That is expected: make the reads,
  `observe`, acquire again.
- Write `register-payload` to a file and check its exit code before `swarm boxes register`. Never pipe them
  together: an error or `[]` would empty the run's box list.
- Paste `policy-line`'s text verbatim into Boundaries. It overrides the Lead brief on purpose: every pick is
  pinned to a router placement, box slots add to the local wave cap, and gates go through `place --place box`.
- Machine cooldowns live in two stores at Level 0. Mirror outages to the router with `--min-cooldown`, and clear
  both stores.
- `release --run <runId>` after `swarm finish`, using the run ID you saved.

## Machines, probes and lifecycle

- **Kinds.** `always-on` (never stopped by the router), `on-demand` and `ephemeral` (the router stops them only when
  this run started them and nothing else holds them). Table in [setup.md](../../skills/t3-box-router/references/setup.md#machine-kinds).
- **Profiles.** A read-only probe reports each box's hardware and tools. The Coordinator runs it in the background
  for boxes `place`/`acquire`/`list` report as `unprofiledBoxes`, then applies it with `apply-probe` without an
  owner step. Dedupe and the flow: [probe.md](../../skills/t3-box-router/references/probe.md). Owner attestations
  cover `cred:` and `secret:` tags only.
- **Bring-up.** `acquire` may run a box's `bringUp` hook when it is down. The router owns the box for the run only if
  the hook writes `STARTED <label> yes` (or `{"started": true}`) to `T3_BOXES_RESULT_FILE`. Stdout is not read yet.
- **Teardown, keep-alive, handoff, fetch.** `release` stops only owned on-demand or ephemeral boxes, when no other
  run, slot, hook or keep-alive holds them. `keep-alive` renews a lease. `handoff` and `fetch` call the user's own
  transfer hooks for uncommitted work. The contract, conditions and manual steps when a release leaves a box running:
  [setup.md](../../skills/t3-box-router/references/setup.md#lifecycle-hooks).

Sample config with one always-on and one on-demand box: [config.example.json](../../skills/t3-box-router/references/config.example.json).

## Limits to know

- Slots are advisory. They don't see work started by another Coordinator or outside the router.
- At Level 0 swarm cannot enforce a pin; a Lead that loses the policy line can overfill a box.
- A box link with `read-only` access is skipped. How an `approval-required` link behaves for an unattended child
  is untested.
- Cross-environment attachments and `t3_thread_launch` worktree strategies on a box are unverified; `t3 thread
  start` is not a dispatch path. See [transport.md](../../skills/t3-box-router/references/transport.md).
- The router provisions nothing. Cloud machines need your own start and stop scripts ([drivers.md](../../skills/t3-box-router/references/drivers.md)).
