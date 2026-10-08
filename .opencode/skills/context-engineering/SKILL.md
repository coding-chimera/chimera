---
name: context-engineering
description: Plan and conventions for chimera's context-management overhaul (microcompaction/prune redesign, per-model configurable context policy, compaction side-query routing, write-time truncation, MRCR-based calibration). Load when working on src/session/overflow.ts, src/session/compaction.ts, prune/compaction triggers in src/session/prompt.ts, compaction config schema, tool-output truncation, or when asked about effective context / long-session quality per model.
---

# Context Engineering Plan (agreed 2026-09-10, status: PLANNED — not yet implemented)

Owner decisions in this file were made by the user on 2026-09-10 after an MRCR v2
benchmark study of qwen3.8-max-0902 and a source study of qwen-code's harness.
This skill is the durable spec; implementation has NOT started. Do not treat any
item here as already-shipped behavior.

## Evidence base (read before designing changes)

- Benchmark workspace: `/Volumes/workspace/mrcr_qwen38max/` — MRCR v2 (official
  google-deepmind/eval_hub protocol) × qwen3.8-max-0902 via internal relay.
  `final_report.md` has all numbers; `results/` has aggregates; the runner in
  `src/run_qwen_mrcr.py` doubles as the per-model **calibration rig** (swap
  `--model/--base-url`, rerun the same stratified sample-id sets).
- Key measured facts (qwen3.8-max-0902, 8-needle, no tools, official metric):
  - upto_128K cumulative (official variant, full 484): **0.788** thinking-off.
  - Effective context (mean ≥ 0.5): **~270K tokens thinking-ON, ~530–580K OFF**.
  - Thinking-ON has a cliff at ~524K (bucket mean 0.688 → 0.274); OFF declines
    gradually (largest drop −0.236 at 780K→910K).
  - Sample-level outcomes are bimodal (≈1.0 or <0.15); failure = reproducing a
    wrong sibling needle, i.e. broken ordinal enumeration, not fuzzy copying.
  - Position profile is U-shaped in ordinal space: 1st/2nd instance 0.94–0.95,
    valley at 6th/7th (0.22–0.27 at ≥262K), 8th recovers to 0.66–0.87.
    **Primacy and recency zones stay strong even at 963K total context.**
  - Thinking-ON hurts verbatim reproduction at long context (partial-score
    share 22% vs 0.8% OFF) while helping ≤128K (+0.10…+0.20 paired delta).
  - Relay prefix cache is real and worth protecting: 98% hit rate on
    prefix-shared inputs; cold prefill ≈3.2× the latency of a cached read.
- qwen-code reference constants (studied in `/Volumes/workspace/qwen-code`):
  compaction trigger 0.85×window (≈850K on a 1M model, warn/auto/hard tiers
  830/850/977K, circuit breaker after 3 consecutive failures); microcompaction
  of tool results at >500K chars cleared down to a 250K low watermark (keep 5
  most recent; triggers size/idle-60min/force; low watermark exists explicitly
  to avoid breaking the provider prompt-cache prefix — see comment in
  `packages/core/src/services/microcompaction/microcompact.ts`); write-time cap
  30K chars with spill-to-tempfile; post-compact restore of 5 recent files ×5K;
  compaction side-query runs with thinking disabled.

## Current chimera facts (verified 2026-09-09/10; re-verify before editing)

- `src/session/overflow.ts`: `AUTO_COMPACTION_RATIO = 0.9` hardcoded;
  `usable()` = min(0.9 × capacity, capacity − reserved); capacity =
  `limit.input` when configured else `limit.context − limit.output`. On
  qwen3.8-max-0902 (983,616/131,072) the trigger is ≈767K.
- `src/session/compaction.ts`: `prune` exists (≈line 312) but is **opt-in**
  (`cfg.compaction?.prune`, no default → off) and its protection anchor is
  "last 2 user turns" (`turns < 2` gate): in loop-engineering sessions where
  the user speaks once, prune is a **mathematical no-op** (turns never reaches
  2). Constants: `PRUNE_MINIMUM = 20_000`, `PRUNE_PROTECT = 40_000`,
  `PRUNE_PROTECTED_TOOLS = ["skill"]`. Prune is forked unconditionally at run
  end in `src/session/prompt.ts` (≈line 2328).
