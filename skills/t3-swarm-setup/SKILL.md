---
name: t3-swarm-setup
description: >-
  Interactive setup and reconfiguration for t3-swarm. Discovers the user's enabled T3 Code providers,
  models, and option schemas via orchestrator_capabilities, builds ~/.t3/swarm/config.json, and validates it.
  Use when the user asks to set up, configure, or update t3-swarm, or when t3-swarm reports status: unconfigured.
  Ignore completely if your prompt begins with [SWARM ROLE: LEAD] or [SWARM ROLE: WORKER].
---

# t3-swarm-setup — Auto-Discover & Configure

> **ROLE GUARD:** Applies only to top-level user conversations. Ignore completely if your prompt begins with `[SWARM ROLE: LEAD]` or `[SWARM ROLE: WORKER]`.

## Goal
Generate (or update) `~/.t3/swarm/config.json` tailored to the user's **actually enabled** T3 providers and models, with zero hardcoded assumptions.

## Steps

1. **Discover live capabilities:**
   Call `orchestrator_capabilities` to inspect all providers where `canRunChildTask === true`, their available `models`, and each model's exact `options` schema (e.g. `reasoningEffort`, `effort`, `thought_level`, `auto_approve`, `mode`).
   *(If `~/.t3/swarm/config.json` already exists, read it first so you preserve any user preferences they want to keep.)*

2. **Draft a smart initial configuration:**
   - **Do NOT exclude the Coordinator's own harness/provider** from Lead or Worker pools unless the user explicitly asks—`t3-swarm`'s `[SWARM ROLE: ...]` guard safely allows same-provider delegation!
   - **Multi-provider harnesses (OMP / Pi, OpenCode, Cline, Cursor):** When one T3 `providerInstanceId` hosts models from multiple upstream vendors (e.g. `pi` with `openai/...`, `anthropic/...`, `google/...`), set `"bucket"` per entry (or rely on automatic vendor-prefix inference from `<vendor>/<model>`) so cooldowns, failover, and anti-cannibalization isolate each upstream billing bucket instead of cooling down the entire harness.
   - **Leads (ordered failover chain):** Pick the strongest reasoning/orchestration models across distinct providers (e.g. flagship reasoning models from Codex, Claude, Antigravity, etc.), ordered by capability and diversity.
   - **Worker Tiers:** Group available models across providers into:
     - `heavy`: top coding/reasoning models (e.g. Opus, Sol, Neon, flagship Pro models)
     - `balanced`: strong everyday workhorses (e.g. Sonnet, Terra, Argon, DeepSeek Flash)
     - `fast`: cheap, quick models (e.g. Haiku, Luna, Flash)
   - **Exact Option & Depth Mapping (critical):**
     - Read each provider's actual option key from `orchestrator_capabilities` (e.g. `reasoningEffort`, `effort`, `thought_level`).
     - Map abstract depths `low`, `medium`, `high`, `deep` **only** to values present in that model's live `values` array! Keep `deep` at `xhigh` (or `high` if `xhigh` is absent)—never default to `max`/`ultra`/`ultrathink` unless the user asks.
     - If a provider/model exposes no thinking-depth option (e.g. Cline), set `"depthOption": null`, set safe non-interactive `staticOptions` (like `{"mode": "act", "auto_approve": true}` if present), and set `"maxDepth": "medium"` so `high`/`deep` tasks automatically route to models with thinking sliders.
     - If a single model within a provider supports a higher depth than its siblings (e.g. `gemini-4-neon` supports `xhigh` while `gemini-4-argon` tops out at `high`), put the safe default on `providers.<id>.depthMap` and add a per-model `"depthMap"` override on that specific entry.

3. **Confirm with the user in 1 turn:**
   Show a compact summary table of:
   - Lead failover order (Priority 1 → 2 → ...)
   - Heavy / Balanced / Fast worker pools
   - Defaults (`leadDepth: high`, `workerDepth: medium`, `cooldownMinutes: 60`, `maxWorkerLoops: 2`, `antiCannibalization: true`)
   Ask if they want to swap priorities, move any model between tiers, or add/remove models.

4. **Write & verify:**
   - Write `~/.t3/swarm/config.json` (creating `~/.t3/swarm/` if needed).
   - Locate `t3-swarm/scripts/swarm.mjs` (sibling skill `../t3-swarm/scripts/swarm.mjs`) and run:
     ```bash
     node "<path-to-swarm.mjs>" doctor
     node "<path-to-swarm.mjs>" pick-lead
     node "<path-to-swarm.mjs>" pick-workers heavy:high balanced:medium fast:low
     ```
   - Report the verified setup cleanly to the user, and remind them they can re-run setup anytime they enable a new T3 provider or model.
