# t3-box-router architecture and scope

## 1. Summary

**Status — Proposal. No implementation.**

`t3-swarm` chooses the provider, model, depth and quota bucket. `t3-box-router` chooses the execution machine. The
calling agent dispatches the work through T3 Code. A remote dispatch uses the selected machine's `environmentId`
and its project's `projectId` in `delegate_task.target`.

Give each fact one owner. The user's router inventory defines machines, tags, priority and capacity. T3 owns link,
provider and project facts. The router caches those facts with an expiry and owns placement slots and machine
cooldowns. Swarm owns quota, model cooldowns and run coordination. A swarm box registration is a snapshot for that
run. Phase 1 also has a known overlap in machine cooldowns because swarm still checks its own environment
cooldowns.

The first release serves agents with one to five always-on machines. It is a zero-dependency Node CLI whose central
command, `place`, takes a short-lived slot and explains why the machine fits. An agent can use it directly from any
T3 harness or use it as the box skill swarm already expects. In a swarm, the Lead passes each chosen label to the
existing `--place` flag. Remote work moves through an existing Git remote in Phase 1. In both paths, the agent
starts and cancels tasks, and reports their outcomes to the router.

The router runs on demand. It has no worker queue or background monitor. Setup, acquisition and health checks are
local operations in Phase 1. Later phases add opt-in transport and recovery helpers, a direct swarm integration,
and an experimental driver interface for short-lived machines.

Router commands, fields and behaviors below are proposed interfaces. Swarm and T3 behavior is identified as
existing where it informs the design.

## 2. Problem statement and design principles

Swarm's `chooseEnvironment` gives every eligible machine, including local, weight 1 (S:1418–1422). Its lease
carries links, providers and projects. `parseRegisterInput` drops extra fields such as weights, tags and capacity
(S:1322–1346). `validateBoxes` warns that inventory keys in swarm config are ignored (S:846–850). That leaves
actual machine policy in project-specific prose and run ledgers. The audited box skill describes box-first work,
per-box caps, local-only work and credential availability. The Lead has to apply those rules on each dispatch, and
overlapping runs can exceed a box's intended cap.

The swarm contract asks for a label and environment ID per box, keyed to a run, with release after finish. The
audited provider implements it for one setup. A standalone agent has to discover links and projects, establish
which providers can run there, and arrange Git transport itself. T3 reports link reachability and exposes separate
project, provider and device queries. Its environment records give no hardware inventory, load, live-task count or
capacity. The findings surfaced no file return tool.

- Keep policy in one inventory and cache facts from supported interfaces. The
  script cannot call MCP tools. It can use `t3 environment list --json` for
  links and consume agent-supplied JSON through `observe`. Each observation
  records its source, timestamp and expiry. Private T3 files and databases
  stay outside the routing path.
- Filter on correctness before comparing preferences. Every selection has a
  reason. Rejections identify the machine and cause.
- Track capacity with expiring slots. A slot accounts for work this router
  placed. It cannot exclude an external task or prove that the host is idle.
- Keep machine control with the user. Phase 1 uses read-only discovery and
  probes. Later hooks run only against explicit, trusted configuration. T3
  and the user control access. Renewal can be opted into per box.
- Use the same placement rules for standalone calls, swarm's existing pins
  and a future direct swarm integration.
- Keep startup and installation small. Use Node 18 or later and built-in
  modules. Commands emit one JSON object on stdout and exit 0 exactly when
  `ok` is true. The raw registration array is the compatibility exception
  described below.

## 3. Boundary with t3-swarm

| Fact or operation | Owner | Interface for other components |
| --- | --- | --- |
| Inventory, tags, priority and capacity | Router `config.json` | Read through `list`. |
| Link state and access, eligible providers and project IDs | T3 | Router caches observations. Swarm consumes a run snapshot through `register-payload`. |
| Derived machine health and machine cooldowns | Router `state.json` | Callers report health events. Level 0 has the temporary duplication described below. |
| Slots and run leases | Router `state.json` | Router commands acquire, expire and release them. |
| Provider, model, depth, buckets, model cooldowns and `maxSessionsPerBucket` | Swarm config and health | Router may filter a stated provider against the observed provider set. |
| Run ledger, board, Lead placement, waves and wave cap | Swarm | Router reads a run ID supplied by the caller. |
| Task launch, cancellation and result retrieval | Calling agent through T3 | Agent reports the outcome to the router. |
| Link creation and access approval | T3 and the user | Agent may request a card. Phase 2 adds explicit opt-in renewal. |

### The three machine-state locations in swarm

| Existing location | Level 0 | Level 1 with a router configured |
| --- | --- | --- |
| `<runId>.boxes.json` | Same swarm file and schema. Write the router-generated snapshot through `boxes register`. Keep it replaceable, without hand edits. | Keep the compatibility snapshot, including for swarm without a router. Router owns placement policy. |
| `health.cooldowns["env:<label>"]` | Swarm reads its environment cooldowns, including exact IDs. The Lead mirrors an outage to the router. | Forward machine cooldown operations. Read machine health from the router. |
| `health.credits.envs` | Every pick is pinned, so the credits have no say in which machine wins. | Remove these credits from the configured path. Keep legacy selection when no router is configured. |

Swarm's snapshot writes `at` but never reads it. A crashed run leaves its snapshot until it is archived, for
instance with `finish --force`. Router leases expire independently after 24 hours by default. `place` and `acquire`
for that run renew the lease. Leases can overlap and do not reserve slots. `release --run` is idempotent and takes
the original ID explicitly because the swarm branch stops resolving to a run after `finish`.

### Level 0 · Phase 1 with existing swarm commands

Swarm's box contract in `SKILL.md` is explicit. It says to pass the “`runId` so the same run can release them
later” and “You need a `label` and an `environmentId` for each.” The registration step specifies provider and
project reads per environment. The cleanup instruction says to “release them through the box skill, with the
`runId`” (lines 152–155).

| Contract step | Router behavior |
| --- | --- |
| Ask after init, only for independent work and only for as many boxes as needed. | `acquire --run` returns distinct machines, full or partial. A run can proceed locally when zero are available. |
| Discover and register providers and projects. | The agent makes the T3 reads, `observe` joins and caches them, and `register-payload` assembles the exact swarm array. |
| Use only that run's registered boxes. | `place --run` considers that run's leases and local. The Lead pins every swarm pick and verifies the returned target before dispatch. |
| Release with the run ID from `finish`, including forced finish. | `release --run` drops the lease. Always-on boxes stay available to other runs. |

**Coordinator.** The examples use `box-router` as shorthand for `node <router-script>` and `swarm` for `node
<swarm-script>`. Variables name values returned by the commands. Run from the checkout with the intended `origin`.

```sh
swarm init "$slug" --config "$swarm_config"
box-router acquire --run "$run_id" --count 1 --needs linux
# As requested by acquire, read link, provider and project facts in T3.
box-router observe < "$box_observations"
box-router acquire --run "$run_id" --count 1 --needs linux
box-router register-payload --run "$run_id" > "$register_payload"
swarm boxes register --run "$run_id" --config "$swarm_config" - < "$register_payload"
box-router policy-line --run "$run_id"
```

Take `run_id` from init. On a cold cache, `acquire` nominates candidates in `needsObservation` before it leases
them. That first call answers `ok: false` and exits nonzero, which is expected. For each candidate the Coordinator uses `orchestrator_capabilities` and `t3_project_list` with its
`environmentId`. Follow `nextCursor` and feed each complete project list and the provider reply to `observe`. Use
fresh CLI or agent-supplied link data as well. Retry acquisition after the reads. On a warm cache, the first
acquisition can succeed and fresh replies can go directly to registration. This preserves the per-box reads and
checks before the router hands out a usable lease.

A usable remote lease requires a reachable link with enough time left, a project for this repo and at least one
eligible provider. Push access to `origin` for a matching project is a user declaration in Phase 1, confirmed
during setup. Phase 2 checks it for boxes with declared SSH. Neither reachability nor push access is checked by
today's swarm. Refresh the lease and register the entire array after a box is restored, as swarm's docs already
instruct. If registration fails, resolve it or run locally. The proposed `register-payload` emits the raw array on
success to fit swarm's stdin interface, and a JSON error object on failure. The separate commands above let the
Coordinator check the generator's exit code before registering.

Put the generated policy in the run ledger's Boundaries (and in each workstream ledger) before dispatching Leads.
Leads always run on the Coordinator's machine (S:2269). `policy-line` renders text like this from config, in the `text` field of its JSON reply, with the
script path, run ID and cap filled in:

```text
Box routing (t3-box-router). Where this differs from the Lead brief, this wins.
- Place first, then pick. For every worker and every gate:
  node <router-script> place --run <runId> --count <n> [--needs <tags>]
  Pass each returned label to swarm as --place <label> (--place local for a local placement).
  No unpinned swarm picks and no swarm pick with --place box in this run: they bypass the router and book no
  slot. For "any box" (a gate, for example) ask the router: place --run <runId> --place box, then pin its label.
- The wave cap of <maxParallel> covers local placements. Box placements are bounded by the router's slots: pick
  them in their own call per label, with --force-wave when a box's share is larger than the cap.
- Append each placement's briefAddendum to that worker's task. When the worker returns, or the dispatch fails:
  node <router-script> done --slot <slotId> --outcome ok|failed|unreachable
- Box lost: task_cancel first. Then swarm.mjs cooldown env:<label> 30m AND
  done --slot <slotId> --outcome unreachable --min-cooldown 30m
  (or report <label> unreachable --min-cooldown 30m when you hold no slot there).
  Clearing a cooldown also needs both stores.
- place answers needsObservation: if it asks only for t3_environment_links, make that read-only call and send
  the reply to observe on stdin as [{"tool":"t3_environment_links","args":{},"pages":[<the reply>]}].
  For anything else, place on another machine or locally and note it for the Coordinator.
- Needs that keep work on this machine in this repo: <tags from config, e.g. ios-sim, xcode>.
```

Two lines of the Lead brief are overridden on purpose, and the spec does not hide that. The brief tells a Lead to
pick without a pin (`lead-brief.md` line 22) and to send gates with `--place box` (line 30). Both let swarm choose
the box from its own credits (S:1418–1422) and book no router slot. The brief also caps a wave at one number for
all machines (lines 11 and 21) and never mentions `--force-wave`. The Lead runs under the unchanged brief, so the
policy text has to say in so many words that it wins. The surveyed hand-built setup already works this way: its
Coordinator writes a "box first" paragraph into Boundaries that tells Leads to pick box workers in their own
`--place box` calls with `--force-wave`.

