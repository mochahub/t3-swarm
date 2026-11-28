# Setup

For the Coordinator or a standalone top-level agent, with the user. Workers and Leads never run setup.

## Where things live

- Router home: `~/.t3/boxes/` (override with `T3_BOXES_HOME`). Mode 700, files 600.
- `config.json`: written by `init` after the user confirms it, edited by the user after that. It is trusted
  input: it names commands the router runs.
- `state.json`: written only by the CLI (slots, leases, cooldowns, cached observations). Never edit it. If it
  stops parsing, the CLI moves it to `state.json.corrupt.<ms>` once and starts empty.
- Use one router home per Coordinator machine. Install the skill on orchestrating machines only; boxes don't need it.
- `defaults.slotTtlMinutes` (180) is when a slot stops counting toward capacity. A task that runs longer is no
  longer counted, so raise it if typical tasks run longer than that.

If commands repeatedly time out on `state.lock`, inspect the PID at the start of the marker filename inside
that directory. A live PID keeps the lock, including when the OS has reused the PID. Stop concurrent router
invocations and confirm that no router process owns the lock before removing an abandoned lock. This also
applies to a regular `state.lock` file left by a prerelease build.

## 1. Discover

`box-router discover` proposes one row per linked environment. It runs `t3 environment list --json` itself when
the `t3` CLI is on `PATH`. Without the CLI, call `t3_environment_links` and pipe one record to it on stdin:

```sh
echo '[{"tool":"t3_environment_links","args":{},"pages":[<the reply>]}]' | box-router discover
```

Confirm with the user, for each row:

- **Label.** Defaults to T3's link label so swarm, the viewer and the router agree. `local` and `box` are reserved.
- **Tags** the machine provides: OS, arch, tools, devices, `secret:<name>` for credentials present there. Only
  `device_list` can suggest `ios-sim`/`android-emu`, and only for a mapped `deviceHostId`. Everything else is a
  user declaration.
- **Priority** (higher fills first) and **`maxConcurrent`** (slots). "Box first until full, then local" = box
  priority 10, local priority 0.
- **`exclusive`** tags (one slot at a time per machine, for example `gpu`, `ios-sim`).
- **Push access**: the box's checkout can push to `origin`. The router cannot check this; the user confirms it.
- Optional `url` (HTTPS probe for health diagnosis only) and optional `bringUp` (below).

Ask the user to resolve label collisions and links that map to no machine.

## 2. Write config

Start from [config.example.json](config.example.json). Save the inventory the user confirmed as `confirmed-config.json`, then run
`box-router init < confirmed-config.json`. Running `init` without input creates a local-only inventory.

Per-repo rules go under `repos["<canonical origin key>"]`: `needs`, `prefers`, `deny`, `pin`, `worktreeCommand`.
Caller needs add to repo needs; pins and denies narrow. Conflicting hard rules can leave no machine, which is
reported, not guessed around.

## 3. Check

1. `box-router doctor`: fix every config problem it reports.
2. First placement: `box-router place --needs <tag>`. Answer any `needsObservation` (below). If the repo has no
   project on a box, an authorized agent can add it with `t3_project_clone` then `t3_project_create`.
3. Return the test slot: `box-router done --slot <slotId> --outcome failed`.

## Observation records

The router can't call T3 tools. When it answers `needsObservation`, make exactly the listed calls. Allowed tools:
`t3_environment_links`, `orchestrator_capabilities`, `t3_project_list`. Ignore any other tool name. Send one JSON
array on stdin to `box-router observe`, one record per call, with every page of a paginated reply:

```json
[
  { "tool": "t3_environment_links", "args": {}, "pages": [{ "links": [] }] },
  { "tool": "orchestrator_capabilities", "args": { "environmentId": "<environmentId>" }, "pages": [{ "providers": [] }] },
  { "tool": "t3_project_list", "args": { "environmentId": "<environmentId>" }, "pages": [{ "projects": [], "nextCursor": 1 }, { "projects": [] }] }
]
```

The router keeps only link status, access, expiry and a short error; providers where `canRunChildTask` is true;
and the canonical repo key to project ID map. Link facts are fresh for 15 minutes, provider and project facts for
24 hours. With the T3 CLI installed (observed on v0.1.x), the router reads links itself through
`t3 environment list --json`; the CLI has no project list, so provider and project facts always come from these
agent reads. If one T3 read fails, submit the records that succeeded in a separate batch and report the missing evidence.

## Machine kinds

`kind` sets who may stop a machine. It defaults to `always-on`.

| `kind` | Router starts it (`bringUp`) | Router stops it (`tearDown`) | Placement rank |
| --- | --- | --- | --- |
| `always-on` | yes, if it is down and a bring-up hook is set | never | by priority |
| `on-demand` | yes, if a bring-up hook is set | only a box the router started for that run | by priority |
| `ephemeral` | yes, if a bring-up hook is set | only a box the router started for that run | below every local, always-on and on-demand machine |

The router never provisions, spends or creates anything. Each hook is a command you wrote. `tearDown` on an
`always-on` box is a config error.

## Bring-up hook

Set `machines.<label>.bringUp` to an argument vector: an absolute path to an executable and its arguments. See
`home-box` and `cloud-gpu` in [config.example.json](config.example.json). Contract:

