<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Evaluators

An **evaluator** defines how a test-case run is judged. Two kinds exist:

| `kind`            | How it judges                                                                                   | Needs                                   |
|-------------------|--------------------------------------------------------------------------------------------------|-----------------------------------------|
| `llm` (default)   | Sends the trajectory + expected outcomes to a judge model with the evaluator's `systemPrompt`.  | `systemPrompt`, `scoringConfig`         |
| `deterministic`   | Computes typed metrics **in code** from the test case's gold ids and the report's stored output. | `metrics`, `passPolicy`, `inputs`       |

Both are stored and versioned the same way (`GET/POST/PUT/DELETE /api/storage/evaluators`),
both are pickable per run, and both write the same per-report provenance
([`scoringSnapshot`](ARCHITECTURE.md#scoring-read-model-scoringsnapshot-and-legacy-scoring)),
so the compare page renders them identically.

## Deterministic evaluators (retrieval metrics)

A deterministic evaluator **never calls an LLM**. It is the right tool when the
benchmark has a structured answer key — e.g. a ranked-retrieval task whose test
cases name the gold item ids — and you want paper-style metrics (Hit@k, Recall@k,
MRR) that are reproducible, free, and applicable to runs that already completed.

Agent Health stays **benchmark-agnostic**: metric *names* are free-form data on
the evaluator document; only the compute *types* live in code
([`lib/metrics`](../lib/metrics/index.ts)). Nothing in the codebase knows what
"Hit@5" means, which tool your agent calls, or how your gold line is written —
all of that is declared on the evaluator you create.

### Document shape

```jsonc
{
  "name": "Ranked retrieval (Hit@k / Recall@k / MRR)",
  "description": "Optional. State the protocol caveats here (subset, extraction from stored tool results, anchors excluded).",
  "kind": "deterministic",

  // Free-form names; compute.type ∈ ranked-hit | ranked-recall | mrr | abstain.
  // scale defaults to {min:0,max:1}; weight > 0; primary marks compare-page columns.
  "metrics": [
    { "name": "hit@1",     "compute": { "type": "ranked-hit",    "k": 1 },  "weight": 0.25, "primary": true },
    { "name": "hit@5",     "compute": { "type": "ranked-hit",    "k": 5 },  "weight": 0.15, "primary": true },
    { "name": "recall@20", "compute": { "type": "ranked-recall", "k": 20, "denominator": "full-gold" }, "weight": 0.35, "primary": true },
    { "name": "mrr",       "compute": { "type": "mrr" },                    "weight": 0.25, "primary": true }
  ],

  // threshold: weighted mean of the metrics normalized to [0,1] must be >= minScore.
  // gates:     every listed metric (in its own scale) must be >= min.
  // "llm-verdict" is rejected for deterministic evaluators.
  "passPolicy": { "kind": "gates", "gates": [ { "metric": "hit@5", "min": 1 } ] },

  "inputs": {
    // Where the GOLD ids come from — see "Inputs contract".
    "gold": { "source": "expectedOutcomes-pattern", "pattern": "^Gold id\\(s\\):\\s*(.+)$" },
    // Where the PREDICTED ranking comes from — see "Prediction sources".
    "prediction": {
      "source": "tool-hits-ordered",
      "idFields":  ["id", "_id"],            // optional (defaults shown)
      "hitsPaths": ["hits", "results"],      // optional (defaults shown; dotted paths allowed, e.g. "forward.records")
      "anchorTools": [ { "tool": "expand", "argKey": "seed_ids" } ]  // optional
    }
    // …or the ranked list the agent RETURNED as its answer:
    // "prediction": { "source": "response-results", "path": "results", "idField": "id", "rankField": "rank" }
  }
}
```

`POST /api/storage/evaluators` with that body returns `201` and the stored
document: `systemPrompt` is `""`, `inferenceConfig` is `{}`, and a
`scoringConfig` mirror (`metrics[].{name, weight, scale}`,
`passThreshold`) is synthesized so every existing consumer keeps rendering.
Validation errors come back as `400 { error }` — the first problem found, e.g.
`passPolicy.kind 'llm-verdict' is not allowed for deterministic evaluators`,
`unknown compute type "ndcg"`, `passPolicy.gates[0].metric 'x' does not name a
declared metric`, `inputs.gold.pattern must contain exactly one capture group`.

The evaluator editor UI (`/evaluators/new`) has a **Kind** selector; choosing
*Deterministic* replaces the prompt editor with a JSON editor pre-filled with
the template above and validates it on blur / save with the same rules.

### Metric semantics (`lib/metrics`)

Inputs to every metric: `gold: string[]` (a set) and `ranked: string[]` (best
first; duplicates collapse to their first occurrence). Results are in `[0, 1]`
or **`null` = unevaluable** (empty gold or empty ranking — never a fake 0).

| `compute.type`  | Params                                           | Value                                                                                          |
|-----------------|--------------------------------------------------|------------------------------------------------------------------------------------------------|
| `ranked-hit`    | `k ≥ 1`                                          | 1 iff any gold id is among the first `k` ranked ids, else 0                                    |
| `ranked-recall` | `k ≥ 1`, `denominator` = `full-gold` (default) \| `min-k-gold` | gold ids in the first `k` ÷ (`|gold|` \| `min(k, |gold|)`)                          |
| `mrr`           | —                                                | 1 / rank of the first gold id (1-based); 0 when no gold id is ranked                          |
| `abstain`       | —                                                | gold **explicitly empty**: 1 iff the prediction is empty too, else 0; gold non-empty: *not applicable* |

`full-gold` is the standard ranked-retrieval definition (a gold set larger than
`k` caps recall below 1). Note the protocol caveat: metrics are computed over
the candidates the agent actually returned — unreturned corpus items rank below
everything — so this is a *local adaptation* of full-corpus ranking protocols,
not a byte-for-byte reproduction. Say so in the evaluator `description`.

**Applicability.** The ranked metrics speak only to cases *with* gold ids;
`abstain` speaks only to cases whose gold is *explicitly empty* (the right
answer is "nothing" — a query with no relevant item, an out-of-scope request).
A metric that does not apply to a case is **not applicable**: skipped, not in
the weighted mean, never a failure reason, listed in
`scoringSnapshot.notApplicable`, flagged `notApplicable: true` on its matcher
row and rendered with an `n/a` badge on the Judge tab (excluded from the
passed/failed tally). This is what lets one evaluator mix `hit@5` with
`abstain` and score every case by the metrics that speak to it. `abstain` is
deliberately *not* 0 on gold-non-empty cases — that would punish every
ordinary retrieval case for having answered. `abstain` requires
`prediction.source: "response-results"` (validated with `400`): it is about
what the agent *returned*, and `tool-hits-ordered` only sees what was
retrieved — an empty ranking there means "no stored hits", not "abstained".

`MetricInputs.emptyRanking` (`'unevaluable'` default | `'zero'`) tells the
ranked metrics what an empty ranking means; the engine sets `'zero'` for
`response-results` (the agent explicitly returned nothing → hit 0, recall 0,
mrr 0) and leaves the default for `tool-hits-ordered` (no stored candidates →
unevaluable).

### Inputs contract

**Gold** (`inputs.gold`) — resolved per report, in this order:

1. `testCase.expected.ids` (structured `string[]` on the test-case version) —
   wins when **non-empty**. Settable today via the storage API; import/export
   and UI editing are a follow-up.
2. `source: "expectedOutcomes-pattern"` — the **first** `expectedOutcomes` line
   matching `pattern` (a JS regex with exactly **one** capture group) is
   authoritative; the captured text is split on `,` `;` and whitespace. A
   capture that is empty or one of `none` · `n/a` · `-` · `—` · `[]` · `null`
   (case-insensitive) means **explicitly no gold**.
3. `source: "testCase.expected.ids"` with the field present but empty (`[]`)
   → **explicitly no gold**. (Under the pattern source an empty structured
   list is *not* read as "no gold" — clients routinely serialize `[]` for
   "unset"; only an evaluator that opted into the structured field interprets
   it.)
4. Nothing → gold **not declared**: every metric is unevaluable (see below).

"Explicitly no gold" and "gold not declared" are different outcomes on
purpose: the first is an *abstain case* (`abstain` applies, the ranked metrics
are not applicable); the second is a labelling gap and never becomes a verdict
— an agent must never earn an abstain credit because someone forgot the gold
line. Example lines: `Gold id(s): 101, 202` · `Gold id(s): none`.

The rule used is recorded as `scoringSnapshot.goldRule`
(`expected.ids` | `expected-outcomes-pattern`) with the ids in
`scoringSnapshot.goldIdsUsed` (`[]` for an explicitly gold-empty case).

### Prediction sources

Both sources read the report's *stored* data, so completed runs can be scored
without re-invoking the agent. They answer different questions:

| `inputs.prediction.source` | Ranking = …                                                                    | Use when                                                                                                                                                   | Caveat                                                                                                                                                                                                       |
|----------------------------|--------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `tool-hits-ordered`        | every id the agent **retrieved** (all stored tool hits; cited ids first)         | the agent answers in prose and the retrieved set *is* what it surfaced; historical runs whose answer carries no explicit list                              | **over-credits**: a gold id fetched by an exploratory tool call but never recommended still counts, so Hit@k / Recall@k are upper bounds on what a user would have seen                                          |
| `response-results`         | the ranked list the agent **returned as its answer** (`results[]` of `{id, rank?, …}`) | the agent's final answer is (or contains) an ordered result list — a search / recommendation agent; you want to score what was *recommended*, not retrieved | an agent that returns an **explicit empty** list scores 0 on the ranked metrics (and 1 on `abstain` when gold is empty) — that is a real outcome, not a data gap; a response in which **no ranked list can be recognised** (prose, unsupported shape, wrong `path`) is unevaluable, never 0 |

Every report records which one produced its ranking
(`scoringSnapshot.extractionRule`, and `extractionRule` on each matcher row),
so two runs scored with different sources are never silently compared as if
they were the same protocol (the compare page's coverage gate keys on the
evaluator content hash, which includes `inputs`).

**`tool-hits-ordered`** — the labelled
**legacy** extractor ([`lib/scoring/prediction/toolHitsOrdered.ts`](../lib/scoring/prediction/toolHitsOrdered.ts)).
It rebuilds a ranking from the stored `trajectory`. Rule, exactly:

1. **Retrieved ids** = the ids of every hit in every `tool_result` step, most
   recent tool call **first**, within-call order preserved. A hit is an object
   found under one of `hitsPaths` (dotted paths into the parsed result; default
   `hits`, `results`) whose id is under one of `idFields` (default `id`, `_id`).
   `content` may be a JSON string, a `[{ "text": "<json>" }]`-wrapped JSON
   string, or an already-parsed object.
2. **Anchors** = ids passed in `toolArgs[argKey]` (string or string[]) of any
   `action` step whose `toolName` matches an `anchorTools` entry. They are the
   query's own inputs and are **removed** from the candidates.
3. **Cited ids** = retrieved (non-anchor) ids that appear as whole tokens in the
   **last** `response` step's text, ordered by first mention — these go first;
   the remaining retrieved ids follow in order (1).
4. Dedupe keeping the first occurrence; cap at 100.

Every report scored this way carries `scoringSnapshot.extractionRule:
"tool-hits-ordered"` and `scoringSnapshot.extraction = { candidateCount,
citedCount, anchorsRemoved }`, so the provenance is never ambiguous.

**`response-results`** ([`lib/scoring/prediction/responseResults.ts`](../lib/scoring/prediction/responseResults.ts))
— `{ "source": "response-results", "path"?, "idField"?, "rankField"? }`. Reads
the ranked list from the agent's **final response step** (the last `response`
step of the trajectory, else the last `assistant` step). The first form that
yields a list wins and is recorded as `scoringSnapshot.extraction.parsedFrom`:

| `parsedFrom` | Form                                                                                                                                                                                                                  |
|--------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `json`       | the response content **is** a JSON object or array, e.g. `{"answer": null, "results": [{"id": "9", "rank": 1, "score": 0.8, "title": "…"}, …]}`                                                                       |
| `fenced`     | a ```` ```json ```` (or bare ```` ``` ````) block inside the response text whose body is such an object / array                                                                                                          |
| `raw-event`  | a **non-streaming** connector's single raw response payload (`report.rawEvents` holding exactly one plain object — the REST connector's `[data]`), consulted only when a response step exists and is a rendering of that payload; it never stands in for a missing answer. Streaming connectors store many raw events and are never consulted. |
| `text`       | **best-effort** fallback: list lines (`1.` `1)` `-` `*` `•`) whose item text *starts* with an `id` label or carries one in brackets — `1. id 2079 — Some title (score 6.3)`, `- Some title (id: 123)`, `* ID #A-77`. The label is required; mid-sentence prose (`- user id 123 was checked`) and bare numbers are never taken as ids; `id: none` / `id: null` are not ids. |
| `none`       | **no ranked list recognised** → `present: false` → every metric **unevaluable**. "Could not extract" is never scored; to score an abstention the agent must return an explicit empty list (`results: []`, `[]`, or a fenced `{"results": []}`). |