- Config surface today: `compaction.{auto,tail_turns,preserve_recent_tokens,
  reserved,prune}` + `remote_compaction_models` (config-extends-builtin,
  api.id exact/versioned-prefix match — reuse this matching semantics).
- Remote compaction (OpenAI Responses) already exists and is capability-gated
  per model (`src/session/remote-compaction*.ts`).

## Design principles (each is evidence-backed; do not violate without new data)

1. **Trigger height ≠ quality policy.** The compaction trigger is an overflow
   safety net and may stay high (0.85–0.9 × capacity). Quality comes from
   controlling what *occupies* the context, not from compacting early.
2. **Necessary information lives in primacy/recency zones; the middle may be
   hollow.** MRCR position data: head/tail recall stays 0.66–0.95 even at
   963K; only deep-middle bulk recall collapses. System/memory head +
   workbrief/recent-outputs tail is the load-bearing layout.
3. **Policy is per (model, thinking-variant) and driven by measured recall,
   and it is 100% configuration — no model-specific numbers hardcoded in
   source.** (User decision 2026-09-10.)
4. **History rewrites are cache-hostile: batch them, add hysteresis
   (high/low watermark), and prefer cold-cache moments** (idle, or right after
   a turn whose usage reported `cached_tokens == 0`).
5. **Prune safety = recoverability.** Only prune what can be regenerated:
   disk-rereadable reads/greps, oracle-backed shell/edit evidence
   (`chimera_oracle_get`), spilled-to-disk outputs with a pointer in the
   placeholder. Never prune workbrief content or irreplaceable observations
   without spilling first.

## Workstreams

### WS1 — Write-time hygiene (model-agnostic, keep for ALL models)
Unified tool-output cap (~30K chars) with spill-to-disk. Placeholder must be
smart (user decision): include head/tail preview, **the line number / offset
where truncation happened**, and the spill file path so the model can
`read --offset` or grep exactly. Applies even to perfect-recall models: bulk
logs are noise + cost regardless of retrieval ability.

### WS2 — Microcompaction redesign (prune rebuild) — FIRST PRIORITY
- Replace the user-turn anchor with a **pure token-budget anchor**: walking
  backwards, protect the most recent `keep_recent` tool outputs plus a
  `PRUNE_PROTECT`-style token budget; user anchor becomes a floor (everything
  since the latest user message stays protected), not a gate. Loop-mode
  sessions (1 user message, hundreds of agent turns) must work — this is the
  fix for the current no-op.
- **Token-denominated hysteresis** (user endorsed): live tool-output total >
  `budget.high` → clear in one batch down to `budget.low` (= high/2), keeping
  the `keep_recent` newest. No riding-the-threshold per-turn rewrites.
- Recovery tiers: read/grep/glob → prune freely; shell/edit → prune (oracle
  store + ref in placeholder); webfetch/one-shot observations → spill to disk
  first, pointer in placeholder.
- Triggers: pressure check at run end (tokens ≥ ~0.5 × usable), idle, and
  cold-cache signal; keep a PRUNE_MINIMUM-style batch gate.
- Flip `compaction.prune` default to **on** (with conservative built-in
  defaults so zero-config installs get loop-safe behavior).

### WS3 — State externalization (formalize existing strengths)
- **workbrief is our better todo-reinjection** (user decision): recency-zone
  suffix per turn. Rules: compaction summaries reference the brief instead of
  duplicating it; prune/compaction never touch brief content.
- Post-compact restore (port from qwen-code): structured multi-section summary
  (primary request / files & code / errors & fixes / pending tasks / current
  work / next step), most-recent ~5 touched files × ~5K tokens re-injected at
  the tail, plus a resume trailer suppressing re-greeting/re-introduction.

### WS4 — Configurable per-model context policy (NO hardcoded model tables)
- Code ships only: schema + conservative generic defaults. All model profiles
  live in config; docs carry recommended snippets.
- Config shape (under existing `compaction` node; snake_case; Schema.optional
  + annotate per house style):

```jsonc
"compaction": {
  "prune": true,
  "models": {
    "gpt-6-astra": {                 // api.id exact or versioned prefix match
      "prune": false,
      "trigger_ratio": 0.93,
      "live_tool_budget": null,      // null = unbounded
      "provenance": "assumed"        // user decision: treat as calibrated
    },
    "qwen3.8-max": {
      "prune": true,
      "trigger_ratio": 0.85,
      "live_tool_budget": { "high": 120000, "low": 60000, "keep_recent": 5 },
      "sidequery": { "thinking": false },
      "variants": {
        "standard": { "live_tool_budget": { "high": 400000, "low": 200000 } }
      },
      "provenance": "measured",
      "calibrated_at": "2026-09-09"
    }
  }
}
```

