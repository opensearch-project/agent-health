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

  // Free-form names; compute.type ∈ ranked-hit | ranked-recall | mrr.
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
    // Where the PREDICTED ranking comes from — the labelled legacy extractor.
    "prediction": {
      "source": "tool-hits-ordered",
      "idFields":  ["id", "_id"],            // optional (defaults shown)
      "hitsPaths": ["hits", "results"],      // optional (defaults shown; dotted paths allowed, e.g. "forward.records")
      "anchorTools": [ { "tool": "expand", "argKey": "seed_ids" } ]  // optional
    }
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

`full-gold` is the standard ranked-retrieval definition (a gold set larger than
`k` caps recall below 1). Note the protocol caveat: metrics are computed over
the candidates the agent actually returned — unreturned corpus items rank below
everything — so this is a *local adaptation* of full-corpus ranking protocols,
not a byte-for-byte reproduction. Say so in the evaluator `description`.

### Inputs contract

**Gold** (`inputs.gold`) — resolved per report, in this order:

1. `testCase.expected.ids` (structured `string[]` on the test-case version) —
   always wins when non-empty. Settable today via the storage API; import/export
   and UI editing are a follow-up.
2. `source: "expectedOutcomes-pattern"` — the **first** `expectedOutcomes` line
   matching `pattern` (a JS regex with exactly **one** capture group); the captured
   text is split on `,` `;` and whitespace.
3. Nothing → every metric is unevaluable (see below).

The rule used is recorded as `scoringSnapshot.goldRule`
(`expected.ids` | `expected-outcomes-pattern`) with the ids in
`scoringSnapshot.goldIdsUsed`.

**Prediction** (`inputs.prediction.source: "tool-hits-ordered"`) — the labelled
**legacy** extractor ([`lib/scoring/prediction/toolHitsOrdered.ts`](../lib/scoring/prediction/toolHitsOrdered.ts)).
It rebuilds a ranking from the report's *stored* `trajectory` so completed runs
can be scored without re-invoking the agent. Rule, exactly:

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
citedCount, anchorsRemoved }`, so the provenance is never ambiguous. A **native
connector output mapping** (the connector declaring the agent's ranked
candidates at run time) is the follow-up; when it lands, `tool-hits-ordered`
stays available as the explicitly labelled fallback for historical runs.

### Scoring, verdict, and what lands on the report

[`lib/scoring/deterministicScoring.ts`](../lib/scoring/deterministicScoring.ts)
(intentionally minimal; to be reconciled onto the general verdict engine):

- `report.metrics[name]` — each metric in its **own** scale (default 0–1).
- score = weighted mean of the metrics normalized to `[0,1]` (evaluable metrics only).
- `report.passFailStatus` by `passPolicy`. **Any** unevaluable metric ⇒ `failed`
  with reason `unevaluable:<metric>` — never a silent pass.
- **All** metrics unevaluable (no gold, or no candidates) ⇒ *not a verdict*:
  `metricsStatus: "error"`, `passFailStatus: null`, `traceError` says why
  (`Not evaluable by <evaluator>: …`), `metrics: {}`. The report renders as
  errored / not evaluable and is excluded from the pass rate; flipping it to
  `failed` would punish the agent for a missing gold label or an unparseable
  artifact.
- `report.scoringSnapshot` — `evaluatorId`, `evaluatorVersion`, `evaluatorName`,
  `contentHash` (sha256 over `{metrics, passPolicy, inputs}` as used), `weights`,
  `scale`, `passPolicy`, `primaryMetrics` (names with `primary: true`),
  `goldRule`, `goldIdsUsed`, `extractionRule`, `extraction`, `unevaluable`.
- `report.matcherResults` — one `method: "code-assertion"` row per metric
  (`role: "primary"` for metrics named by a `gates` policy, else `"observe"`),
  `actual` = value, `expected` = gate min (when gated), `score` = normalized
  value, and `details = { gold, goldTotal, predicted, predictedTotal, k?,
  extractionRule }` (id lists truncated to 20) — the Judge Evaluation tab lists
  the gold and predicted ids per row, highlighting predicted ids that are gold.
- `report.judgeMode: "deterministic"`; `llmJudgeReasoning` is cleared and
  `llmJudgeResponse` is `null` — no stale LLM output sits next to code-computed
  metrics. Only the latest judgement is kept (same policy as re-judging with an
  LLM evaluator).

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
import { rankedHit, rankedRecall, mrr } from '@opensearch-project/agent-health/metrics';

test('ranked retrieval', { prompt: 'find items related to the seed' }, async ({ result }) => {
  const gold = ['101', '202'];
  const ranked = result.trajectory
    .filter(s => s.type === 'tool_result' && s.toolName === 'search')
    .flatMap(s => JSON.parse(s.content).hits.map((h: { id: string }) => h.id));
  expect(rankedHit({ gold, ranked, k: 5 })).to.equal(1);
  expect(rankedRecall({ gold, ranked, k: 20 })).to.be.greaterThan(0);   // denominator: 'full-gold' (default)
  expect(mrr({ gold, ranked })).to.be.greaterThan(0);
});
```

Each function returns a number in `[0, 1]`, or `null` when the inputs are
unevaluable (empty gold / empty ranking) — check for `null` before asserting a
value.
