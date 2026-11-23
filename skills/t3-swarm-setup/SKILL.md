---
name: t3-swarm-setup
description: >-
  Interactive setup and reconfiguration for t3-swarm. Discovers the user's enabled T3 Code providers,
  models, and option schemas via orchestrator_capabilities, builds ~/.t3/swarm/config.json, and validates it.
  Use when the user asks to set up, configure, or update t3-swarm, or when t3-swarm reports status: unconfigured.
  Ignore completely if your prompt contains a standalone line [SWARM ROLE: LEAD] or [SWARM ROLE: WORKER].
---

# t3-swarm-setup — Auto-Discover & Configure

> **ROLE GUARD:** Applies only to top-level user conversations. If your prompt contains a standalone line `[SWARM ROLE: LEAD]` or `[SWARM ROLE: WORKER]` (T3 may prepend a metadata header above it), ignore this skill completely.

## Goal
Generate (or update) `~/.t3/swarm/config.json` tailored to the user's **actually enabled** T3 providers, billing buckets, and option schemas—with zero hardcoded assumptions.

## Steps

1. **Discover live capabilities (including omitted models):**
   - Call `orchestrator_capabilities` to inspect all providers where `canRunChildTask === true`, checking `canRunCrossProviderChildTask`, `models`, `omittedModels`, and each model's exact `options` schema (`reasoningEffort`, `effort`, `thought_level`, `serviceTier`, `provider`, `mode`, `auto_approve`, etc.).
   - If a provider reports `omittedModels > 0` and the user wants specific models not in the short list, call `orchestrator_capabilities` with `search` to verify exact model IDs and option values.
   - If `~/.t3/swarm/config.json` already exists, read it first to preserve existing user preferences.

2. **Draft a smart initial configuration:**
   - **Keep the Coordinator's own harness eligible** for Lead and Worker pools unless the user asks otherwise—the `[SWARM ROLE: ...]` guard keeps same-provider delegation safe.
   - **Map billing buckets accurately (critical for multi-provider harnesses like OMP/Pi, Cline, OpenCode):**
     - Ask the user how multi-provider harnesses are billed:
       - *Shared credit pool* (e.g. Cline default credits): set `"bucket": "cline"` and `"staticOptions": { "provider": "cline", ... }` on `providers.acpRegistry_cline` so all models share one cooldown bucket.
       - *Linked subscription* (e.g. Cline `provider: "openai-codex"` sharing quota with T3 `codex`): map via `bucketAliases` (`"openai-codex": "codex"`) or explicit `"bucket": "codex"` so cooldowns and anti-cannibalization stay synchronized.
       - *Per-vendor API keys / OAuth* (e.g. OMP/Pi hosting `openai/...`, `anthropic/...`, `google/...`): leave `bucket` to auto-namespace (`pi:openai`, `pi:anthropic`, `pi:google`) or set explicit `"bucket"` per entry if it shares quota with another T3 provider.
   - **Leads (ordered failover chain):** Pick the strongest reasoning/orchestration models across distinct billing buckets, ordered by preference.
   - **Worker Tiers:** Group available models across buckets into `heavy`, `balanced`, and `fast`.
   - **Exact Option & Depth Mapping:**
     - Always create a `providers.<id>` entry for every provider referenced in `leads` or `workers`.
     - Map abstract depths `low`, `medium`, `high`, `deep` **only** to values present in that model's live `values` array. Keep `deep` at `xhigh` (or `high` if `xhigh` is absent)—never default to `max`/`ultra`/`ultrathink` unless asked.
     - For Codex models, ask whether `serviceTier` should stay at default or be set explicitly in `staticOptions`.
     - If a provider/model exposes no thinking-depth option, set `"depthOption": null`, configure safe non-interactive `staticOptions` (e.g. `{"mode": "act", "auto_approve": true}` where supported), and set `"maxDepth": "medium"`.
     - When one model in a provider supports deeper thinking than siblings (e.g. `gemini-4-neon` supports `xhigh` while `gemini-4-argon` stops at `high`), put the safe lower cap in `providers.<id>.depthMap` and add a per-model `"depthMap"` override.
   - **Optional `scriptPath`:** Record the resolved path to `t3-swarm/scripts/swarm.mjs` in `config.json` if helpful for non-Antigravity harnesses.

3. **Confirm with the user in 1 turn:**
   Show a compact table with:
   - Lead failover order (model + resolved billing `bucket`)
   - Heavy / Balanced / Fast worker pools (model + resolved `bucket`)
   - Key defaults (`leadDepth: high`, `workerDepth: medium`, `cooldownMinutes: 60`, `maxWorkerLoops: 2`, `maxParallelWorkers: 4`, `antiCannibalization: true`, `allowProjectOverride: false`)
   - Any billing-bucket or `serviceTier` question for multi-provider harnesses.

4. **Write & verify:**
   - Write `~/.t3/swarm/config.json` (creating `~/.t3/swarm/` if needed).
   - Locate sibling `../t3-swarm/scripts/swarm.mjs` and run:
     ```bash
     node "<path-to-swarm.mjs>" doctor
     node "<path-to-swarm.mjs>" pick-lead
     node "<path-to-swarm.mjs>" pick-workers heavy:high balanced:medium fast:low
     ```
   - Verify `doctor` reports `"ok": true`, `"writable": true`, zero errors, and the expected resolved `bucket` for every entry.
