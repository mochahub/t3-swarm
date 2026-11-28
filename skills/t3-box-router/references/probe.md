# Probe and profile

For the Coordinator or a standalone top-level agent, with the user. Workers and Leads never probe or apply.

A **profile** records a machine's hardware and toolchain in `config.json` (`machines.<label>.profile`, or
`local.profile`). The router uses it to derive tags and capacity, so the user doesn't have to type them.

## When to probe

`place`, `acquire` and `list` include `unprofiledBoxes`:

```json
"unprofiledBoxes": [
  { "environmentId": "env-new", "label": "studio-mac", "urls": ["https://studio.example:3773"], "reason": "new" }
]
```

| `reason` | Meaning |
| --- | --- |
| `new` | Linked in T3 but not in config. `label` is a proposed router label. |
| `unprofiled` | Configured, never probed. |
| `stale` | Profile older than `defaults.probeTtlDays` (default 7), or probed on another environment. |

The list is information only. It never blocks a placement, never changes `ok` and never asks for an observation. Ready
machines keep being placed while a box waits for its probe. `profile: false` on a machine opts it out.

Where the router learns about links:

- **t3 CLI on `PATH`:** routing commands read `t3 environment list --json` when the discovered-links cache is older than
  `linkTtlMinutes` (15).
- **No CLI:** send a `t3_environment_links` record to `observe`, as for `needsObservation`
  ([setup.md](setup.md#observation-records)). Links for unconfigured environments are kept in `state.json` (label, status
  and credential-free URL origins only) until the cache expires.

Revoked links are skipped: they need relinking, not probing.

## Automatic probe flow (Coordinator)

The Coordinator runs this in the normal flow, never as a separate setup step. It does not wait for the probe.

1. **Trigger.** Whenever `place`, `acquire` or `list` returns a non-empty `unprofiledBoxes`, take each entry whose
   `reason` is `new`, `unprofiled` or `stale`.
2. **Dedupe.** Start at most one probe per `environmentId` at a time. Once a profile is applied its `probedAt` is fresh
   for `defaults.probeTtlDays` and the box leaves the list, so it is not probed again inside that window. The router
   does not record in-flight or failed attempts; keep that in the Coordinator's own notes for the session. A failed
   probe is retried only after the window has passed since the attempt.
3. **Dispatch.** `delegate_task` to the cheapest fast provider that can run child tasks on that environment (from
   `orchestrator_capabilities` for that `environmentId`), with `target` = that provider plus the `environmentId` (and a
   `projectId` if T3 requires one for the target; the probe reads no repository). No `isolation`. The task is read-only:
   paste the full source of `scripts/probe.mjs`, have the child save it outside any repo, run `node <file>`, delete the
   file, and reply with the JSON exactly as printed. Include `--attest` lines only if the owner declared them (see
   below). Nothing else.
4. **Continue.** Carry on with placements and other work while the probe runs. Follow the task's `next`; do not poll it.
5. **Register.** When the reply arrives, save it as `probe.json` and apply it straight away, with no owner step:
   - configured machine: `box-router apply-probe <label> < probe.json`;
   - new box: `box-router apply-probe <label> --environment-id <environmentId> < probe.json`, using the `label` and
     `environmentId` from `unprofiledBoxes`.

   The probe fills tags, `maxConcurrent` and `priority` only where the config leaves them unset (see below). Check the
   result's `effective` values and run `box-router doctor` if anything looks off.
6. **Failures.** A reply that is not one valid probe report is rejected by `apply-probe` and nothing is written. Report
   the error for that label and leave the box unprofiled for now; the next run picks it up again.

Push access is still not checked by the router. If a new box needs it, `setup.md` covers it.

## Probe a box locally

1. **This machine:** `box-router probe | box-router apply-probe local`.
2. **Any other machine by hand:** the same steps as in the Coordinator flow above.

The probe is `scripts/probe.mjs` in this skill. It is self-contained (Node 18+, built-in modules only), so it can run on a
box without the skill installed. It is read-only. It reads:

- the OS, the architecture, the CPU count and the total memory;
- whether specific files exist;
- whether specific programs are on `PATH`;
- a fixed list of environment variables (`PATH`, `PATHEXT`, `HOME`, `DISPLAY`, `WAYLAND_DISPLAY`, `ANDROID_HOME`,
  `ANDROID_SDK_ROOT`, `DEVELOPER_DIR`).

It runs no programs, makes no network requests and writes nothing. It never looks for credentials, environment files,
key stores or sign-ins.

## Owner attestations (cred: and secret: only)

The probe never detects credentials. Only `cred:<name>` and `secret:<name>` tags come from the owner, as attestations
with a value that is exactly `true` or `false`. Pass them only when the owner says so, never by inspecting a machine:

```sh
node probe.mjs --attest secret:build-signing=true --attest cred:play-store=false
```

Other tags are never attested. If any attestation is malformed, the whole report is rejected. Error messages name only the
field and never repeat the input. Never put a secret's value in an attestation, a task or a reply.

## What apply-probe does

`apply-probe` reads the report on stdin and validates every field. It drops unknown fields and reports how many as
`ignoredFields`. A field with the wrong type or range rejects the report, naming only the field.

It then takes the router's state lock and, in that lock:

1. Re-reads `config.json` as the user wrote it.
2. Replaces only the target's `profile` (adding the machine entry for a new box).
3. Validates the whole config.
4. Writes it back atomically with mode 600.

Two concurrent runs never lose a write. Nothing is written if any step fails.

The user's own fields always win. They are never rewritten:

| Effective value | Rule |
| --- | --- |
| tags | (`tags` ∪ profile tags ∪ `extraTags`) − `denyTags` |
| `maxConcurrent` | Explicit value; otherwise one slot per 2 cores and per 4 GB of RAM, whichever is smaller (1 to 8); otherwise the default |
| `priority` | Explicit value; otherwise 10 for a box and 0 for local |

Use `extraTags` for tags the probe can't see, and `denyTags` to withhold a detected one (for example, `docker` on a
box that should not run container work). The result's `preserved` lists the explicit fields that were left alone.
The result's `effective` shows the tags, priority and capacity now in force.

Profile tags:

- the OS (`macos`, `linux`, `windows`) and the architecture;
- `gpu` for an NVIDIA or AMD GPU, plus `gpu-<vendor>` (Apple silicon gets only `gpu-apple`);
- `ram-<N>g`, where N is the nominal size (31.2 GB reports as `ram-32g`);
- `display` and `virtual-display` (Xvfb);
- `xcode`, `ios-sim`, `android-sdk`, `godot`, `docker` and `gh` when found;
- each attestation that is `true`.

A stale profile keeps contributing its tags until it is replaced; staleness only puts the box in
`unprofiledBoxes`. A profile that fails validation when the config loads is ignored, and the next `apply-probe` lists it under
`warnings`. A profile recorded for a different `environmentId` is ignored the same way.

Set the TTL with `defaults.probeTtlDays` (default 7).