Inside a parsed JSON value the list is at `path` (dotted) when declared — it
must resolve to an array that is empty or whose elements are objects carrying
`idField`, otherwise nothing is found (a misconfigured path surfaces as
unevaluable, never as "returned nothing") — else auto-detected: the root array
itself, then the keys `results` / `hits` / `items`, then the first *root-level*
array whose elements are objects carrying `idField` (default `id`); nested
shapes need an explicit `path`. Items are ordered by `rankField` (default
`rank`, ascending, when numeric on every item) else by array order; ids are
deduped keeping the first occurrence and capped at 100.
`scoringSnapshot.extraction = { candidateCount, parsedFrom }`. Tool results are
**never** read by this source — that is `tool-hits-ordered`'s job.

Empty vs absent: an **explicit empty list** in the response is an empty
prediction (`present: true`) — the ranked metrics compute to 0 and `abstain`
to 1. No `response` / `assistant` step, or a response in which no ranked list
can be recognised, is an **absent** prediction (`present: false`) — every
metric is unevaluable: a parser miss must never look like an abstention, and an
agent that never answered is indistinguishable from one that crashed.

A **native connector output mapping** (the connector declaring the agent's
ranked candidates at run time as typed report output) remains the follow-up;
both sources stay available as explicitly labelled extractors for stored runs.

