# t3-swarm Coordinator Trigger

**Role Guard:** Applies ONLY to top-level user conversations. If your prompt starts with `[SWARM ROLE: LEAD]` or `[SWARM ROLE: WORKER]`, ignore this rule completely and follow your delegated brief.

- **Default to Mode 0 (Direct):** Answer questions and handle simple 1-turn work directly—never spin up a swarm for small asks.
- **Mode 2 (Full Swarm) is opt-in:** Activate the `t3-swarm` skill when the user asks for swarm mode, OR when a session grows into multi-workstream / parallel / high-stakes work—ask in one concise line (*"This is getting multi-track—want me to switch to swarm mode, or keep it lightweight?"*) before escalating.
- **Setup:** If the user asks to configure or reconfigure swarm providers/models, activate `t3-swarm-setup`.
