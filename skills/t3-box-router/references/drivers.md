# Provisioning and short-lived machines

**Not provided.** The router never creates, sizes, prices or deletes a machine, and it has no driver interface.

What it does do, with commands the user writes:

- `kind: "on-demand"` and `kind: "ephemeral"` machines take a `bringUp` hook to start them and a `tearDown` hook to stop
  them. The router runs each hook only at the moments in [setup.md](setup.md#lifecycle-hooks) and stops a box only if
  this run started it.
- `ephemeral` boxes rank below every local, always-on and on-demand machine, so they take overflow only.
- Any sandbox or cloud machine the user provisions and links by hand works as an always-on machine while its link lasts.

Scripts that create a machine, and the cost of keeping one, stay with the user. Do not build against a driver protocol;
none exists in this checkout.