### Scoring, verdict, and what lands on the report

[`lib/scoring/deterministicScoring.ts`](../lib/scoring/deterministicScoring.ts)
(intentionally minimal; to be reconciled onto the general verdict engine):

- `report.metrics[name]` — each metric in its **own** scale (default 0–1).
- score = weighted mean of the metrics normalized to `[0,1]` (evaluable metrics only).
- `report.passFailStatus` by `passPolicy`. **Any** unevaluable metric ⇒ `failed`
  with reason `unevaluable:<metric>` — never a silent pass. *Not-applicable*
  metrics are skipped entirely (no reason, no failure); a `gates` entry naming
  a not-applicable metric is skipped for that case — and when **every** gate
  is skipped the case has **no verdict** (a gate that was never enforced must
  not read as a pass; the `traceError` tells you which gate to add).
- **No** metric produced a value (gold not declared, no candidates / no
  recognisable ranked list, or no metric applies to the case), or no gate
  applies ⇒ *not a verdict*:
  `metricsStatus: "error"`, `passFailStatus: null`, `traceError` says why
  (`Not evaluable by <evaluator>: …`), `metrics: {}`. The report renders as
  errored / not evaluable and is excluded from the pass rate; flipping it to
  `failed` would punish the agent for a missing gold label or an unparseable
  artifact.
