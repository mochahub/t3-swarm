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
- **Push access**: the box's checkout can push to `origin`. Phase 1 cannot check this; the user confirms it.
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
agent reads. If a T3 read fails, say so to the caller as missing evidence. Don't invent a reply.

## Bring-up hook

For an always-on box that sometimes needs starting (for example a script that wakes it and starts its T3
service), set `machines.<label>.bringUp` to an argument vector:

```json
"bringUp": ["/Users/you/bin/start-home-box", "home-box"],
"bringUpTimeoutMs": 300000
```

The first element must be an absolute path to an executable. The router runs exactly these arguments, without a
shell, in the hook's own process group, and discards its output. The default timeout is two minutes; set
`bringUpTimeoutMs` (1000 to 600000) on the machine, or `defaults.bringUpTimeoutMs`, to change it. At the timeout
the hook's process group gets SIGTERM, then SIGKILL five seconds later. A process the hook detaches with `setsid`
escapes that stop.

Give the `acquire` command a timeout of at least `bringUpTimeoutMs` plus 30 seconds. If the caller stops the
router early with SIGTERM, SIGINT or SIGHUP, the router kills the hook's process group before it exits. If the
router is killed with SIGKILL, the hook keeps running, and the box stays blocked until the claim's deadline
(about 17 seconds past the hook timeout). After that, the next command expires the box's facts.

The hook runs only during `acquire`, only when the acquisition falls short, and only for a box whose fresh link
read shows it linked but down. It never runs when:

- the link is missing (no link for the box's environment ID), revoked, expired or expiring within
  `minLinkHours`: relink or renew it through T3;
- the link status is unknown, or there is no fresh link read: answer `needsObservation` first;
- the box is cooling (`clear-cooldown` first) or the router holds a slot there;
- another `acquire` is already running its hook (`in-progress`);
- an attempt finished within `defaults.bringUpRetryMinutes` (default 10; reported as `recent`).

While the hook runs, no slot or lease is given on that box, even if an agent observes it reachable. When it
finishes, every fact about the box observed before then is expired, the router re-reads links and decides again.
Expect the acquisition to ask for fresh provider and project observations; supply them and run `acquire` again.

The hook gets one JSON object on stdin (`hook`, `label`, `environmentId`, `run`, `timeoutMs`,
`routerActiveSlots`, `requireIdleCheck`, `note`) and the variables `T3_BOXES_HOOK=bringUp`,
`T3_BOXES_IDLE_CHECK=required` and `T3_BOXES_LABEL`. It must check for active work before restarting a service
and exit 75 if the machine is busy (`refused-busy`; nothing is expired). The router's own slot check covers only
tasks placed through this installation.

Each attempt is reported in the acquisition result's `bringUp` array (`outcome`: `up`, `failed`, `timeout`,
`refused-busy`, `in-progress`, `recent` or `skipped`, plus `detail`). `list` shows a running hook or the last
attempt and when it may run again; `doctor` checks that each hook is executable.

## Not set up here

Link renewal, SSH helpers, tag-check commands, a repo override file, weights and ephemeral boxes are not part of
this release. To relink a box, call `t3_environment_link` with the user's hint once and continue with the other
machines while it is `pending`.
