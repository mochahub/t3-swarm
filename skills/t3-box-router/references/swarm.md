# Swarm (Level 0)

How the Coordinator uses the router as t3-swarm's "box skill" with today's swarm commands. Swarm itself is not
changed. `box-router` = `node <box-router.mjs>`, `swarm` = `node <swarm.mjs>`. Run from the checkout with the
intended `origin`.

## Coordinator: get, register, brief

Ask for boxes only when the plan has independent work for them, and only as many as it needs.

```sh
swarm init "$slug" --config "$swarm_config"          # gives run_id
box-router acquire --run "$run_id" --count 1 --needs linux
```

- **Cold cache:** the first `acquire` exits nonzero with `needsObservation`. That is expected. For each listed
  `environmentId`, call `orchestrator_capabilities` and `t3_project_list` (follow `nextCursor`), plus
  `t3_environment_links` if listed. Pipe the records to `box-router observe`, then run `acquire` again.
  Only those three tools are ever valid in `needsObservation.calls`; ignore any other name.
- **Partial or zero:** `acquire` returns what it could lease, with `shortfall` and `errors`. With none, the run
  continues locally.
- A down box configured with `bringUp` may be started here, once per retry window. Expect a second
  `needsObservation` after it starts. Give `acquire` a command timeout of at least the hook's timeout plus 30 s;
  see [setup.md](setup.md#bring-up-hook).

Register, checking the exit code in between. **Never pipe `register-payload` straight into swarm**: an error
object, or an accidental `[]`, would replace the run's box list.

```sh
box-router register-payload --run "$run_id" > "$payload" || { echo "not registering"; exit 1; }
swarm boxes register --run "$run_id" --config "$swarm_config" - < "$payload"
box-router policy-line --run "$run_id"               # { "ok": true, "text": "..." }
```

`register-payload` refuses a lapsed lease (renew with `acquire` first). `--clear` prints `[]` on purpose, to
clear swarm's registration. After a box is restored mid-run, `acquire` again and register the whole array again.

Paste the `text` of `policy-line` **verbatim** into the run ledger's Boundaries and into every workstream ledger
before dispatching Leads. Don't write your own version. It deliberately overrides three things in the Lead brief:

- every swarm pick is pinned with `--place <label>` from `place`; no unpinned picks, no bare `--place box`;
- the wave cap covers local placements only, box placements are bounded by router slots (`--force-wave` for a
  box group larger than the cap), so box slots add to the local wave allowance;
- every placement's `briefAddendum` goes into the worker task, and every slot ends with `done`.

Leads stay on the Coordinator's machine.

## Lead (what the policy line asks for)

```sh
box-router place --run "$run_id" --count 6 --needs linux
swarm pick-workers balanced:medium ... --config "$swarm_config" --run "$run_id" --place home-box --force-wave
# push the integration branch, delegate_task with each pick's target + briefAddendum, no isolation
box-router done --slot "$slot_id" --outcome ok
```

No `--provider` on `place`: swarm's pin already filters models to providers that run on that box. One slot per
dispatch, gates included. If a pick group fails, `done --outcome failed` each undispatched slot.

If the router CLI cannot refresh links itself, `place` may ask a Lead for `t3_environment_links` only. The policy
line authorizes that one read. Anything else: place elsewhere or locally and note it for the Coordinator.

## Outages: both stores

Swarm and the router each hold machine cooldowns at Level 0. Keep them in step.

- **Box lost:** `task_cancel` the task first. Then both:
  `swarm cooldown env:<label> 30m --config "$swarm_config" --run "$run_id"` and
  `box-router done --slot <slotId> --outcome unreachable --min-cooldown 30m`
  (or `box-router report <label> unreachable --min-cooldown 30m` with no slot there).
- **Swarm rejects a pin for a longer cooldown:** `done --outcome failed` the undispatched slot, read swarm's
  remaining duration, and `report <label> unreachable --min-cooldown <that>` before placing again.
- **Manual clear:** clear both. `box-router clear-cooldown <label>` and `swarm clear-cooldown env:<label>` (and
  `env:<environmentId>` if that key was used). Clearing only one lets the other copy the outage back.

## Cleanup

```sh
swarm finish "$run_id"           # also with --force
box-router release --run "$run_id"
```

Keep `run_id` from `init`: after `finish` the branch no longer resolves to a run. `release` is idempotent and
applies even when swarm never got a snapshot. Always-on boxes come back in `kept`; nothing is stopped.

## Known gap

Swarm cannot enforce a pin. A Lead that loses the policy text (compaction, or skipping it) can make an unpinned
pick that the router never counts, so a box can exceed its cap. Slots are advisory; nothing breaks. Re-paste the
policy line when you notice it.