**Known Level 0 gap.** Swarm cannot enforce a pin. A Lead that loses the Boundaries text after a compaction, or
skips it, can make an unpinned pick. That pick lands on a box through swarm's even spread and the router never
counts it. Slots are advisory, so nothing breaks, but the box can exceed its cap. Only Level 1 closes this.

**Lead.** Group a wave by needs, then group returned slots by label for picking. The example assumes six tasks with
the same needs, six available remote slots, and a swarm cap of four.

```sh
box-router place --run "$run_id" --count 6 --needs linux
swarm pick-workers balanced:medium balanced:medium balanced:medium balanced:medium balanced:medium balanced:medium \
  --config "$swarm_config" --run "$run_id" --place home-box --force-wave
# Push the integration branch, then use delegate_task with each returned target.
box-router done --slot "$slot_id" --outcome ok
# Example of a separate task that needs a local simulator.
box-router place --run "$run_id" --needs ios-sim --place local
swarm pick-worker balanced:low --config "$swarm_config" --run "$run_id" --place local
```

Call router `place` without `--provider` here. Swarm normally picks a model before a machine (S:1074, S:1096). With
a pin, swarm already filters models whose providers cannot run on the pinned machine (S:1025–1032). Its target
carries the chosen model and, for a box, the observed environment and project IDs. Dispatch with that target and
append the router's worktree instructions to the worker's task. Use one slot per dispatch, including gates: where
the brief says `pick-worker balanced:low --place box`, run `place --place box` first and pin the label it returns. If a
whole `pick-workers` group fails, release each undispatched slot from that group with `done --outcome failed`. This
outcome frees accounting without blaming the machine. Re-place only after resolving the eligibility or policy
issue.

`pick-workers` has one `--place` flag for the call. All specs, including box specs, count toward the per-call
`defaults.maxParallelWorkers` cap (default 4). Single `pick-worker` has no cap. Group picks by label and use
`--force-wave` only for box groups that exceed the cap. Keep local work within the Lead's ledger wave allowance as
well as the router's local slots. This lets remote shares add to the Coordinator's local allowance, which is the
decision here: the wave cap exists to protect the Coordinator's machine, and a box has its own cap. The per-stream
shares in the ledger are advisory. Swarm applies its per-bucket soft cap within each pick call. Global router slots
bound parallel placements even when several Leads or runs route to the same box from this installation.

**Health seam.** When a dispatch fails because its box is unreachable, the existing Lead brief sets a 30-minute
swarm environment cooldown. The generated policy mirrors it to the router. If a worker stops answering during a
task, cancel it first with `task_cancel`. Report the outage, then re-pick using the recoverable branch. A later
completion report for an already-freed slot is harmless.

```sh
swarm cooldown env:home-box 30m --config "$swarm_config" --run "$run_id"
box-router report home-box unreachable --min-cooldown 30m
```

Level 0 uses a router cooldown at least as long as the effective swarm cooldown. If swarm rejects a pin due to a
longer cooldown, release the undispatched slot, read the effective duration from swarm, and report that duration to
the router before placing again. Two stores hold the same outage fact in Level 0. The router never reads swarm's
private health file.

Clearing is the other half of the seam. A manual clear in one store leaves the other cooling, and the mirror rule
above would then copy the stale cooldown back. So at Level 0 a manual clear goes to both: `box-router
clear-cooldown home-box`, and `swarm clear-cooldown` for `env:home-box` and for `env:<environmentId>` if that key
was used (swarm matches either, S:1374–1380). Level 1 removes both halves of the seam.

**Coordinator cleanup.** After the run reaches its terminal state, archive it and release using the saved run ID.
`finish` returns `boxes` and `next` when boxes were registered. Release also applies when swarm had no snapshot but
the router acquired a lease.

```sh
swarm finish "$run_id"
box-router release --run "$run_id"
```

### Level 1 · Phase 3 proposal for the swarm owner

Add a swarm config key `boxRouter` naming the script. Swarm validates the pick request and asks the router for the
wave's placements before entering `withHealth`. It passes `--count`, the run ID, and the caller's `--place` and
`--needs` when supplied. Feed each result into the existing pick path as that spec's pin. Retain the target and
placement shape and carry router reasons in `placement.skipped`. Swarm names the machine `environment` there
(`placement.environment`, `skipped[].environment`); the router's `label` maps to it. Continue to use `tier[:depth]`
for the model spec. `parseSpec` explicitly removed tags from that syntax.

The existing lock waits 3 seconds and treats an older-than-10-second lock as stale. An external call under the lock
could time out another pick or allow two writers. Keep router calls, including slot rollback, outside it. Apply the
normal wave validation before booking slots. If a wave cannot be assembled, free every undispatched slot outside
the lock. Forward machine-key `cooldown` and `clear-cooldown` and define `clear-cooldown all` to clear both owners'
cooldowns when configured. Remove legacy machine cooldowns from the configured pick path with a migration plan for
active cooldowns.

If the router errors or times out, and the caller allows local work, fall back to local with a `placement.skipped`
reason. An explicit `--place box` or box label makes that error fatal. A valid router answer with no eligible
placement is a policy result and propagates as such. The caller still applies known local task constraints before
dispatch. Keep the existing behavior when the config key is absent. Swarm's quota hook already fails open on hook
errors (S:83), but `checkQuota` has no machine argument, runs inside the lock, and belongs to a single user-owned
module.

| Swarm change area | Functions, paths and references |
| --- | --- |
| Discover and validate the router | `loadConfig`, `validateConfig` and `validateBoxes` (S:273–365, S:759–850). The existing ignored keys are `environments`, `machines`, `placement` and `boxes`. |
| Place before the health lock | The `pick-worker` and `pick-workers` handlers (S:2316–2400), `withHealth` (S:220–234) and `selectOneWorker` (S:990–1103). Keep the existing provider pre-filter and per-spec pin. |
| Keep placement compatible | `runPlaces`, `chooseEnvironment` and `applyPlacement` (S:1351–1365, S:1394–1436). Preserve registration, pass through reasons, and bypass unpinned environment ranking in the configured path. |
| Move environment health | `envCooldown`, `envMisfit`, cooldown and clear handlers, health initialization and expiry, and status display (S:161, S:188–216, S:1374–1388, S:1536–1647, S:2041–2043). |
| Document setup and selection | Swarm `SKILL.md` lines 150, 154, 157 and 162, `references/lead-brief.md` lines 21, 25 and 30, setup `SKILL.md` line 51, docs README lines 152–158 and 272, and CLI help S:1510–1516. |
| Viewer | Preserve the T3 label-based grouping. Add router decision reasons to the viewer through a supported router output. Its current read-only T3 database source for display is outside routing. |

Adding weights to registration would require a schema change, leave decisions based on run snapshots and preserve
duplicate cooldowns. Putting the inventory in swarm config would also leave standalone routing without its own
interface. Direct calls preserve the ownership table and fit both entry points.

## 4. Standalone use from any T3 harness

The caller needs a T3 thread with dispatch tools and a local Node 18+ runtime. Give an agent the installed script's
absolute `scriptPath` if its harness has no copy of the skill. The command and observation formats are the same
across harnesses. A shell outside a T3 thread can inspect router state. Starting work with `t3 thread start` is an
open question.

### Step 1 · Place

Run `box-router place --needs linux --provider '<providerInstanceId>'`. Omit `--provider` to ask for any eligible
provider. In that case choose a supported provider from the result before dispatch, or return the unused slot and
retry with a specific provider. The router computes the repo key from `git remote get-url origin`, matching swarm's
`canonicalRepoKey`. If the base is already pushed, pass `--base <branch>` and `--branch <worker-branch>` to fill in
the handoff.

| `place` flag | Phase | Meaning |
| --- | --- | --- |
| `--needs a,b` | 1 | Hard tags. A machine without all of them is filtered. |
| `--prefers a,b` | 1 | Soft tags. A tie-break inside the winning priority tier. |
| `--provider <providerInstanceId>` | 1 | Only machines where this provider can run a child task. |
| `--place local\|box\|<label>` | 1 | Restrict to this machine, to any remote box, or to one label. |
| `--run <runId>` | 1 | Restrict remote candidates to that run's lease, and renew the lease. |
| `--count <n>` | 1 | Book up to `n` placements in one call. |
| `--base <branch>`, `--branch <worker-branch>` | 1 | Fill the branch names into `briefAddendum`. |
| `--affinity <key>` | 2 | Prefer the machine that last served this key, to reuse a worktree and caches. |
| `--kind <name>`, `--read-only` | 2 | Task kind for repo `localOnlyKinds`; allow a `read-only` link for work that writes nothing. |

`--base`, `--branch` and the configured `worktreeRoot` end up inside a shell line that the worker runs on the box.
The router therefore rejects, before booking anything, a branch that fails `git check-ref-format --branch` or
contains a character outside `A-Z a-z 0-9 . _ / -`, and a `worktreeRoot` outside that set plus a leading `~`.
`worktreeRoot` comes from the user's config only, never from a repo file.

A remote result looks like this.