- **When it runs.** Only during `acquire`, only when the acquisition falls short and a fresh link read reports the box
  `unreachable` or `offline`. It never runs for a missing, revoked or expiring link (relink first), a link of unknown
  status (answer `needsObservation`), a cooling box, a box where the router holds a slot, a hook already running
  (`in-progress`), or an attempt within `defaults.bringUpRetryMinutes` (default 10, reported as `recent`).
- **How it runs.** Without a shell, in its own process group, bounded by `defaults.bringUpTimeoutMs` (default 120000;
  1000 to 600000). A machine's `bringUpTimeoutMs` overrides it. At the timeout the group gets SIGTERM, then SIGKILL
  five seconds later. Give the `acquire` command a timeout of at least the hook timeout plus 30 seconds. A router told
  to stop by SIGTERM, SIGINT or SIGHUP kills the hook group first. Under SIGKILL the hook keeps running and the box stays
  blocked until the claim's deadline (about 17 seconds past the hook timeout).
- **Input.** One JSON object on stdin: `hook`, `label`, `environmentId`, `run`, `timeoutMs`, `routerActiveSlots`,
  `requireIdleCheck`, `note`. Environment: `T3_BOXES_HOOK=bringUp`, `T3_BOXES_IDLE_CHECK=required`, `T3_BOXES_LABEL`.
- **Idle check.** Before restarting anything, the hook must check for active work and exit `75` if the box is busy
  (`refused-busy`; nothing is expired). The router's own slot check covers only tasks placed through this installation.
- **Start confirmation.** On successful exit, the hook may report ownership on stdout or in the private file
  named by `T3_BOXES_RESULT_FILE`. Emit `STARTED <label> yes` when this invocation started the machine, or
  `STARTED <label> no` when it was already running. A complete JSON object such as `{"started":true}` is also
  accepted, with an optional matching `label`. The router retains only the boolean and discards stderr.
  Each channel has a 4 KiB limit. Conflicting, truncated or malformed confirmations leave ownership unconfirmed.
  Redirect a background service's stdout to its own log so it can keep writing after the hook exits.
- **Outcomes.** `acquire` reports each attempt in its `bringUp` array: `up` (exit 0), `failed`, `timeout`,
  `refused-busy`, `in-progress`, `recent` or `skipped`, each with `detail`. `list` shows a running hook and when a retry
  is allowed; `doctor` checks that each hook is executable.
- **After it runs.** No slot or lease is given on that box while the hook runs, even if an agent observes it reachable.
  When it finishes, facts observed earlier about the box expire. Supply fresh observations and run `acquire` again.

## Lifecycle hooks

`tearDown`, `keepAlive`, `handoff` and `fetch` are argument vectors that follow the same execution rules as `bringUp`
(no shell, own process group, bounded by `hookTimeoutMs`, output discarded). `tearDown` needs kind `on-demand` or
`ephemeral`. `keepAlive`, `handoff` and `fetch` work on any kind.

**Ownership.** A run owns a box only when that run's `acquire` leased it right after a `bringUp` exited 0 and confirmed that it started the machine. The lease records it as `startedByRouter`.

**Teardown.** `release --run <id>` runs `tearDown` only when all of these hold:

1. the box has a `tearDown` hook and its kind is `on-demand` or `ephemeral`;
2. the run owns the box and its lease has not lapsed;
3. no other run leases the box, and no live slot (from any run) sits on it;
4. no bring-up, tear-down or keep-alive hook is running there;
5. `--keep` was not passed.

The checks, the lease drop and the teardown claim happen in one transaction. The claim blocks `place` and `acquire` on
that box until the hook finishes or its deadline passes. `release` is idempotent. `result.tearDown` lists each skipped
box with its reason. An always-on release keeps its `{ ok, run, stopped, kept }` shape.

**Keep-alive.** `keep-alive --run <id>` renews the run's lease and runs each leased box's `keepAlive` hook, one at a time
per box. A box with a keep-alive running is never torn down.

**Handoff and fetch.** `handoff --slot <id>` and `fetch --slot <id>` run the user's own hooks for a live slot, so
uncommitted work can move directly to or from the box. The router keeps no copy and never returns the hook's argv.
`place` reports only whether these hooks exist. Never send secrets through them.

**When release leaves a box running** (any skip above, or a lapsed lease), the lease is dropped anyway and the router
stops tracking that box for the run. Handle it by hand:

1. Read `result.tearDown` in the `release` output for the reason.
2. Check the box is idle yourself: no live T3 work, and no keep-alive or other hook of yours running.
3. Stop it with your own script or the provider's console. The router will not stop it for you.
4. If a teardown claim still blocks the box, wait for its deadline, then run `list` to confirm it is clear.
5. The box is an ordinary candidate again. The next `acquire` treats it like any other machine.

## Not set up here

Link renewal (`renew: "auto"` is inactive), SSH helpers, tag-check commands, a repo override file, weights, provisioning
of cloud machines (use your own start and stop scripts) and push-access checks are not part of this release. To relink a
box, call `t3_environment_link` with the user's hint once and continue with the other machines while it is `pending`.
