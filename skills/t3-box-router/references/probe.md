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

| `reason` | Meaning | Action |
| --- | --- | --- |
| `new` | Linked in T3 but not in config. `label` is a proposed router label. | Ask the user whether to add it; if yes, probe and apply with `--environment-id`. |
| `unprofiled` | Configured, never probed. | Probe and apply when convenient. |
| `stale` | Profile older than `defaults.profileTtlDays` (default 7), or probed on another environment. | Probe again and apply. |

The list is information only. It never blocks a placement, never changes `ok` and never asks for an observation.
Ready machines keep being placed while a box waits for its probe.

Where the router learns about links:

- **t3 CLI on `PATH`:** every routing command reads `t3 environment list --json` when the discovered-links cache is
  older than `linkTtlMinutes` (15).
- **No CLI:** send a `t3_environment_links` record to `observe`, exactly as for `needsObservation`
  ([setup.md](setup.md#observation-records)). Links for unconfigured environments are kept in `state.json` (label,
  status and credential-free URL origins only) until the cache expires.

Revoked links are skipped: they need relinking, not probing. To stop a configured machine from being listed, set
`"profile": false` on it.

## Probe a box

The probe is `scripts/probe.mjs` in this skill. It is self-contained (Node 18+, built-in modules only), so it
can run on a box that doesn't have the skill installed.

It is read-only. It reads:

- the OS, the architecture, the CPU count and the total memory;
- whether specific files exist;
- whether specific programs are on `PATH`;
- a fixed list of environment variables (`PATH`, `PATHEXT`, `HOME`, `DISPLAY`, `WAYLAND_DISPLAY`, `ANDROID_HOME`,
  `ANDROID_SDK_ROOT`, `DEVELOPER_DIR`).

It runs no programs, makes no network requests and writes nothing. It never looks for credentials, environment
files, key stores or sign-ins.

1. **This machine:** `box-router probe | box-router apply-probe local`.
2. **A box:** delegate a read-only task to the box's environment. Paste the full source of `scripts/probe.mjs`
   into the task. The task asks the child to:
   - save the source to a temporary file outside any repo;
   - run `node <file>`;
   - delete the file;
   - reply with the JSON exactly as printed, and do nothing else.

   Do not ask the child to install anything or change the box. Save the reply as `probe.json`.
3. **Apply it:**
   - Configured machine: `box-router apply-probe <label> < probe.json`.
   - New box, after the user agrees to add it: `box-router apply-probe <label> --environment-id <environmentId> < probe.json`.
     Use the `label` and `environmentId` from `unprofiledBoxes` unless the user picks another label. Then confirm
     priority, capacity and push access with the user, as for any new machine ([setup.md](setup.md#1-discover)),
     and run `box-router doctor`.

## Credentials: attestations only

The probe never detects credentials. When the owner says a credential is present on the machine, pass it as an
attestation. Names are lowercase `cred:<name>` or `secret:<name>`, and values are exactly `true` or `false`:

```sh
node probe.mjs --attest secret:build-signing=true --attest cred:play-store=false
```

Attestations are opt-in. Add them only when the owner declares them, never by inspecting the machine. Only a
`true` attestation becomes a tag. If any attestation is malformed, or any value is not strictly `true` or `false`,
the whole report is rejected. Error messages name only the field (`attestations`) and never repeat the input.
Never put a secret's value in an attestation, a task or a reply.

## What apply-probe does

`apply-probe` reads the report on stdin and validates every field. It drops unknown fields and reports how many it
dropped as `ignoredFields`. If a field has the wrong type or range, it rejects the report and names only the field.

It then takes the router's state lock and does the following, all under that one lock:

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

Set the TTL with `defaults.profileTtlDays` (default 7).