- `report.scoringSnapshot` — `evaluatorId`, `evaluatorVersion`, `evaluatorName`,
  `contentHash` (sha256 over `{metrics, passPolicy, inputs}` as used), `weights`,
  `scale`, `passPolicy`, `primaryMetrics` (names with `primary: true`),
  `goldRule`, `goldIdsUsed`, `extractionRule`, `extraction`, `unevaluable`,
  `notApplicable`.
- `report.matcherResults` — one `method: "code-assertion"` row per metric
  (`role: "primary"` for metrics named by a `gates` policy, else `"observe"`),
  `actual` = value, `expected` = gate min (when gated), `score` = normalized
  value, and `details = { gold, goldTotal, predicted, predictedTotal, k?,
  extractionRule, parsedFrom?, notApplicable?, notApplicableReason? }` (id
  lists truncated to 20) — the Judge Evaluation tab lists the gold and
  predicted ids per row, highlighting predicted ids that are gold, with the
  caption `extraction rule: response-results · parsed from json` and an `n/a`
  badge on not-applicable rows.
- `report.judgeMode: "deterministic"`; `llmJudgeReasoning` is cleared and
  `llmJudgeResponse` is `null` — no stale LLM output sits next to code-computed
  metrics. Only the latest judgement is kept (same policy as re-judging with an
  LLM evaluator).

### Example evaluators (response-results + abstain)

Two generic evaluators for a search / recommendation agent whose answer is a
ranked list. Gold lines look like `Gold id(s): 101, 202` or `Gold id(s): none`
(the latter marks a case where the right answer is to return nothing).

**Consumer-facing** — a user scrolls a short list: pass iff a gold item is in
the top 5 *and* at least half of the gold set is within the top 20; on
gold-empty cases pass iff the agent returned nothing.

