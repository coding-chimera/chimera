---
name: orchestrate-authoring
description: Reference for writing an orchestrate tool program (orche API and gotchas, failure semantics, limits, quality patterns, worked examples). Load before writing a non-trivial orchestrate code body; not needed for a single task dispatch or a simple homogeneous chimera_swarm fan-out.
---

# Orchestrate authoring reference

`orchestrate` structures work across many subagents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The program is where you encode that structure: what fans out, what verifies, what synthesizes.

The right move is often **hybrid**: scope the work-list first (your own grep/glob/graph calls, or one cheap `orche.agent` scout), then fan out over it. You don't need to know the shape before the *task* — only before the *fan-out step*.

When NOT to use orchestrate: a single delegation (use `task`), or a simple homogeneous fan-out with no per-item logic (use `chimera_swarm`, which also gives you background execution and per-worker notifications).

Common single-phase programs you can chain across turns:
- **Understand** — parallel readers over subsystems -> structured map
- **Design** — judge panel of N independent approaches -> scored synthesis
- **Review** — dimensions -> find -> adversarially verify (worked example below)
- **Research** — multi-angle sweep -> deep-read -> synthesize
- **Migrate** — discover sites -> transform each -> verify

**Ultra tier.** When the runtime context carries the multi-agent orchestration block (ultra root session), proactive delegation is standing policy: reach for orchestrate whenever the fan-out is 5+ agents or has per-item stages. The quality patterns below are the tools; pick what fits. Solo only on conversational turns or trivial mechanical edits.

## Program shape

`code` is the body of one async function: top-level `await` and `return` are allowed, plus a `description` (3-5 word UI label) on the tool call itself. Plain JavaScript, NOT TypeScript — type annotations, interfaces, and generics fail to parse.

The program runs in a dedicated worker process with a scrubbed environment. Standard JS built-ins (JSON, Math, Date, Array, ...) are available — including `Date.now()` and `Math.random()` (there is no resume mechanism, so nothing restricts them). There is NO filesystem, Node.js API, network, or tool access: the only way to touch the outside world is `orche.agent`.

`return <value>` ends the program. The value must be lossless JSON (no `undefined`, functions, `Date`/`Map` objects, circular refs) and is byte-capped — return the curated result, not raw child transcripts. Logs are byte-capped too; log milestones, not streams.

## API