- Resolution: (model api id, variant/thinking state) → pattern match →
  merge global defaults ← model layer ← variant layer; env kill-switches
  (e.g. OPENCODE_DISABLE_PRUNE) win last. Variant detection rides the
  existing model-resolution path (the same chain SystemPrompt overlays use).
- `provenance`: `measured` (calibration rig output, with date) vs `assumed`
  (internal guarantee, e.g. gpt-6-astra — **no calibration gate required per
  user decision 2026-09-10**). Flip to measured if data ever becomes
  available; policy numbers need not change.
- Model profiles (initial, from this study): qwen3.8-max thinking-on: budget
  120K/60K, trigger 0.85–0.9; thinking-off: budget ~400K/200K; gpt-6-astra:
  prune off, trigger ~0.93, write-time caps only; deepseek/kimi: conservative
  qwen-class defaults until their attention-system validation lands (user says
  testing is in progress).
- **Calibration → config pipeline**: add `--emit-policy` to the benchmark
  aggregator (`/Volumes/workspace/mrcr_qwen38max/src/aggregate_results.py`) so
  a calibration run emits a paste-ready policy JSON (effective_context@0.5 →
  budget.high; largest-drop location → trigger suggestion; on/off delta →
  variants layer) with provenance/date filled automatically.

### WS5 — Compaction execution routing
- OpenAI line → remote compaction (already implemented; just expose via the
  policy table).
- qwen line → local side-query with **thinking off / low effort** (qwen-code
  does this; our data quantifies why: thinking = 8× latency and reasoning
  degrades verbatim fidelity, while summarization is an extraction task).
- deepseek/kimi → `sidequery` effort is a policy field, filled after WS4
  validation; never hardcoded per model in source.
- Port warn/auto/hard three-tier thresholds + consecutive-failure circuit
  breaker (qwen-code/claude-code shape) replacing the single hard trigger.
- Mid-session model switch: prune is irreversible — resolve policy by the
  strictest model used in session history, or apply only to new writes.
  Decide explicitly when implementing.

### WS6 — Validation & telemetry
- Drift-guard tests: synthetic loop session (1 user message + 200 assistant
  turns) asserting prune fires (no-op regression guard); hysteresis assertion
  (no per-turn rewrites); spill-pointer resolvability.
- Cache telemetry: log `cached_tokens/total` per turn; alert when prune
  correlates with sustained cache misses.
- Session-level A/B KPIs: turns-to-complete, re-read count, compaction count,
  cost — the policy north star (not raw token counts).

## Implementation order

1. WS2 prune anchor fix + token budget/hysteresis (prerequisite for loop mode)
2. WS4 schema + resolution + qwen3.8-max profile (interim lever today:
   `limit.input` in model config already lowers `usable()` with zero code)
3. WS1 smart truncation with line positions + spill pointers
4. WS5 qwen side-query thinking-off (config-level, best effort/reward ratio)
5. WS3 post-compact file restore + structured summary
6. WS4 calibration runs for deepseek/kimi (rig ready; needs scheduling)
7. WS6 tests/telemetry alongside each step

## Open questions

- Latency tax of high triggers on thinking sessions (placeholders still cost
  prefill; measured ON@963K = 100–207 s/turn): add a secondary
  "latency-budget" trigger (N consecutive slow turns → compact early)?
- `Token.estimate` cross-model error (±20%): budget thresholds need headroom
  or per-model estimator calibration.
- Coordination: `overflow.ts` / `compaction.ts` / `prompt.ts` and the prompt
  layer have in-flight user changes (workbrief/prompt optimization work) —
  rebase this plan against them before starting; never edit around uncommitted
  WIP without checking.

## Guardrails

- No model-specific constants in source code — schema + conservative defaults
  only (user decision).
- overflow/context_overflow semantics from the benchmark runner must never be
  replicated here as "score 0"-style shortcuts: capacity errors are a
  different status class than quality failures.
- When changing prune/compaction behavior, update agent-facing guidance in the
  same change (per repo AGENTS.md tool-guidance rule) and add focused tests.
