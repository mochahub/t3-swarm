# Drivers and short-lived machines

**Not supported.** This release routes to local and to always-on boxes that already have a stable T3 link.

- There is no driver interface, no `kind: "ephemeral"`, no provisioning and no teardown. The router never starts
  a cloud machine and never spends money.
- The only machine-starting hook is the user's own `bringUp` command on an always-on box, run during `acquire`
  ([setup.md](setup.md#bring-up-hook)).
- A sandbox or cloud machine the user starts and links by hand can be added as an ordinary always-on machine while
  its link lasts. Remove it from config when it goes away.

A driver protocol for short-lived machines is an unscheduled design sketch in the project's documentation. Do not
build against it, and don't tell the user it exists as a feature.
