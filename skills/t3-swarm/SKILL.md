---
name: t3-swarm
description: >-
  Three-tier multi-provider orchestration for T3 Code (Coordinator -> Failover Lead -> Tiered Workers).
  Use ONLY in top-level user conversations when the user explicitly requests swarm mode, asks to delegate
  a focused coding task (Mode 1), or when a session grows into multi-workstream/parallel work (ask the user
  in one line before escalating to Mode 2). Never auto-activate for simple questions or quick edits.
  Ignore completely if your prompt begins with [SWARM ROLE: LEAD] or [SWARM ROLE: WORKER].
---

# t3-swarm — Coordinator Playbook

> **ROLE GUARD (READ FIRST):** This skill applies **only** to top-level user conversations where you are the Front-Door Coordinator. If your prompt starts with `[SWARM ROLE: LEAD]` or `[SWARM ROLE: WORKER]`, **stop reading and ignore this skill completely**—follow only your delegated brief.

## Operating Modes (Switch Freely Mid-Session)

- **Mode 0 — Direct (Default):** Q&A, brainstorming, explanations, quick 1-turn edits. Do it yourself with zero orchestration overhead.
- **Mode 1 — Direct Worker (Light):** Focused 1-track coding or research (1–3 files) that benefits from a dedicated worker without Lead/ledger ceremony.
- **Mode 2 — Full Swarm (Opt-in):** Multi-workstream builds, parallel edits, or high-stakes refactors. **Never auto-activate Mode 2.** Enter Mode 2 only when:
  1. The user explicitly asks (*"use the swarm"*, *"spin up the lead"*, etc.), **OR**
  2. The session grows multi-track and you ask in one concise line (*"This is getting multi-track—want me to switch to swarm mode, or keep it lightweight?"*) and they say yes.

Users can drop back to Mode 0 or Mode 1 at any time.

---

## Preflight (Before Mode 1 or Mode 2)

Locate `scripts/swarm.mjs` inside this skill's directory and run:

```bash
node "<skill-dir>/scripts/swarm.mjs" doctor
```

- If `status` is `"unconfigured"`, hand off to the **`t3-swarm-setup`** skill to generate `~/.t3/swarm/config.json` from the user's enabled T3 providers, then continue.
- Call `orchestrator_capabilities` once per thread before your first `delegate_task`.

---

## Mode 1 — Direct Worker Flow (No Lead, No Ledger)

1. Pick `(tier, depth)` in one snap judgment:
   - **Tier:** `fast` (search/docs/boilerplate/checks) · `balanced` *(default)* (features/tests/clear bugs) · `heavy` (tricky bugs/architecture)
   - **Depth:** `low` (obvious path) · `medium` *(default)* · `high` (subtle edge cases/debugging) · `deep` *(rare)*
2. Run:
   ```bash
   node "<skill-dir>/scripts/swarm.mjs" pick-worker <tier>:<depth>
   ```
3. Read `references/worker-brief.md` and call `delegate_task` with the returned `target`, prefixing the prompt with `[SWARM ROLE: WORKER]` + scoped goal, done-criteria, and verification command.
4. **Failure handling:**
   - Quota/rate-limit error → run `swarm.mjs cooldown <bucket>`, re-run `pick-worker`, and retry once.
   - Technical blocker/stuck → bump once (`medium → high` or `balanced → heavy`) rather than retrying the exact same tier.
5. Translate the worker's output back to the user cleanly.

---

## Mode 2 — Full Swarm Flow (Coordinator → Failover Lead → Workers)

1. **Initialize single-file state (`<50` lines):**
   ```bash
   node "<skill-dir>/scripts/swarm.mjs" init "<short-slug>" --goal "<1-2 sentence goal>"
   ```
   Fill in crisp done-criteria and boundaries in the returned `statePath`.

2. **Pick the active Lead:**
   - Default depth is `high`; use `--depth deep` only for genuinely hard architecture or large cross-system refactors (never `max`/`ultra` unless the user asks).
   ```bash
   node "<skill-dir>/scripts/swarm.mjs" pick-lead --depth high
   ```
   *(If the user says a provider is low on quota, run `swarm.mjs cooldown <provider>` first.)*

3. **Dispatch the Lead (`delegate_task`):**
   - Load `references/lead-brief.md` and substitute `{{STATE_PATH}}`, `{{SCRIPT_PATH}}`, `{{WORKER_BRIEF_PATH}}`, `{{LEAD_BUCKET}}` (from `pick-lead`'s `bucket` field), and `{{MAX_LOOPS}}` from the JSON output of `init` / `pick-lead`.
   - Call `delegate_task` with the returned `target` and `mode: "async"`. End your turn and wait for completion.

4. **Handle Lead Outcome:**
   - **Quota / rate-limit / mid-run exhaustion (Hot Failover):**
     1. Run `node "<scriptPath>" cooldown <failed-lead-bucket> --reason "quota_exhausted"`.
     2. Run `node "<scriptPath>" pick-lead --depth <same-depth>` to get the next Lead in priority order.
     3. Re-dispatch `delegate_task` pointing the new Lead at the **exact same `statePath`** with a note: *"Resuming after Lead failover—read STATE.md and continue from the first unchecked task."*
     4. If no healthy Leads remain, inform the user clearly and offer to continue in Mode 1 or wait.
   - **`STATUS: ESCALATE` (rare 1%):** Translate the Lead's question + options into plain English for the user. Once answered, log the decision in `statePath` and re-dispatch the active Lead to finish.
   - **`STATUS: COMPLETE`:** Translate the verified changes and test evidence into a crisp, human-friendly summary for the user.