```json
{
  "ok": true,
  "target": {
    "environmentId": "<environmentId>",
    "projectId": "<projectId>"
  },
  "placement": {
    "label": "home-box",
    "remote": true,
    "providers": ["<providerInstanceId>"],
    "slot": { "id": "<slotId>", "expiresAt": "2030-01-01T13:00:00Z" },
    "why": "Highest eligible priority tier with a free slot.",
    "skipped": [{ "label": "local", "reason": "Missing required tag linux." }]
  },
  "briefAddendum": "Run on home-box. In its project checkout, run git fetch origin && git worktree add ~/work/<worker-branch> -b <worker-branch> origin/<branch>. Work there, then push your branch to origin."
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True when the slot has been booked. |
| `target` | Machine-specific fields to merge into the caller's T3 target. |
| `target.environmentId` | Linked box ID. |
| `target.projectId` | T3 project for this repo on that box. |
| `placement` | Placement metadata owned by the router. |
| `placement.label` | Machine inventory label. |
| `placement.remote` | True for a remote box. |
| `placement.providers` | Observed provider IDs eligible to run children there. |
| `placement.slot` | Advisory booking. |
| `placement.slot.id` | Opaque handle to return with `done`. |
| `placement.slot.expiresAt` | Time at which the slot leaves active capacity accounting. |
| `placement.why` | Explanation of the selection. |
| `placement.skipped` | List of machines removed by a filter or lower priority. |
| `placement.skipped[].label` | Skipped machine label. |
| `placement.skipped[].reason` | Reason the machine was skipped. |
| `briefAddendum` | Text to append to the worker brief, including the base and worktree instructions. |

A local result keeps the caller's T3 target unchanged. Local inherits the current project context, so it needs no
link, no project and no provider observation: the caller is already running there, and it never answers
`needsObservation`. `placement.providers` is omitted for local. The router still accounts for a local slot.

```json
{
  "ok": true,
  "target": {},
  "placement": {
    "label": "local",
    "remote": false,
    "slot": { "id": "<slotId>", "expiresAt": "2030-01-01T13:00:00Z" },
    "why": "Local provides ios-sim and has a free slot.",
    "skipped": [{ "label": "home-box", "reason": "Missing required tag ios-sim." }]
  },
  "briefAddendum": "Run on the caller's machine. Use the caller's local checkout instructions."
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True for a booked local slot. |
| `target` | Empty for inherited local execution. |
| `placement` | Local placement metadata. |
| `placement.label` | Reserved label `local`. |
| `placement.remote` | False on the caller's machine. |
| `placement.slot` | Local capacity booking. |
| `placement.slot.id` | Handle returned to `done`. |
| `placement.slot.expiresAt` | End of the booking. |
| `placement.why` | Explanation of why local fits. |
| `placement.skipped` | Filtered or lower-priority machines. |
| `placement.skipped[].label` | Skipped machine label. |
| `placement.skipped[].reason` | Reason the machine was skipped. |
| `briefAddendum` | Local checkout instructions or a pointer to the caller's instructions. |

With fresh facts and no eligible machine, the CLI returns an error and books nothing.

```json
{
  "ok": false,
  "error": "No eligible machine.",
  "skipped": [
    { "label": "local", "reason": "Missing required tag gpu." },
    { "label": "home-box", "reason": "Exclusive tag gpu is in use." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `ok` | False because no machine qualifies. |
| `error` | Summary for the caller. |
| `skipped` | Per-machine explanations. |
| `skipped[].label` | Skipped machine label. |
| `skipped[].reason` | Hard constraint that prevented selection. |

When a stale or missing fact about an otherwise eligible candidate could change the answer, the command returns an
observation request before booking a slot. This example uses the agent-supplied link path. When the CLI can refresh
the links itself, the request can omit that read.

```json
{
  "ok": false,
  "needsObservation": {
    "calls": [
      { "tool": "t3_environment_links", "args": {} },
      { "tool": "orchestrator_capabilities", "args": { "environmentId": "<environmentId>" } },
      { "tool": "t3_project_list", "args": { "environmentId": "<environmentId>" } }
    ],
    "observe": "box-router observe"
  }
}
```

| Field | Meaning |
| --- | --- |
| `ok` | False until the needed facts are present. |
| `needsObservation` | Instructions for refreshing evidence. |
| `needsObservation.calls` | Exact T3 calls for the agent to make, with further project pages requested as needed. |
| `needsObservation.calls[].tool` | Harness-neutral T3 tool name. |
| `needsObservation.calls[].args` | Tool arguments. |
| `needsObservation.calls[].args.environmentId` | Queried environment on tools that accept it. |
| `needsObservation.observe` | Router command to receive the results on stdin. |

`needsObservation.calls[].tool` is only ever one of three read-only tools: `t3_environment_links`,
`orchestrator_capabilities`, `t3_project_list`. The skill tells the agent to ignore any other name, so a tampered
state file cannot turn this field into a way to make the agent call something else.

For each call, give `observe` a record with its `tool`, `args`, and a `pages` array of raw tool replies, one for a
non-paginated call. Send the records as one JSON array on stdin. Complete the `t3_project_list` pagination with
`nextCursor` before supplying the project record.

```json
[
  {
    "tool": "t3_environment_links",
    "args": {},
    "pages": [
      { "links": [{ "environmentId": "<environmentId>", "label": "home-box", "status": "reachable", "access": "full-access", "expiresAt": "2030-02-01T00:00:00Z", "lastError": null }] }
    ]
  },
  {
    "tool": "orchestrator_capabilities",
    "args": { "environmentId": "<environmentId>" },
    "pages": [
      { "providers": [{ "providerInstanceId": "<providerInstanceId>", "canRunChildTask": true }] }
    ]
  },
  {
    "tool": "t3_project_list",
    "args": { "environmentId": "<environmentId>" },
    "pages": [
      { "projects": [{ "id": "<projectId>", "repositoryIdentity": { "canonicalKey": "github.com/owner/repo" }, "archivedAt": null, "deletedAt": null }], "nextCursor": 1 },
      { "projects": [] }
    ]
  }
]
```

| Tool | What the router keeps | Matched to a machine by |
| --- | --- | --- |
| `t3_environment_links` | Per link: `status`, `access`, `expiresAt`, and `lastError` reduced to a short sanitized summary, or null. | `links[].environmentId` equal to a configured `environmentId`. Unknown links are ignored (`discover` is what proposes them). |
| `orchestrator_capabilities` | `providers[].providerInstanceId` where `canRunChildTask` is true. | `args.environmentId`. |
| `t3_project_list` | A map from `repositoryIdentity.canonicalKey` (lowercased) to `id`, skipping projects whose `archivedAt` or `deletedAt` is set. | `args.environmentId`. |

Everything else in the replies is discarded, so model lists, paths and titles never reach the state file. `observe`
answers `{ "ok": true, "updated": ["home-box"] }` with the labels it refreshed, or `ok: false` with the record it
could not read. The router timestamps receipt and re-evaluates on the next `place`. T3 says of the project list
that "Pages can shift", so a project missing from a complete read is reported as "no project observed for this
repo" with a hint to read once more, not as proof that the box lacks it. If a T3 read fails, report it to the
caller as missing evidence. The caller can still ask to place explicitly on a known eligible machine.

### Step 2 · Delegate

Push the committed base for a remote dispatch. Merge the remote target into the model selection and pass the
combined target to `delegate_task`. Include the brief addendum and give the worker the full task because the child
receives no parent history. This is an example tool request.

```json
{
  "task": "Run the targeted verification on the pushed branch. Run on home-box. Fetch origin, create your own worktree from origin/<branch>, and report the result.",
  "target": {
    "providerInstanceId": "<providerInstanceId>",
    "environmentId": "<environmentId>",
    "projectId": "<projectId>"
  }
}
```

| Field | Meaning |
| --- | --- |
| `task` | Complete worker instructions, including the handoff. |
| `target` | Placement and the caller's selected provider. |
| `target.providerInstanceId` | Eligible provider chosen by the caller. |
| `target.environmentId` | Linked environment from a remote placement. |
| `target.projectId` | Matching project on that environment. |

Omit `isolation` for a remote delegation. The swarm docs say T3 refuses `isolation: "worktree"` on a box. The
Lead's T3 audit did not rerun that test, so Phase 1 uses the documented manual worktree procedure.

### Step 3 · Return the slot

Once the tool reports completion, or a dispatch attempt fails, run `box-router done --slot '<slotId>' --outcome
ok`. Use `failed` for task or dispatch failures unrelated to machine reachability: it frees this slot and leaves
the machine's health alone. Use `unreachable` when the machine is lost: it is exactly `report <label> unreachable`
for the slot's machine, so it frees every slot there and starts the cooldown, and it takes the same
`--min-cooldown`. `report` exists for the caller that holds no slot on the lost machine. For an active lost task,
cancel first.

```json
{
  "ok": true,
  "slot": "<slotId>",
  "released": true
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True when the command handled the report. |
| `slot` | Handle supplied by the caller. |
| `released` | False if the slot was already released or expired. |

## 5. Routing model

### Tags and machine kinds

A machine provides tags. A task needs hard tags and may prefer soft ones. Use one namespace for OS, architecture,
devices, tools, resources and credential presence. Examples include `linux`, `macos`, `arm64`, `gpu`, `ram-32g`,
`godot`, `android-sdk`, `xcode`, `ios-sim`, `android-emu`, `signed-in-browser` and `secret:<name>`. Local-only work
can require a tag only local provides or take an explicit local pin where repo rules demand it.

Local is always present with tags, priority and capacity. Obtain its OS and architecture from Node's `os`.
An always-on box has a stable T3 environment ID in config. An ephemeral box is a leased driver instance with the
lowest priority tier. A user may associate a machine with a device host. Use `device_list` and
`hosts[].platforms[].available` to suggest `ios-sim` and `android-emu` for that host. Its `hostId` and a linked
environment ID belong to separate namespaces. A missing device-host mapping supplies no evidence about installed
emulators. Declare other tags in user config.

Inventory labels are globally unique. Always-on environment IDs are unique too, so one physical entry cannot get
two capacity pools by accident. Reserve `local` and `box` for the router and swarm selectors. `doctor` rejects
either as a remote machine label. `discover` proposes T3's link label so the router, swarm and viewer normally
agree, and flags collisions for the user. Swarm accepts those reserved labels in a payload today and only enforces
uniqueness within one registration.

### Decision order

1. **Filter.** A remote requires a fresh, `reachable` link with enough time
   remaining, an eligible provider, a matching project and link access
   suitable for the task. Phase 1 skips a box whose link `access` is
   `read-only`. That reading of `access` is inferred from the field's
   name and the link tool's access enum; it has not been tested, and
   neither has how an `approval-required` link behaves for an unattended
   child. Require all `needs`, enforce active cooldowns, capacity and exclusive tags,
   and apply trusted or narrowing project restrictions. Respect
   `--place local|box|<label>`. With `--run`, require a current lease for
   each remote. Local remains available to the run, subject to its own
   filters. For a remote, with `--provider`, require that specific
   provider; without it, require an eligible provider set and return it.
   Local has no provider check: the caller is running there, and choosing
   a provider that works locally is the caller's job. Give each rejected
   machine an actionable reason.
2. **Choose the highest eligible priority tier.** A full box drops out
   before priority is compared. Lower tiers take overflow. Ephemeral boxes
   always rank below eligible always-on or local machines.
3. **Choose within that tier.** In Phase 1 this is a plain ordering that
   stores no ranking credits: more `--prefers` tags matched; then the
   lowest load, `activeSlots / maxConcurrent`; then label. Health does
   not reorder machines in Phase 1: `degraded` is reported, and
   `recovering` is limited to one slot by the filter. Capacity is the
   weight: two boxes in one tier with caps 6 and 2
   fill three to one without anyone configuring a share.
4. **Take a slot.** Commit the choice and its expiry together under the
   state lock. Evaluate capacity and exclusions again against current
   state before taking the slot. Return the slot and decision reasons.

**Weights and affinity are designed here and built in Phase 2, if they are needed.** For one to five machines,
priority plus capacity plus least-loaded already gives "box first until full, then local" and a deterministic,
explainable spread. If real use shows that capacity is the wrong proxy for share (a big box that should still take
only a little of one repo's work), Phase 2 replaces step 3's load ordering with smooth weighted round-robin, the
algorithm swarm's `swrrPick` uses, so there is one mental model: add each eligible machine's effective weight to its
credit, pick the highest credit, deduct the tier's total from the winner, break ties by label. The effective weight
is the configured `weight`, times 1.25 per matched preferred tag (capped at 2), times 1.25 when `--affinity <key>`
matches that repo's most recent placement, times 0.5 when `degraded`. Credits and affinity then persist in state
and expire. Priority still wins across tiers. The config and state examples below show these fields and mark them
Phase 2; adding them later changes no Phase 1 field.

### Capacity and examples

`maxConcurrent` counts active slots per machine across all runs and standalone calls using this installation.
Phase 2 can add a per-repo cap on top of the machine-wide cap. A slot with a required tag in `exclusive` holds the one slot
for that tag on its machine. All affected capacity counters update in the same state transaction. Release on
`done`, or let the slot expire after `slotTtlMinutes`. A batch books up to its requested count, updating capacity
after every selection. With no eligible placement it fails. With a partial batch it returns the booked placements,
shortfall and reasons. The caller only dispatches work it has booked. Slots on this installation cannot see work
started by another Coordinator or outside the router.

| Request | Result |
| --- | --- |
| Box first until six, then local | Give `home-box` priority 10 and six slots. Give `local` priority 0 and four slots. A batch of seven ordinary tasks yields six remote and one local when both machines begin empty. |
| Needs `ios-sim` | Only local provides the tag. The box is filtered even when it has higher priority and spare capacity. A full local machine yields a capacity error. |
| Needs exclusive `gpu` | A first GPU task holds the box's exclusive tag. A second can use another GPU box if eligible, or receives a rejection. CPU work can still use the box's remaining general slots. |

### Override trust

Trusted `repos["github.com/owner/repo"]` config sets defaults for needs and preferences, denies or pins machines
and names the worktree command. Per-repo priorities and caps are Phase 2. Caller preferences are additive. Caller needs
union with required repo tags. Explicit pins, denies and local-only rules combine by intersection. Conflicting hard
rules can leave no eligible machine.

Phase 2 reads `.t3-boxes.json` at the git root identified by walking up from the working directory. It reads it
only when `allowProjectOverride: true` in the user config and no explicit `--config` was given. The repository can
add required tags, make named task kinds local-only, deny boxes and name a worktree script already allow-listed by
the user. It cannot introduce machines, raise weights, priorities or capacity, change access or gain command
execution. The caller follows `AGENTS.md` and `CLAUDE.md` when determining task rules. Apply the stricter answer,
including staying local when repo instructions require it.

Swarm already uses a similar trust boundary. Its `sanitizeOverrideEntry` keeps `provider`, `model`, optional
`bucket` and optional `maxDepth` for known providers, and strips `weight` and model options so a repo cannot inject
expensive settings (S:260–271, S:334–356). An explicit config bypasses the repo file (S:274–284). Existing Leads
pass `--config` to swarm. That flag affects the swarm invocation independently of router config selection.

## 6. Data transport to and from boxes

Use the first rung that satisfies the task. Phase 1 requires the committed Git handoff. Later helpers cover
snapshots and result files. Attachments remain a T3 tool path for small inputs.

1. **Committed work through `origin`.** The caller commits and pushes the
   base. In the remote project checkout the worker fetches `origin`, then
   runs `git worktree add ~/work/<worker-branch> -b <worker-branch> origin/<branch>`
   or uses the trusted repo's `worktreeCommand`. The worker edits only its
   own worktree, commits there and pushes its branch. The caller fetches
   before reviewing or integrating. The router writes the instructions. The
   worker executes them. Give each task its own branch and path, and reuse a
   worktree only when it has the intended branch and is free. A stale or
   dirty shared checkout can remain as it is.
2. **Uncommitted work through a snapshot commit (Phase 2).** Stage the
   intended working tree using `git add -A` with a temporary index, leaving
   the user's index intact. Create a snapshot commit parented on `HEAD`
   when the tree changed. Exclude ignored untracked files. Print the
   included file list, including deletions, before transport. Refuse
   secret-like paths such as `.env*`, `*.pem`, `*.p8`, `*.keystore` and
   `id_rsa*` unless the user explicitly allow-lists a confirmed nonsecret
   file. Include tracked changes in the check because Git can stage them
   even if their names match ignore patterns. Deliver over SSH to a
   temporary ref when SSH is declared, or use a throwaway branch in the
   `box-router/handoff/` namespace on `origin`, pending the user's decision
   on the default. Return the exact base ref and commit. Keep the ref
   until the worker has preserved its work, then clean up at `done`.
   Report failed cleanup and retain provenance for retry.
3. **Small inputs through T3 attachments.** Have the agent call
   `t3_attachment_prepare_upload`, POST the exact bytes to `uploadUrl` or
   the server's `relativeUrl`, then send with
   `t3_thread_send_attachments` using the returned `attachmentId`. Each
   message takes up to eight files. The upload schema has size ceilings
   of 10,485,760 and 52,428,800 bytes in its two branches. Apply the
   applicable branch's limit. `delegate_task` takes text and has no
   attachments argument. Send a patch, screenshot or log as a new
   message to an existing child thread, or use `t3_thread_launch` only
   when the user wants a top-level thread. Sending from here to a thread
   on a different environment is unverified.
4. **Results back through text, Git or SSH.** The worker's final message
   carries text results, and a pushed branch carries code. The audit
   found no T3 file return channel. Phase 2 can pull a specific screenshot,
   log or build output over declared SSH. With no SSH, publish small
   outputs on a throwaway artifacts branch with an enforced size cap and
   cleanup. Large binaries on a machine without SSH are outside this
   design. Use the branch or commit ID in the worker result to prove
   what was returned before removing temporary refs.

**Secrets.** The router handles credential presence as `secret:<name>` tags only. The user provisions the
credential on the machine that needs it. Exclude secret values from config, state, diagnostics, handoff content,
attachments and T3 `task` text. Protect the local directory with mode 700 and its files with mode 600. Require
credential-free URLs. The only transient credential handling proposed is the Phase 2 link-renewal subprocess
handoff. Keep its short-lived pairing token out of output, logs and persistent storage. One exposure remains and
is stated, not hidden: `t3 environment link <url> --pairing-code <code>` takes the code as an argument, so other
processes of the same user can see it in the process list for as long as that command runs. Mint it with the
shortest practical `--ttl` (the surveyed provider uses two minutes). `--from -` reads the code from stdin, but the
surveyed provider notes that it leaves an existing link as it is, so it suits a first link and not a renewal.
Apply link access as a hard placement filter.

## 7. Health, cooldown, failover and ephemeral boxes

### Signals and states

Evaluate health lazily at `place`, `list` or `doctor`. Acquire and registration use the same evidence. Check
signals in this order. A fresh link response with a status other than `reachable` prevents placement. A repeated
read of the same outage does not extend a caller-reported cooldown.

1. Use fresh T3 link `status`, `expiresAt` and a safe summary of
   `lastError`. Try the T3 CLI when available or use the agent's equivalent
   link observation. Treat only the observed literal `reachable` as
   reachable. Use expiry and missing links to identify cases that require
   user action.
2. When a configured HTTPS URL exists, use a bounded GET to diagnose
   readiness. Use it to distinguish an endpoint that answers from a
   working T3 link. A successful GET alone cannot make a box eligible,
   and a failed GET establishes only failed endpoint reachability. A
   fresh reachable T3 link with a failed auxiliary probe is degraded.
   Probe time affects health only as a timeout threshold.
3. Apply caller-reported outcomes. `failed` releases a task slot without
   charging machine health. A machine failure sets cooldown, and a
   successful trial marks recovery. A stale completion cannot clear a
   newer outage.
4. Phase 2 runs bounded user-defined checks against a single tag each.
   A failed GPU check removes `gpu` from the effective tag set until a
   passing observation. CPU work can still qualify. A declared SSH check
   can verify the repo's push path. Outside that check, push access is
   a declaration.

| Router state | Placement behavior |
| --- | --- |
| `ready` | Fresh evidence supports placement, subject to repo, provider, access and slot filters. |
| `degraded` | The link is reachable but the auxiliary HTTPS probe failed. Still eligible. Phase 1 reports it in `list` and in `why` and does not reorder on it. |
| `recovering` | A cooldown has ended and no task has succeeded since. Eligible for one slot at a time until a `done --outcome ok` clears it. |
| `cooling` | Disallow new placements until a recorded `cooldownUntil` passes or a current non-reachable T3 report is superseded, whichever is later. |
| `unlinked` | Missing or expired link. Ask the user to link, or use a configured renewal path in Phase 2. |
| `unknown` | No fresh observation for the fact required to place. Ask for evidence. |

Derive the state on read from the current observations and outage record; when more than one applies, report the
most restrictive (`unlinked`, `cooling`, `unknown`, `recovering`, `degraded`, `ready`). A short-lived probe failure
is distinct from expired link authority.

Observations age at two speeds. Link facts change quickly and are cheap to re-read, so they are fresh for 15
minutes (`linkTtlMinutes`); when the `t3` CLI is present the router refreshes them itself and no agent is involved.
Provider and project facts change rarely and only an agent can read them, so they are fresh for 24 hours
(`factTtlHours`), which covers a run. The Coordinator refreshes them at `acquire` and before every
`register-payload`. A Lead therefore does not normally meet `needsObservation` for providers or projects, which
matters because its brief authorizes `orchestrator_capabilities` and `delegate_task` only. Without the CLI, a
Lead can meet a request for `t3_environment_links`; the policy line authorizes that one read-only call. An expiry
timestamp on a link still applies immediately.

### Cooldown and recovery

Phase 1 uses one fixed cooldown, `cooldownMinutes`, default 30. That is the duration the Lead brief already uses
for swarm's `cooldown env:<label> 30m`, so the two Level 0 stores agree by default. Manual `cooldown` and
`--min-cooldown` can set a longer deadline. A failure never shortens an existing deadline. When the cooldown ends
the machine is `recovering`: at most one slot at a time until a successful outcome clears the failure record.
`clear-cooldown` returns it to normal at once. Expiry alone never overrides fresh evidence that the link cannot be
used. Backoff that grows with repeated failures (5, 15, 60 minutes) is a Phase 2 refinement, worth adding only if
boxes turn out to flap.

On a lost box, the calling agent cancels its lost tasks with `task_cancel` before reporting the outage and
re-placing. When several callers have work there, notify them to cancel and reconcile their work. The router does
not know T3 task IDs or branch progress. `report <label> unreachable` frees every slot on that machine and sets the
cooldown in one transaction. Recover from the latest branch the worker pushed. A branch that was never pushed may
be lost until the box returns. The router does not revive a task or infer idleness from a released slot.

### Link lifecycle and bring-up

Reject a remote link with less than `minLinkHours` remaining. Phase 2 warns when a link has under seven days left
so the user can renew it in advance. The default recovery path is for the agent to call `t3_environment_link` with
a user-supplied hint or address. A `pending` reply means the outcome comes back as a thread message. The agent
continues with available machines and does not wait, poll, or repeat the request to check. Already linked can
return `linked`. The user can revoke access in T3. Lease release is independent of unlinking.

Phase 2 also offers `renew` for a box configured with `renew: "auto"` and an SSH target. Run `t3 pair` on the box
and `t3 environment link <url> --pairing-code <code>` here. The CLI flags are documented and an existing provider
uses them. Re-test renewal of an existing link, keep the user's access policy, and refresh the observed link before
placing. Pass the token transiently to the subprocess within its TTL and suppress command and subprocess output
that could contain it. This path is off by default, since it can mint access unattended.

Phase 1 can invoke an optional user-supplied per-box `bringUp` command during `acquire` when a selected box is
down (the open question in section 11, resolved in favour of Phase 1). The rules:

- **Trigger.** Only when an acquisition falls short and a fresh link read shows the box linked but down: a status
  other than `reachable` that the router recognizes, on a link that is not missing (`value: null`), gone
  (`missing`, `unlinked`, `revoked`, `expired`, `removed`), expired or expiring within `minLinkHours`. An unknown
  or unreadable status, a stale or absent link read, a cooling box, a box with a router slot and an acquisition
  still waiting for observations never start a hook. CLI, hook and `list` share one link verdict, so a box
  `list` calls `unlinked` is never brought up.
- **One claim in state.** Choosing candidates, checking slots, cooldown, a running hook and the retry window, and
  writing the claim (`state.bringUp.<label>`) happen in one state transaction. Concurrent acquires never start a
  second hook, and while the claim stands no `place`, `acquire` or `register-payload` gives a slot or lease on
  that box. The hook itself, its timeout and the link refresh after it run outside the lock.
- **Bounded.** Run only the configured argument vector, unchanged and without a shell, in its own process group,
  with one JSON object on stdin and its output discarded. At `bringUpTimeoutMs` (default two minutes, at most
  ten) the group gets SIGTERM, then SIGKILL five seconds later. A process that leaves the group (`setsid`)
  escapes that stop. The claim has a deadline a little past that bound; the first transaction after it finalizes
  an abandoned claim, so a router that died mid-hook blocks the box for at most that long. A router stopped by
  SIGTERM, SIGINT or SIGHUP kills its running hook groups before it exits; only a SIGKILLed router leaves a hook
  running, and its claim still blocks the box until the deadline.
- **Invalidation before eligibility.** Finishing lifts the claim and, in the same transaction, expires every fact
  about the box observed before the hook finished, including observations an agent handed in while it ran. A
  link refresh that was read before the hook finished is dropped if it arrives later. The router then re-reads
  links and decides again, so the box is leased only on post-hook link, provider and project facts. Exit 75
  (`refused-busy`: the hook's idle check found the box busy) changes nothing, so it expires nothing.
- **No duplicates between retries.** An attempt that finished within `defaults.bringUpRetryMinutes` (default 10)
  is not repeated; the result reports it as `recent`.
- **Idle check.** If the hook can restart T3, it must run the operator's idle check and exit 75 when busy.
  Expiring slots alone cannot authorize a restart; the router's own check only covers work it placed.

Each acquisition that considers a hook carries a `bringUp` array: one entry per considered box with `outcome`
(`up`, `failed`, `timeout`, `refused-busy`, `in-progress`, `recent` or `skipped`) and `detail`, and for a hook
that ran also `exitCode` or `signal`, `timeoutMs`, `startedAt` and `finishedAt`. `list` shows a running claim
(`bringUp.running`, `run`, `deadline`) or the last attempt (`outcome`, `finishedAt`, `retryAfter`).

### Future · Ephemeral boxes (Phase 4 sketch)

This part is a sketch, not a committed interface. Nobody in the stated audience (one to five always-on machines)
needs it today, and the surveyed setup retired its cloud provider on cost. It is here for one reason: to show that
the routing model has a place for short-lived machines (`kind: "ephemeral"`, lowest priority tier, a lease tied to
a run) without any Phase 1 field having to change. Do not build it until someone needs it and the linking question
below has an answer.

The seam is a driver: a user-supplied executable that receives `up`, `status` or `down` as its first argument and
one JSON request on stdin (the configured label, the run ID and, for an existing instance, its `instanceId`), and
prints one JSON object. The skill contains no vendor code.

```json
{
  "ok": true,
  "instanceId": "<instanceId>",
  "url": "https://on-demand-box.example",
  "ssh": "user@on-demand-box",
  "expiresAt": "2030-01-01T15:00:00Z",
  "hourlyCost": 0.35,
  "currency": "USD"
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True when the driver operation succeeded. |
| `instanceId` | Stable driver-specific handle for status and cleanup. |
| `url` | T3 endpoint that the user or an opted-in mechanism can link. |
| `ssh` | Optional SSH target for transport. |
| `expiresAt` | Driver-reported latest time the instance is expected to stay available. |
| `hourlyCost` | Quoted price per hour, also supplied before provisioning. |
| `currency` | Currency of the hourly price. |

Four rules would sit in the router, not in a driver. Once provisioned, the box still needs a reachable T3 link, an
eligible provider and a project observation before any placement; a sandbox instance ID is not a T3 environment
ID. The price is stated and confirmed before each `up`, and overflow never provisions on its own. `down` is refused
while slots are held or a worker's output is not yet pushed. An expired lease leaves a cleanup candidate for the
caller; nothing is torn down in the background.

What is unverified decides whether this is ever built: the surveyed sandbox products expose forwarded ports, but
whether a T3 server inside one can be linked, how long a cold start takes, and how credentials and a repository
get there are all unconfirmed.

## 8. CLI and config

### Directory and command surface

Default to `~/.t3/boxes/`, beside `~/.t3/swarm/`. Allow `T3_BOXES_HOME` to select the router home. The directory
name describes the inventory, which can outlive this CLI. The user or setup writes `config.json`. The CLI alone
writes `state.json`. An optional `drivers/` holds user-owned executables. Install
`skills/t3-box-router/scripts/box-router.mjs` with the skill.

| Command | Phase | Contract |
| --- | --- | --- |
| `help` | 1 | Print command usage in JSON. |
| `init` | 1 | Create a user-confirmed config and empty state, or report an existing setup. |
| `discover` | 1 | Propose inventory rows from link observations. |
| `doctor` | 1 | Validate config and diagnose missing links, provider or project facts, and invalid labels. |
| `list` | 1 | Return inventory, derived health, leases and slots. |
| `observe` | 1 | Read T3 observation records on stdin and update the bounded cache. |
| `place [--count N] [--run <runId>]` | 1 | Select and book placements. Flags are in the table in Section 4. |
| `done --slot <slotId> --outcome <outcome>` | 1 | Release a booking and apply a reported outcome. |
| `report <label> unreachable` | 1 | Record an outage and clear active slots there. Accept `--min-cooldown` for the swarm seam. |
| `cooldown <label> <duration>` | 1 | Set an explicit machine deadline. |
| `clear-cooldown <label>` | 1 | Clear manual or automatic cooldown and reset the failure streak. |
| `acquire --run <runId> [--count N] [--needs a,b]` | 1 | Lease distinct ready boxes. Count defaults to one and must be positive. |
| `release --run <runId>` | 1 | Idempotently drop a run's lease. In Phase 4, also request safe cleanup of its ephemeral boxes. |
| `register-payload --run <runId> [--clear]` | 1 | Emit the raw swarm registration array as the success response. Errors on a lapsed lease unless `--clear`. |
| `policy-line --run <runId>` | 1 | Render the Boundaries instructions for the run ledgers, as `{ "ok": true, "text": "<the lines>" }`. |
| `handoff` | 2 | Create and transfer a snapshot commit. |
| `fetch` | 2 | Fetch a worker branch or recover a snapshot over declared SSH. |
| `pull` | 2 | Return selected artifacts with bounded transport. |
| `renew` | 2 | Renew a link only with trusted opt-in configuration. |
| `check` | 2 | Run configured tag gates and supported SSH push-access checks. |

That is fifteen commands in Phase 1. There is no separate `brief` command: `place` already returns
`briefAddendum`. The Phase 4 sketch would add two commands to provision and tear down a driver instance; they are
not specified here.

Release responds with `ok` and two label arrays, `stopped` and `kept`. Always-on boxes go in `kept`; Phase 1 leaves
`stopped` empty. A second release of the same run succeeds with both arrays empty. `init`, `discover`, `doctor`,
`report`, `cooldown` and `clear-cooldown` use the same `{ "ok": ... }` envelope; their exact fields are left to the
Phase 1 implementation and its `references/`, because nothing outside the router parses them.

Omitting `--count` on `place` returns a single placement as in Section 4. With `--count`, the response has `ok`, a
`placements` array of the per-placement objects without their individual `ok` and without `placement.skipped`
(the batch reports `skipped` once, at the top level), and a `shortfall` if the count was only partly met. A partial
batch is a success, as a partial `acquire` is: `ok` is true and the exit code is 0
whenever at least one placement was booked, and `skipped` says why the rest could not be. With none booked it is
the "No eligible machine" error from Section 4.

```json
{
  "ok": true,
  "placements": [
    {
      "target": { "environmentId": "<environmentId>", "projectId": "<projectId>" },
      "placement": {
        "label": "home-box",
        "remote": true,
        "providers": ["<providerInstanceId>"],
        "slot": { "id": "<slotId-1>", "expiresAt": "2030-01-01T13:00:00Z" },
        "why": "Highest eligible priority tier with a free slot."
      },
      "briefAddendum": "Run on home-box. In its project checkout, run git fetch origin && git worktree add ~/work/<worker-branch> -b <worker-branch> origin/<branch>. Work there, then push your branch to origin."
    },
    {
      "target": {},
      "placement": {
        "label": "local",
        "remote": false,
        "slot": { "id": "<slotId-2>", "expiresAt": "2030-01-01T13:00:00Z" },
        "why": "home-box is full. Local is the next tier with a free slot."
      },
      "briefAddendum": "Run on the caller's machine. Use the caller's local checkout instructions."
    }
  ],
  "shortfall": 1,
  "skipped": [
    { "label": "home-box", "reason": "No free slot (6 of 6 in use)." },
    { "label": "local", "reason": "No free slot (4 of 4 in use)." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True when at least one placement was booked. |
| `placements` | One entry per booked slot, in booking order. Each has the `target`, `placement` and `briefAddendum` of a single result. |
| `shortfall` | Requested count minus booked count. Absent when the whole batch was booked. |
| `skipped` | Why no further placement was possible, per machine. Absent when the whole batch was booked. |

Read or refresh outside the write lock and validate decisions against current state before reserving. Fail without
booking when required observations are missing. Reject invalid counts, conflicting pins and unknown labels before
changing state.

### Config schema

This full example includes optional Phase 2 fields. Phase 1 reports those fields as inactive until the relevant
feature ships. Values such as the expiry thresholds are proposed defaults and can be changed by the user.

```json
{
  "version": 1,
  "scriptPath": "/path/to/skills/t3-box-router/scripts/box-router.mjs",
  "allowProjectOverride": true,
  "defaults": {
    "minLinkHours": 24,
    "linkTtlMinutes": 15,
    "factTtlHours": 24,
    "slotTtlMinutes": 180,
    "leaseTtlHours": 24,
    "cooldownMinutes": 30,
    "affinityTtlMinutes": 120
  },
  "local": {
    "tags": ["macos", "arm64", "ios-sim", "xcode"],
    "deviceHostId": "local",
    "priority": 0,
    "weight": 1,
    "maxConcurrent": 4,
    "exclusive": ["ios-sim"]
  },
  "machines": {
    "home-box": {
      "kind": "always-on",
      "environmentId": "<environmentId>",
      "url": "https://home-box.example",
      "ssh": "user@home-box",
      "tags": ["linux", "gpu", "ram-32g", "godot", "secret:build-signing"],
      "priority": 10,
      "weight": 2,
      "maxConcurrent": 6,
      "exclusive": ["gpu"],
      "worktreeRoot": "~/work",
      "renew": "manual",
      "bringUp": ["/path/to/start-box"],
      "bringUpTimeoutMs": 120000,
      "checks": [{ "tag": "gpu", "command": ["/path/to/check-gpu"], "timeoutMs": 3000 }]
    }
  },
  "repos": {
    "github.com/owner/repo": {
      "needs": ["godot"],
      "prefers": ["ram-32g"],
      "deny": [],
      "pin": "home-box",
      "priority": { "home-box": 10 },
      "maxConcurrent": { "home-box": 3 },
      "worktreeCommand": "./scripts/worktree",
      "allowWorktreeScripts": ["./scripts/worktree"]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Config schema version. |
| `scriptPath` | Installed path callers can hand to another harness or Lead. |
| `allowProjectOverride` | Enables the restricted repo file in Phase 2. Default false. |
| `defaults` | Installation-wide timing defaults. |
| `defaults.minLinkHours` | Minimum remaining link lifetime for remote placement. |
| `defaults.linkTtlMinutes` | Maximum age of a cached link observation. |
| `defaults.factTtlHours` | Maximum age of cached provider and project observations. |
| `defaults.slotTtlMinutes` | Maximum age of a slot. |
| `defaults.leaseTtlHours` | Time since last run lease renewal before expiry. |
| `defaults.cooldownMinutes` | Cooldown after a machine failure. Matches the 30 minutes the Lead brief uses for swarm. |
| `defaults.affinityTtlMinutes` | Phase 2. Maximum age of a preferred previous placement. |
| `defaults.bringUpTimeoutMs` | Optional default hook timeout for machines that set none. |
| `defaults.bringUpRetryMinutes` | Optional. A bring-up attempt is not repeated within this many minutes. Default 10. |
| `local` | Caller machine policy. |
| `machines` | Remote inventory keyed by globally unique label. |
| `machines.<label>.kind` | Always-on in Phase 1. Driver-backed ephemeral in Phase 4. |
| `machines.<label>.environmentId` | Stable T3 environment ID for an always-on box. |
| `machines.<label>.url` | Optional approved HTTPS endpoint for probes and renewal. |
| `machines.<label>.ssh` | Optional host target used by explicit Phase 2 helpers. |
| `tags` | Declared capabilities for a local or remote entry. |
| `deviceHostId` | Optional T3 device-host mapping, separate from the link. |
| `priority` | Strict priority tier for a machine. |
| `weight` | Phase 2. Positive share within its priority tier. Phase 1 ignores it and orders by load. |
| `maxConcurrent` | Positive total slot cap per machine. |
| `exclusive` | Tags with one slot per machine. |
| `machines.<label>.worktreeRoot` | Parent for worker-managed checkout paths. Defaults to `~/work`. |
| `machines.<label>.renew` | Phase 2 link renewal policy, `manual` by default or `auto` with SSH. |
| `machines.<label>.bringUp` | Optional user-owned bring-up argument vector run at `acquire` (section 7). A non-empty array of strings whose first element is an absolute path; passed unchanged, without a shell. |
| `machines.<label>.bringUpTimeoutMs` | Hook timeout, 1000 to 600000 ms. Default `defaults.bringUpTimeoutMs`, else 120000. |
| `machines.<label>.checks` | Phase 2 tag-gating checks. |
| `checks[].tag` | Capability gated by the command. |
| `checks[].command` | User-owned command and arguments. |
| `checks[].timeoutMs` | Required bound on probe runtime. |
| `repos` | Trusted per-origin rules keyed by canonical repo key. |
| `repos.<key>.needs` | Required tags added to every request for this repo. |
| `repos.<key>.prefers` | Default soft preferences. |
| `repos.<key>.deny` | Machine labels this repo may never use. |
| `repos.<key>.pin` | Optional trusted machine constraint. |
| `repos.<key>.priority` | Phase 2. Priority overrides for this repo, keyed by machine. |
| `repos.<key>.maxConcurrent` | Phase 2. Additional cap for this repo's placements, keyed by machine. |
| `repos.<key>.worktreeCommand` | Trusted worktree script to name in the worker's brief. |
| `repos.<key>.allowWorktreeScripts` | Explicitly accepted repo script names for Phase 2 overrides. |

A root `.t3-boxes.json` contains only the following permitted fields. This narrowing example is independent of the
pinned user config above.

```json
{
  "needs": ["godot"],
  "localOnlyKinds": ["ios-verification"],
  "deny": ["home-box"],
  "worktreeScript": "./scripts/worktree"
}
```

| Field | Meaning |
| --- | --- |
| `needs` | Adds required tags to the caller's needs. |
| `localOnlyKinds` | Task kinds for which `--kind` must resolve to local placement. |
| `deny` | Labels removed from the eligible pool. |
| `worktreeScript` | Path accepted only when the trusted repo entry allow-lists it. |

### State schema

The CLI prunes expired observations, slots, leases and affinity as it evaluates requests. It keeps expiry and
cooldown separate so a stale observation cannot overwrite an outage report. Use the file-lock and
atomic-replacement pattern in swarm (S:104–157). Keep network and T3 work outside the lock. Under the lock, reload
state, purge expired bookings, decide, and write the next state. On lock or write failure, return an error instead
of reporting a reservation. A state file that does not parse is moved aside: under the lock, rename it to
`state.json.corrupt.<ms>` and answer `ok: false` once with that path. The next command finds no state file and
starts from empty state. This goes one step further than swarm, which copies a corrupt `health.json` to a backup
and returns the error but leaves the bad file in place (S:173–186); the router recovers by itself because empty
state loses only slots and cooldowns, which are advisory and expire. Config is untouched.

```json
{
  "version": 1,
  "observations": {
    "home-box": {
      "environmentId": "<environmentId>",
      "link": {
        "source": "t3-cli", "observedAt": "2030-01-01T09:55:00Z", "validUntil": "2030-01-01T10:10:00Z",
        "value": { "status": "reachable", "access": "full-access", "expiresAt": "2030-02-01T00:00:00Z", "lastError": null }
      },
      "providers": {
        "source": "agent", "observedAt": "2030-01-01T09:55:00Z", "validUntil": "2030-01-02T09:55:00Z",
        "value": ["<providerInstanceId>"]
      },
      "projects": {
        "source": "agent", "observedAt": "2030-01-01T09:55:00Z", "validUntil": "2030-01-02T09:55:00Z",
        "value": { "github.com/owner/repo": "<projectId>" }
      }
    }
  },
  "health": {
    "home-box": { "failures": 0, "cooldownUntil": null, "lastFailureAt": null }
  },
  "leases": {
    "<runId>": { "machines": ["home-box"], "expiresAt": "2030-01-02T10:00:00Z" }
  },
  "slots": {
    "<slotId>": {
      "label": "home-box",
      "run": "<runId>",
      "repo": "github.com/owner/repo",
      "exclusive": ["gpu"],
      "placedAt": "2030-01-01T10:00:00Z",
      "expiresAt": "2030-01-01T13:00:00Z"
    }
  },
  "bringUp": {
    "home-box": {
      "id": "<claimId>", "run": "<runId>", "startedAt": "2030-01-01T09:50:00Z", "deadline": "2030-01-01T09:52:17Z",
      "finishedAt": "2030-01-01T09:50:40Z", "outcome": "up", "invalidatedAt": "2030-01-01T09:50:40Z"
    }
  },
  "credits": { "home-box": 0 },
  "affinity": {
    "github.com/owner/repo": {
      "<affinityKey>": { "label": "home-box", "expiresAt": "2030-01-01T12:00:00Z" }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | State schema version. |
| `observations` | Normalized T3 observations keyed by machine label. Clear affected facts when its configured environment ID changes. |
| `observations.<label>.environmentId` | Link identity at the time of the observation. Omit for local. |
| `observations.<label>.link` | Freshness envelope and reduced link facts. |
| `observations.<label>.providers` | Freshness envelope and eligible provider IDs. |
| `observations.<label>.projects` | Freshness envelope and canonical repo-to-project map. |
| `source` | Observation source: `agent` (handed in through `observe`) or `t3-cli` (read by the router). |
| `observedAt` | UTC time the CLI accepted the observation. |
| `validUntil` | Router TTL deadline for that observation. |
| `value` | Reduced payload for that observation kind. |
| `link.value.status` | Link status as supplied by T3. |
| `link.value.access` | Permission level supplied by T3. |
| `link.value.expiresAt` | Link's own expiry, independent of freshness. |
| `link.value.lastError` | Sanitized T3 error summary, or null. |
| `health` | Machine-local failure records keyed by label. |
| `health.<label>.failures` | Failures since the last success. Nonzero after the cooldown has ended means `recovering`. |
| `health.<label>.cooldownUntil` | Hard cooldown deadline or null. |
| `health.<label>.lastFailureAt` | Outage timestamp used to ignore obsolete success reports. |
| `leases` | Run leases keyed by run ID. |
| `leases.<runId>.machines` | Remote labels held by that run. |
| `leases.<runId>.expiresAt` | Lease deadline after the most recent renewal. |
| `slots` | Active bookings keyed by opaque slot ID. The one-slot limit of a `recovering` machine is counted from these. |
| `slots.<slotId>.label` | Machine holding the booking. |
| `slots.<slotId>.run` | Run ID or null for standalone use. |
| `slots.<slotId>.repo` | Canonical repository key, or null for local work outside a repo. |
| `slots.<slotId>.exclusive` | Exclusive tags held by this slot. |
| `slots.<slotId>.placedAt` | Booking time used to order outcomes against outages. |
| `slots.<slotId>.expiresAt` | Independent stale-slot deadline. |
| `bringUp` | Bring-up hook claims and last attempts keyed by label. Absent until a hook runs. |
| `bringUp.<label>.id`, `run`, `startedAt`, `deadline` | The claim. While it is unfinished and before `deadline`, the box gets no slot or lease. The owning `pid` is kept only while it runs. |
| `bringUp.<label>.finishedAt`, `outcome` | The last attempt. Another is not started before `finishedAt` plus `bringUpRetryMinutes`; the record is pruned after that. |
| `bringUp.<label>.invalidatedAt` | Facts about the box observed before this time were expired and are never merged again. Absent after `refused-busy`. |
| `credits` | Phase 2. Smooth weighted round-robin credits by label. Absent in Phase 1. |
| `affinity` | Phase 2. Most recent placement by repo and caller-supplied `--affinity` key. Absent in Phase 1. |
| `affinity.<repo>.<key>.label` | Preferred candidate if still eligible. |
| `affinity.<repo>.<key>.expiresAt` | Affinity expiry. |

### Additional response examples

A complete acquisition returns a list of distinct leased boxes. A partial acquisition returns the same shape plus
`shortfall`. Both are successful when at least one box is leased. With zero, add `error` and set `ok` to false. For
stale facts that could change the result, `needsObservation` gives the calls to try before retrying.

```json
{
  "ok": true,
  "machines": [{ "label": "home-box", "environmentId": "<environmentId>" }],
  "errors": []
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True when the caller can use at least one leased box. |
| `machines` | Boxes leased to the supplied run. |
| `machines[].label` | Inventory label. |
| `machines[].environmentId` | T3 link ID. |
| `errors` | Availability diagnostics for missing boxes, empty here. |

```json
{
  "ok": true,
  "machines": [{ "label": "home-box", "environmentId": "<environmentId>" }],
  "errors": ["Only one ready box matches the requested tags."],
  "shortfall": 1
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True for a usable partial result. |
| `machines` | Leased subset of the request. |
| `machines[].label` | Inventory label. |
| `machines[].environmentId` | T3 link ID. |
| `errors` | Reasons the request was only partly met. |
| `shortfall` | Requested count minus leased count. |

Reacquiring prefers boxes the run already holds, then unheld eligible boxes, then other eligible shared boxes. Keep
current eligible leases and add only the extra boxes needed. Apply the configured priority and label order among
otherwise equivalent candidates. When fewer are currently usable, return a partial result. Registration filters the
lease to current usable boxes and requires fresh provider and project observations. If they are stale for an
otherwise eligible leased box, request a refresh before replacing the swarm snapshot. Emit a full replacement
payload with observed provider lists. The router always sends `providers` since omitting it would let swarm assume
any provider can run there. An expired or released lease is an error (`ok: false`, nonzero exit), never an empty
array: swarm deletes the run's box list when it is given `[]` (S:1899), so a Coordinator that re-registered mid-run
after its lease lapsed would strip every box from the run without any error. Renew with `acquire` first. To clear
swarm's registration on purpose, pass `--clear`, which prints `[]`.

```json
[
  {
    "label": "home-box",
    "environmentId": "<environmentId>",
    "providers": ["<providerInstanceId>"],
    "projects": { "github.com/owner/repo": "<projectId>" }
  }
]
```

| Field | Meaning |
| --- | --- |
| Array | Exact stdin format for `swarm.mjs boxes register`. |
| `[].label` | Machine label used by `--place`. |
| `[].environmentId` | Remote T3 environment identity. |
| `[].providers` | IDs of observed eligible providers. |
| `[].projects` | Observed canonical repo key to T3 project ID map. |

```json
{
  "ok": true,
  "machines": [
    {
      "label": "home-box",
      "environmentId": "<environmentId>",
      "state": "ready",
      "heldBy": ["<runId>"],
      "tags": ["linux", "gpu"],
      "priority": 10,
      "maxConcurrent": 6,
      "activeSlots": 1
    },
    {
      "label": "local",
      "state": "ready",
      "heldBy": [],
      "tags": ["macos", "ios-sim"],
      "priority": 0,
      "maxConcurrent": 4,
      "activeSlots": 0
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `ok` | True when the inventory can be displayed. |
| `machines` | Local and every configured machine, including boxes with health issues. |
| `machines[].label` | Globally unique label. |
| `machines[].environmentId` | T3 ID when present. |
| `machines[].state` | Derived machine health. |
| `machines[].heldBy` | Run IDs with unexpired leases. |
| `machines[].tags` | Effective capability set. |
| `machines[].priority` | Default priority tier. |
| `machines[].maxConcurrent` | Machine-wide maximum slots. |
| `machines[].activeSlots` | Number of unexpired bookings. |

### Setup and discovery

Use one skill. A short inventory can be discovered mechanically and confirmed in one pass. Swarm's separate setup
skill exists because quota buckets, model tiers and depth mappings require a longer interview. Keep the router's
setup procedure in `references/setup.md`, loaded on demand by either a standalone agent or a Coordinator.

1. Run `discover` to propose rows. It reads `t3 environment list --json`
   itself when it finds the `t3` binary; otherwise it takes a
   `t3_environment_links` record on stdin, in the `observe` format. Confirm
   labels, expected capabilities, SSH and access requirements, priority and
   capacity. Ask the user to resolve collisions and unknown mappings.
   `doctor` later warns when a label no longer matches T3's link label,
   because the swarm viewer shows T3's.
2. Write config with `init` after the user confirms the inventory. Discover
   providers and projects through the agent, not the T3 filesystem. A
   missing project can be cloned with `t3_project_clone` and registered
   with `t3_project_create` by an authorized agent.
3. Run `doctor` and your first real placement. Resolve observations or
   try a local route. Return any unused test slot with `done`.

## 9. Packaging in mochahub/skills

```text
skills/t3-box-router/
  SKILL.md
  scripts/box-router.mjs
  references/
    config.example.json
    setup.md
    swarm.md
    transport.md
    drivers.md
docs/t3-box-router/
  README.md
  SPEC.md
```

Use only `name` and `description` in the skill frontmatter. The description covers both “run this on another
machine” and “swarm asked for the user's box skill.” Leads and workers can read the skill. Put the worker boundary
in the body. A worker has already been placed, so it executes the handoff and returns its result. Routing and
delegation stay with the caller.

Keep the skill lean and put the longer guide and evidence in `docs/`. Add one row with a Docs link in the root
README. Follow the existing install form.

```text
npx skills@latest add mochahub/skills --skill t3-box-router -g -a <agent> [--copy]
```

Use `node --test` without dependencies. Keep the placement decision function pure and test it with explicit inputs
for time, health, policy and capacity. Test locking and atomic writes separately. Existing project-specific box
skills can retain setup facts and trusted scripts. Move their policy prose into `repos` and their
bring-up script into the box's optional `bringUp` hook.

## 10. Tradeoffs and alternatives rejected

| Alternative | Why the proposal chooses a different approach |
| --- | --- |
| Fold routing into swarm | A standalone agent needs the same policy. Keeping routing behind its own CLI preserves swarm's quota and ledger responsibilities. |
| Send weights through registration | A registration snapshot would need schema changes and still lack live slots. It would leave machine health in two places. |
| Read swarm's private health file | A reader would depend on swarm's format and locking. Explicit events let the two owners evolve their stores independently. |
| Run a monitoring daemon | On-demand reads cover agent tasks that last minutes. A daemon adds install, supervision and stale-process recovery for a small inventory. |
| Wrap the router in an MCP server | The script already runs from every harness with Node. MCP packaging adds installation and still needs access to the caller's T3 context. |
| Rank by latency or live load | An HTTPS timeout is a useful health threshold. Milliseconds of latency say little about a minutes-long task, and load changes during a run. Declared capacity is more predictable. |
| Weighted round-robin, preference multipliers and affinity in Phase 1 | Priority, capacity and least-loaded give the same result for a handful of machines with no stored credits to explain or debug. The weighted design is kept in Section 5 and deferred until capacity proves the wrong proxy for share. |
| Backoff that grows with each failure in Phase 1 | One fixed cooldown equal to swarm's keeps the two Level 0 stores in step. Growing backoff is a Phase 2 refinement. |
| Rank by token cost | Swarm owns model and quota decisions. Machine spend belongs to the ephemeral provisioning guard. |
| Ship built-in cloud vendors | Linking in a sandbox is unverified and cost can dominate. A driver protocol keeps those dependencies and credentials with the user. |
| Read T3's private project database | Internal tables can change across T3 versions. The project tool provides the supported join key. |
| Put tags in swarm pick specs | Swarm removed that syntax. A separate `--needs` flag leaves `tier[:depth]` for model selection. |
| Ship a separate setup skill | Inventory discovery and confirmation fit in one reference and three commands. |
| Use SSH or rsync as the primary transport | Git is the common path and supplies provenance and reproducible bases. SSH is useful when the box declares it. |
| Use real locks for capacity | The router cannot control outside tasks. Advisory slots with expiry recover after caller crashes and count only what the router places. |
| Renew every link unattended | Pairing mints access. Per-box opt-in keeps that decision with the owner. |
| Route Leads to boxes | Lead routing would split the Coordinator's single quota and health context. Only worker placement crosses machines. |

## 11. Open questions for the user

| Question | Recommendation |
| --- | --- |
| Use `~/.t3/boxes/` or `~/.t3/box-router/`? | Use `~/.t3/boxes/` because it names the inventory. |
| Approve Level 1 changes to swarm in principle? | Yes, after real runs exercise Level 0. |
| Permit an `origin` branch for uncommitted snapshots? | Default to SSH when declared. Otherwise use an explicit throwaway branch if the user accepts publishing the snapshot to the Git remote. |
| Allow unattended renewal as an opt-in? | Yes. Validate existing-link renewal, token handling and preservation of the user's access level before enabling it. |
| Does `t3_thread_launch` honor a worktree strategy on a linked environment? | Run one disposable test in a separate top-level-thread task. Keep manual Git worktrees for child dispatch. |
| Can an attachment uploaded here reach a thread on a different environment? | Run one test with a small synthetic file. Treat the route as unverified until it passes. |
| Pick an ephemeral vendor now? | Defer until a user needs one. First test reachability and T3 linking with a disposable instance. |
| Confirm: at Level 0, box capacity adds to the local wave allowance, and the policy line overrides the Lead brief's single cap, unpinned picks and `--place box` gates. | Section 3 decides this. The alternative that leaves the brief untouched is one `pick-worker` per booked box slot (single picks have no cap), at the cost of one call per worker. |
| Move the `bringUp` hook from Phase 2 into Phase 1? | Resolved: yes, in Phase 1. One argument vector and one timeout, run only at `acquire`, under the rules in section 7. |
| Build weights, preference multipliers and affinity at all? | Not until Phase 1 has run. Capacity-proportional fill may be all that is needed. |
| Document the T3 v0.1.x CLI? | Yes. Feature-detect the observed commands and keep agent observations as a fallback. |
| What should a shell-only caller use to start a task? | Keep `t3 thread start` exploratory until a separate design verifies remote targeting and outcome handling. |
| Confirm: on a cold cache, `acquire` asks for provider and project facts before it leases. | Section 3 decides this, so a lease is only ever handed out for a box known to be usable. The surveyed provider does it the other way round: it checks the link, leases, and lets the consumer read providers and projects afterwards. |
| Confirm: `register-payload` prints a bare array on success, the one exception to "every command prints one object". | Section 3 decides this. Swarm reads an array on stdin, and an envelope would need an extraction step between the two commands. |
| How should long tasks and multiple Coordinators share capacity? | Start with configurable slot expiry and one router home per Coordinator. Confirm typical run lengths in P1. Revisit refresh or shared accounting if that deployment model changes. |

## 12. Phased implementation plan

| Phase | Scope and deliverables | Exit test | Rough size |
| --- | --- | --- | --- |
| P0 · Scope | This spec and owner decisions on open questions. | Owner agrees on ownership, Phase 1 boundary and disposition of the open questions. | One design document and review. |
| P1 · Always-on MVP | Installable skill, the fifteen Phase 1 commands and schemas, pure decision logic (filter, priority, load), slots and leases, T3 observations and probes, fixed cooldown, Level 0 adapter with the generated policy line, brief generation, tests, guide and README row. No swarm code change. The `bringUp` hook at `acquire` (section 7; moved here from P2 by the section 11 decision). Not included: link renewal. | Replace the acquire, release and placement policy of a hand-built provider in one real swarm run and complete a standalone place, delegate, done sequence. Exercise partial acquisition, simultaneous Leads, remote overflow and outage recovery. | Large single change, about 1,200–2,000 code and test lines plus docs. |
| P2 · Transport and recovery | Snapshot and artifact helpers, tag checks, link warnings and opt-in renewal, repo override file, `--kind` and `--read-only`, per-repo priority and caps. Only if Phase 1 shows the need: weights, preference multipliers, affinity and growing backoff. | Round-trip a snapshot without changing the user's index, return a small artifact, gate a failed GPU tag, and renew an opted-in link without persisting a credential. Exercise a repo override that attempts to widen access. | Medium to large, about 800–1,500 code and test lines. |
| P3 · Level 1 | Separate swarm change with pre-lock placement, machine cooldown forwarding, reasons in pick output and viewer, tests and docs. | Repeat the Level 0 workload with direct integration. Verify fallback and explicit-pin failures, compatibility without a router, wave rollback and absence of router calls inside the lock. | Medium, about 500–900 code and test lines across both skills. |
| P4 · Ephemeral (not scheduled) | Only if a user needs short-lived machines. Driver protocol and one reference driver, price confirmation, run-scoped lifecycle and teardown checks. | Exercise quote, over-budget refusal, link, place and release against a test driver. Confirm one real sandbox can link before claiming sandbox compatibility. Confirm teardown refuses while output is unpreserved. | Medium experimental work, about 500–1,000 code and test lines, plus deployment exploration. |

## Appendix A. Swarm evidence

`S` denotes `skills/t3-swarm/scripts/swarm.mjs`. References are to the audited implementation.

| Evidence | Reference |
| --- | --- |
| Config path and explicit config bypass, known-provider narrowing and ignored box keys | S:24–34, S:246–284, S:334–356, S:846–850 |
| Atomic files, health lock and expiry | S:104–157, S:161–234 |
| Quota hook arguments and fail-open precedent | S:61–87, S:1020–1022 |
| Model selection and pin feedback before environment selection | S:990–1103, especially S:1025–1032, S:1074 and S:1096 |
| Canonical origin, run lookup, lease read and registration allow-list | S:1264–1365, S:1875–1914 |
| Machine cooldown, unit weights, target fields and model-spec grammar | S:1374–1436, S:1444 onward |
| Cooldown and clear, archive and release instructions | S:1536–1647, S:1793–1848 |
| Per-stream allowances and picks, Leads remain local | S:2093–2095, S:2269, S:2316–2400 |
| Box contract, repo instructions and remote Git handoff | Swarm `SKILL.md` lines 146–165 and `lead-brief.md` lines 21, 25 and 30. `worker-brief.md` line 11 covers worktree isolation and pushed results. |
| No box config in swarm setup, repo requirements and public packaging | Setup `SKILL.md` line 51, docs README lines 152–158 and 289, root README lines 10, 17 and 29–39. |
| Viewer labels | `swarm-viz.mjs` lines 123–127, 164–167 and 279–283. The T3 database provides display data only. |

## Appendix B. T3 primitive evidence

“Observed” means the findings recorded a response or CLI behavior. “Documented” means the tool schema or CLI help
was checked. The rows identify behavior still awaiting a focused test.

| Primitive | Use and evidence |
| --- | --- |
| `t3_environment_links` | Agent fallback for link facts. Response fields and `reachable` observed. Other status values were unobserved. |
| `orchestrator_capabilities` | Read runnable provider IDs using `providers[].providerInstanceId` and `canRunChildTask`. Shape observed locally. Remote `environmentId` is documented and used by the existing swarm procedure. The reply also has `canRunCrossProviderChildTask` per provider; the router does not keep it, and whether it limits a caller on one provider from starting a child on another provider on a box is untested. |
| `t3_project_list` | Join `repositoryIdentity.canonicalKey` to project `id` per environment. Shape and pagination fields observed. Follow `nextCursor`. |
| `device_list` | Suggest tags for separately mapped device hosts. Local response observed. |
| `delegate_task` | Agent dispatch, documented text input and placement target. Linked-machine refusal of worktree isolation comes from swarm docs and was not rerun in the audit. |
| `task_cancel` | Agent cancels a lost task with its task ID. Schema documented. |
| `task_status` | Documented lookup by task ID, for caller checks where the harness permits. Router never polls it. |
| `t3_environment_link` | Agent requests user approval. Card behavior and `pending`/already-`linked` outcomes documented. |
| `t3_project_clone` / `t3_project_create` | Authorized agent may provision a missing project. Clone and register sequence documented by clone schema. Create schema was unavailable. |
| `t3_attachment_prepare_upload` | Prepare a small input file, then POST bytes. Upload branches and fields documented. |
| `t3_thread_send_attachments` | Send uploaded files into a thread. Size-of-list limit documented. Cross-environment delivery is unverified. |
| `t3_thread_launch` | Top-level thread with attachments or a workspace strategy when requested. Schema documented. Linked-environment worktree strategy is unverified. |
| `t3 environment list --json` | Read link facts in CLI-only discovery. Observed in v0.1.13. |
| `t3 pair` | Mint a pairing token on an opted-in box in Phase 2. Flags documented. Existing provider uses it with SSH. |
| `t3 environment link <url> --pairing-code <code>` | Present a pairing token to the local T3 CLI in Phase 2. Flag documented. Existing provider reports renewal with this flag. Re-test under the router's access policy. |
| `t3 thread start` | Open question for shell-only dispatch. Command exists in v0.1.13. Remote dispatch and outcome handling through it are unverified. |

The audited T3 CLI has no `t3 project list`. Use the agent's project tool even when link discovery can run entirely
through the CLI.

## Appendix C. Existing swarm doc/code mismatches

1. `references/lead-brief.md` line 25 says `placement.skipped` can tell the
   caller to pass `--run`. That text occurs only as an error when the caller
   pinned a box (S:1100, S:1398). Without a pin, an unresolved run leaves
   `envs:[]` and the pick runs locally without a placement field.
2. Swarm `SKILL.md` line 159 says a usable box is reachable in T3, has the
   project with push access to `origin`, and has the providers signed in,
   then says `placement.skipped` identifies the missing condition.
   `envMisfit` checks provider, project and cooldown. It never probes link
   reachability or push access (S:1382–1388).
