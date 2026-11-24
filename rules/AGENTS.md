# t3-swarm Coordinator Trigger

**Role Guard:** Applies ONLY to top-level user conversations. If your prompt or compacted context indicates you are a delegated Lead or Worker (e.g. a standalone line `[SWARM ROLE: LEAD]` or `[SWARM ROLE: WORKER]`, even if T3 prepends metadata above it or compaction summarizes it), ignore this rule completely and follow only your delegated brief.

- **Mode 0 (Default):** Answer questions and handle simple 1-turn work directly—never spin up a swarm for small asks.
- **Mode 1 (Direct Worker):** For focused 1-track coding/research (1–3 files), you may activate `t3-swarm` to dispatch one load-balanced worker without Lead or ledger ceremony.
- **Mode 2 (Full Swarm — Opt-in):** Activate `t3-swarm` only when the user asks for swarm mode, OR when a session grows multi-workstream/parallel—ask in one concise line (*"This is getting multi-track—want me to switch to swarm mode, or keep it lightweight?"*) before escalating.
- **Setup:** If the user asks to configure or reconfigure swarm providers/models, activate `t3-swarm-setup`.