```jsonc
{
  "name": "Consumer-facing ranked results",
  "kind": "deterministic",
  "metrics": [
    { "name": "hit@5",     "compute": { "type": "ranked-hit",    "k": 5 },  "weight": 1, "primary": true },
    { "name": "recall@20", "compute": { "type": "ranked-recall", "k": 20 }, "weight": 1, "primary": true },
    { "name": "mrr",       "compute": { "type": "mrr" },                    "weight": 1 },
    { "name": "abstain",   "compute": { "type": "abstain" },                "weight": 1, "primary": true }
  ],
  "passPolicy": { "kind": "gates", "gates": [
    { "metric": "hit@5",     "min": 1 },
    { "metric": "recall@20", "min": 0.5 },
    { "metric": "abstain",   "min": 1 }
  ] },
  "inputs": {
    "gold": { "source": "expectedOutcomes-pattern", "pattern": "^Gold id\\(s\\):\\s*(.+)$" },
    "prediction": { "source": "response-results" }
  }
}
```

**Reader-facing** — a downstream reader consumes only the first result: pass
iff the top-ranked item is gold (and abstain correctly on gold-empty cases).

```jsonc
{
  "name": "Reader-facing top result",
  "kind": "deterministic",
  "metrics": [
    { "name": "hit@1",   "compute": { "type": "ranked-hit", "k": 1 }, "weight": 1, "primary": true },
    { "name": "abstain", "compute": { "type": "abstain" },            "weight": 1, "primary": true }
  ],
  "passPolicy": { "kind": "gates", "gates": [ { "metric": "hit@1", "min": 1 }, { "metric": "abstain", "min": 1 } ] },
  "inputs": {
    "gold": { "source": "expectedOutcomes-pattern", "pattern": "^Gold id\\(s\\):\\s*(.+)$" },
    "prediction": { "source": "response-results", "idField": "id", "rankField": "rank" }
  }
}
```

On a case with gold, `abstain` is not applicable (its gate is skipped); on a
gold-empty case the ranked metrics are not applicable and only the `abstain`
gate decides. Both examples gate on `abstain` *and* a ranked metric on
purpose: a gates policy with no gate that applies to a case yields no verdict. Apply either with Retry judgement (below) to a completed run and
compare against the same evaluator using `tool-hits-ordered` to see how much
the retrieved-set protocol over-credits.

### Applying a deterministic evaluator to a completed run

```bash
# scope 'all' re-scores every case with stored output; the agent is never re-invoked.
curl -X POST http://localhost:4001/api/storage/evaluation-runs/<runId>/retry-judgement \
  -H 'Content-Type: application/json' \
  -d '{ "scope": "all", "evaluatorId": "<deterministic evaluator id>" }'
# → 202 { jobId, total, status: "running" }; poll GET .../retry-judgement/status
```

`evaluatorId` must name an existing evaluator (`400` otherwise); when it is
deterministic no judge model is used at all, and `scope` must be `'all'` —
re-scoring only the errored subset would leave a run whose reports carry two
different scoring snapshots while the run doc claims one evaluator (`400`).
The report's `judgeModelId` is cleared (`null`) since no judge model ran. Run stats are recomputed and the
run's `evaluatorId` is updated to the evaluator that produced the current
verdicts. On the compare page (`/compare?runs=a,b`) each `primary` metric is a
column and the pass-rate header carries the policy ("Pass rate (gates)").

### SDK: the same functions in code tests

Code-SDK eval files can import the registry directly so matcher rows and
evaluator rows compute identically:

```ts
import { test, expect } from '@opensearch-project/agent-health';
import { rankedHit, rankedRecall, mrr, abstain } from '@opensearch-project/agent-health/metrics';

test('ranked retrieval', { prompt: 'find items related to the seed' }, async ({ result }) => {
  const gold = ['101', '202'];
  const ranked = result.trajectory
    .filter(s => s.type === 'tool_result' && s.toolName === 'search')
    .flatMap(s => JSON.parse(s.content).hits.map((h: { id: string }) => h.id));
  expect(rankedHit({ gold, ranked, k: 5 })).to.equal(1);
  expect(rankedRecall({ gold, ranked, k: 20 })).to.be.greaterThan(0);   // denominator: 'full-gold' (default)
  expect(mrr({ gold, ranked })).to.be.greaterThan(0);
  // Score what the agent RETURNED instead: the final response's results[].
  const returned = JSON.parse(result.trajectory.filter(s => s.type === 'response').at(-1)!.content).results.map((r: { id: string }) => r.id);
  expect(rankedHit({ gold, ranked: returned, k: 5, emptyRanking: 'zero' })).to.equal(1);
  expect(abstain({ gold: [], ranked: returned })).to.equal(0);   // a gold-empty case that returned something
});
```

Each function returns a number in `[0, 1]`, or `null` when the inputs are
unevaluable (empty gold; empty ranking unless `emptyRanking: 'zero'`) — check
for `null` before asserting a value. `abstain` returns `null` whenever gold is
non-empty (the case is not about abstaining).