- `await orche.agent({ prompt, agent?, model?, label?, schema? })` -> `{ text }`, or `{ structured }` when `schema` is given, or `null` when the subagent fails.
  - The argument must be lossless JSON; unknown fields are rejected. `prompt` is required and non-empty.
  - `agent` selects the subagent type (default `"general"`). Restricted types like `explore` have read-only tool sets — match the type to the work.
  - `label` sets the UI label; when omitted, the prompt's first line (truncated at 80 chars) is used. Keep labels short and distinct enough to tell agents apart in the progress view.
  - `schema` is a JSON Schema object; the child's final answer is validated against it (structured-output format, 2 automatic retries) and returned as `{ structured }`. Keep schemas flat and small.
  - `model` is an exact `provider/model` route string (e.g. a route from the session's scheduling context or `subagent_model_routes`). It cannot carry a variant or workload. Default to omitting it — dispatch falls back through the agent's configured route to the parent model, which is usually correct. Never invent provider IDs.
- `await orche.parallel([() => ..., ...])` -> results array in input order. Entries may be thunks (preferred) or already-created promises/values. This is a BARRIER: it awaits every entry. A thunk whose agent fails resolves to `null` in place — the call itself does not reject for child failures, so handle `null` (e.g. `.filter(Boolean)`, with a type guard to keep inference) before using results.
- `orche.pipeline([stage, ...])([item, ...])` -> results array in input order. Each item flows through ALL stages independently — NO barrier between stages: item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT shape for multi-stage work.
  - A stage receives ONLY the previous stage's value — there is no item/index parameter. To keep the original item around, have stage 1 return `{ item, ...result }` and thread it through.
  - A stage that throws or returns `null` drops that item to `null` and skips its remaining stages.
  - Stages must be functions: a non-function stage fails the whole program, not just the item.
- `orche.log(...values)` / `console.log(...)` appends a progress line to the tool result.

## Failure semantics

- A subagent that fails (error turn, crash, abort) resolves to `null`. Treat `null` as a normal outcome: filter it, count it, never let one failure sink the program.
- Host-side problems reject the binding call instead: invalid arguments, dispatch infrastructure errors, and permission denials. An UNCAUGHT rejection aborts the whole program. Catch around `orche.agent` only when you deliberately want to survive those.
- Approval: the orchestrate call is approved once; every `orche.agent` still passes the normal `task` permission for its agent type. A denial rejects that call (see above).

## Limits

- `maxTotalAgents` caps total dispatches per program (default 64, hard cap 256) — a runaway-loop backstop.
- At most 16 agents run concurrently (FIFO queue); you can pass 100 items to parallel/pipeline and they all complete, ~16 at a time.
- `timeoutMs` is optional; absent means no wall-clock limit. Set it only when you deliberately want a time budget.
- Subagents are real child sessions (visible, persisted, individually cancellable) and obey delegation depth, concurrency budgets, and their own permission rules. Subagents never run the ultra variant.
- Each worker's intermediate messages and tool output NEVER enter the parent context — only its returned text/structured value crosses. Every prompt must be fully self-contained: context, constraints, file lists, acceptance criteria, and exactly what to return (its final message, or the structured object, is the only thing that comes back). Workers know nothing you don't write.

## DEFAULT TO pipeline()

Only reach for a barrier (`orche.parallel` between stages) when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 findings -> skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage.
- "The stages are conceptually separate" — that is what pipeline models. Separate stages != synchronized stages.
- "It's cleaner code" — barrier latency is real: if 5 finders run and the slowest takes 3x the fastest, a barrier wastes the fast finders' idle time.

Smell test: if you wrote
  const a = await orche.parallel(...)
  const b = transform(a)        // flatten, map, filter — no cross-item dependency
  const c = await orche.parallel(b.map(...))
the middle transform does not need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

When a barrier IS correct — dedup across all findings before verification:
  const reviews = await orche.parallel(DIMENSIONS.map(d => () =>
    orche.agent({ prompt: d.prompt, label: `review:${d.key}`, schema: FINDINGS_SCHEMA })))
  const deduped = dedupeByFileAndLine(reviews.filter(Boolean).flatMap(r => r.structured.findings))
  const verified = await orche.parallel(deduped.map(f => () =>
    orche.agent({ prompt: verifyPrompt(f), label: `verify:${f.file}`, schema: VERDICT_SCHEMA })))

## Quality patterns

Compose freely; pick by task.

- Adversarial verify: N independent skeptics per finding, each prompted to REFUTE; kill the finding if the majority refutes. Prevents plausible-but-wrong findings from surviving.
    const votes = await orche.parallel(Array.from({ length: 3 }, () => () =>
      orche.agent({ prompt: `Try to refute: ${claim}. Default to refuted=true if uncertain.`, schema: VERDICT })))
    const survives = votes.filter(Boolean).filter(v => !v.structured.refuted).length >= 2
- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy can't.
- Judge panel: generate N independent attempts from different angles (MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best runner-up ideas.
- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (`while (count < N)`) miss the tail.
- Multi-modal sweep: parallel agents each searching a different way (by-structure, by-content, by-history); each is blind to what the others surface.
- Completeness critic: a final agent asked "what's missing — angle not covered, claim unverified, file unread?" Its findings become the next round of work.
- No silent caps: if the program bounds coverage (top-N, sampling, budget cutoffs), `orche.log()` what was dropped — silent truncation reads as "covered everything" when it didn't.

Loop-until-dry skeleton (dedup against ALL seen, not against confirmed — otherwise judge-rejected findings reappear every round and the loop never converges):
  const seen = new Set(), confirmed = []
  let dry = 0
  while (dry < 2) {
    const found = (await orche.parallel(FINDERS.map(f => () =>
      orche.agent({ prompt: f.prompt, schema: BUGS })))).filter(Boolean).flatMap(r => r.structured.bugs)
    const fresh = found.filter(b => !seen.has(key(b)))
    if (!fresh.length) { dry++; continue }
    dry = 0
    fresh.forEach(b => seen.add(key(b)))
    const judged = await orche.parallel(fresh.map(b => () =>
      orche.agent({ prompt: `Verify: ${b.desc}`, schema: VERDICT }).then(v => ({ b, real: v?.structured.real }))))
    confirmed.push(...judged.filter(v => v.real).map(v => v.b))
  }
  return confirmed

## Worked example: review then verify

Pipeline by default — each dimension's findings start verifying while the other dimensions are still reviewing:

  const DIMENSIONS = [{ key: "bugs", prompt: "..." }, { key: "perf", prompt: "..." }]
  const results = await orche.pipeline([
    d => orche.agent({ prompt: d.prompt, label: `review:${d.key}`, schema: FINDINGS_SCHEMA })
           .then(r => r && { findings: r.structured.findings }),
    review => orche.parallel(review.findings.map(f => () =>
      orche.agent({ prompt: `Adversarially verify: ${f.title}`, label: `verify:${f.file}`, schema: VERDICT_SCHEMA })
             .then(v => ({ ...f, verdict: v?.structured })))),
  ])(DIMENSIONS)
  const confirmed = results.filter(Boolean).flat().filter(f => f.verdict?.isReal)
  return { confirmed }

(If the review agent fails, stage 1 returns `null` and the pipeline drops that dimension automatically — stage 2 is never called with `null`.)

## Return discipline

The parent context receives ONLY the return value and log lines. Return exactly what the parent needs: a compact findings array, a deduplicated table, a verdict — with `file:line` anchors and enough per-item detail to act on. A program that returns nothing (or raw transcripts) wastes the entire fan-out.

Scale to what the task needs: "find any bugs" -> a few finders, single-vote verify; "thoroughly audit" -> a larger finder pool, 3-5 vote adversarial pass, synthesis stage. Within `maxTotalAgents`, prefer wider coverage over depth-per-item for exploration.