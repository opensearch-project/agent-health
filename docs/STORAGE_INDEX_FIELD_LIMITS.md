# Storage: OpenSearch index field-limit growth (`evals_runs`)

## Incident

Owner-hit while running code-QA benchmarks: report/run persistence on the
shared cluster's `evals_runs` index failed with

```
illegal_argument_exception: Limit of total fields [5000] has been exceeded
```

Run **execution** succeeded — only the **write** errored out, i.e. data loss
(the completed report was never persisted).

This is the same *class* of bug PR #418 fixed for `evals_experiments`
(`EvaluationRun.results` / `testCaseSnapshots`): OpenSearch's default dynamic
mapping mints a new mapped field for every previously-unseen key under a
free-form object, and the field-count budget (`index.mapping.total_fields.limit`)
is **shared across every document in the index**, not per-document. #418 did
not cover `evals_runs` (the report/`TestCaseRun` index used by the code-SDK
path) — this fix does.

## Root cause: two unprotected growth vectors in `evals_runs`

Both are driven by the same source: `EvaluationMetrics`
(`types/index.ts`) is an open index signature (`[key: string]: number |
undefined`) by design — custom/system evaluators declare arbitrary metric
dimension names via `evaluator.scoringConfig.metrics`
(`server/services/judgeResponseParser.ts`'s `extractMetrics()`,
`services/storage/asyncRunStorage.ts`'s `storedMetricsToApp()` /
`toStorageFormat()` — see the comments in both, which explicitly call out
"preserve every metric the judge emitted, not just the four legacy keys").
Every *distinct* custom metric name, across every run/matcher ever written,
used to mint a brand-new mapped field, shared index-wide, forever.

| Field (in `evals_runs`) | Shape | Growth vector |
|---|---|---|
| `metrics` (report-level) | `Record<string, number>` | One set of dynamic names per run — one custom evaluator with N metric names adds ≤N new fields **the first time it's seen**, but a code-QA benchmark suite iterating on many custom evaluators over time accumulates without bound. |
| `matcherResults[].judgeMetrics` | `Record<string, number>`, nested inside a `nested`-typed array | Same growth, but **per SDK `judge()` call** — a single code-QA test case with many `expect`/`judge()` claims × many custom judge dimensions multiplies fast. This is the "code-SDK path" referenced in the incident — `matcherResults` is populated exclusively by the code-based test SDK (`docs/SDK.md`), not the legacy UI-driven runner. |

Everything else already flagged in the original bug report — matcher
`actual`/`expected`, `trajectory`, `logs`, `rawEvents`, `improvementStrategies`,
`spans` (span attributes) — was **already** `{ type: 'object', enabled: false
}` in `server/constants/indexMappings.ts` before this change (audited, not
touched). `llmJudgeResponse` (which itself has an open `extraFields`/
`parsedMetrics` shape) is **never persisted** to `evals_runs` at all
(`toStorageFormat()` doesn't include it) — confirmed via `git grep
llmJudgeResponse services/storage server/adapters`, no hits — so it isn't a
growth vector for this index either.

## Fix (mirrors #418's pattern)

`server/constants/indexMappings.ts`, `evals_runs` index:

```diff
   metrics: {
+    dynamic: false,
     properties: {
       accuracy: { type: 'float' },
       faithfulness: { type: 'float' },
       latency_score: { type: 'float' },
       trajectory_alignment_score: { type: 'float' },
     },
   },
   ...
   matcherResults: {
     type: 'nested',
     properties: {
       ...
       judgeMetrics: {
+        dynamic: false,
         properties: {
           accuracy: { type: 'float' },
           faithfulness: { type: 'float' },
           latency_score: { type: 'float' },
           trajectory_alignment_score: { type: 'float' },
         },
       },
     },
   },
```

Unlike #418's `results`/`testCaseSnapshots` (`enabled: false`, fully opaque),
this uses `dynamic: false` **with explicit typed sub-properties** for the
four legacy metric names — they stay real, typed, queryable fields (nothing
queries them today — see the audit below — but it's free to keep them typed),
while every *other* metric/dimension name is stored in `_source` (readable,
unaffected) but never added to the mapping. `_source` is unaffected either
way — the choice between `enabled:false` and `dynamic:false` only changes
what OpenSearch can filter/sort/aggregate on, never what's persisted or
returned.

## Query audit — nothing queried becomes unsearchable

Every OpenSearch-level query/filter/sort/aggregation against `evals_runs`
(`server/adapters/opensearch/StorageModule.ts`'s `OpenSearchRunOperations`)
was enumerated. None touch `metrics.*` or `matcherResults[].judgeMetrics.*`
beyond the four legacy names, which stay mapped:

| Consumer | Query | Fields used | Affected by this fix? |
|---|---|---|---|
| `OpenSearchRunOperations.search()` | `term` filters | `experimentId`, `experimentRunId`, `testCaseId`, `agentId`, `modelId`, `status`, `passFailStatus` | No — untouched, still explicit `keyword` fields |
| `OpenSearchRunOperations.search()` | `range` filter | `createdAt` | No — untouched, still `date` |
| `OpenSearchRunOperations.getAll()` / `.search()` | `sort` | `createdAt` | No |
| `OpenSearchRunOperations.countsByTestCase()` | `terms` agg | `testCaseId` | No |
| `asyncRunStorage.ts` `SearchQuery.minAccuracy` | **application-level** `Array.filter()`, not an OpenSearch query (`reports.filter(r => r.metrics.accuracy >= ...)`) | `metrics.accuracy` (read from `_source` in JS) | No — reads the value out of `_source`, which is unaffected by `dynamic: false`. If this were ever converted to a server-side `range` query, it would still work: `accuracy` stays an explicitly mapped, queryable field. |
| UI (`MatcherResultsPanel.tsx`, `JudgeSection.tsx`, `RunDetailsContent.tsx`) | none — reads `matcherResults`/`judgeMetrics` out of the fetched JSON document, never issues its own OpenSearch query | n/a | No |
| `services/evaluation/index.ts`, `services/evaluation/runSingleUseCase.ts`, `services/hookOrchestrator.ts` | none — same, in-process consumption of the already-fetched report | n/a | No |

Conclusion: **no consumer anywhere issues an OpenSearch-side query against a
non-legacy `metrics.*` or `judgeMetrics.*` name.** Both are read back via
`_source` wherever consumed (search, list, comparison, UI). This mirrors
exactly the trade-off #418 already made and documented for
`EvaluationRun.results`.

## Migration story — what to run, exactly

**Nothing runs automatically against the live cluster from this PR.**

### New / fresh indexes

No action needed. `ensureIndexes()` (`server/services/indexInitializer.ts`,
called on every server boot and on "attach new cluster") creates any missing
index straight from the updated `INDEX_MAPPINGS` — new deployments and any
environment that doesn't have `evals_runs` yet get the fix immediately.

### Existing, NOT-YET-poisoned `evals_runs` (most environments)

Also no action needed, but not immediate — `ensureIndexes()` also calls
`client.indices.putMapping()` on every boot for existing indexes, which is
how the `dynamic: false` fix reaches an already-existing-but-clean index: it
succeeds silently and the index is protected from the next write onward.

### The shared cluster's `evals_runs`, if already poisoned

If any code-QA benchmark run already wrote a custom evaluator metric name to
the shared cluster before this fix ships, `evals_runs.metrics` (and/or
`matcherResults.judgeMetrics`) already has real, dynamically-inferred
sub-properties. OpenSearch's `putMapping` **rejects** an `enabled`/`dynamic`
change on a field that already has sub-properties
(`mapper_exception: the [dynamic] parameter can't be updated for the object
mapping [metrics]`) — `ensureIndexes()` catches this, logs a warning, and
otherwise no-ops (no crash, no data loss, same as #418's documented
`mapper_exception` handling for `results`). **The index keeps growing** until
an explicit reindex is run.

**This is not new migration code** — the existing generic reindex mechanism
(`reindexSingleIndex()`, `server/services/mappingFixer.ts`, already shipped
and already exposed at `POST /api/storage/reindex`, `server/routes/storage/admin.ts`)
already recreates any `INDEX_MAPPINGS`-registered index from scratch and
copies every document across, which sheds a poisoned mapping's dynamically-
inferred sub-fields while preserving 100% of the underlying `_source` data
(proven in `tests/integration/services/storage/evalsRunsMappingMigrationRecipe.integration.test.ts`,
run against a real OpenSearch container with a deliberately-poisoned index).

**The owner's exact recipe, when ready to run it against the shared cluster:**

```bash
# 1. Confirm the target index actually needs it (optional sanity check):
curl -s -X GET "$OPENSEARCH_STORAGE_ENDPOINT/evals_runs/_mapping" \
  -u "$OPENSEARCH_STORAGE_USERNAME:$OPENSEARCH_STORAGE_PASSWORD" \
  | jq '.evals_runs.mappings.properties.metrics'
# If this prints a `dynamic` key, it's already fixed. If it prints only
# `properties` with more than the 4 legacy metric names, it's poisoned.

# 2. Run the reindex via the running server's admin API (recreates the
#    index from the current INDEX_MAPPINGS and copies every document
#    across; the same doc-count-validated, recovery-safe path
#    reindexSingleIndex() has always used for keyword-type mismatch fixes):
curl -s -X POST "http://localhost:4001/api/storage/reindex" \
  -H 'Content-Type: application/json' \
  -d '{"index": "evals_runs"}'
```

Caveats to read before running this against the shared cluster:

- **No write lock during a manual `/api/storage/reindex` call.** The
  auto-fix boot path (`fixIndexMappings()`) acquires a process-local
  migration lock around the reindex; the manual admin route calls
  `reindexSingleIndex()` directly and does **not** (pre-existing gap in
  `server/routes/storage/admin.ts`, not introduced by this PR — flagged here,
  not fixed, since it's out of scope for this change). Run it during a quiet
  window (no in-flight evaluation runs writing reports) to avoid a write
  racing the index delete/recreate step.
- It touches only `evals_runs`. The already-known-poisoned `evals_experiments`
  (800+ stale `results.*` fields, per the incident notes) uses the identical
  recipe (`{"index": "evals_experiments"}`) — that cleanup is separately
  planned by ops; this PR does not touch or schedule it.
- Document count is validated before the temporary index is deleted; if the
  copy-back count doesn't match, the error message names the surviving temp
  index (`evals_runs_reindex_temp`) for manual recovery — nothing is deleted
  until the counts are confirmed equal.

## Tests

- Unit (`tests/unit/server/constants/indexMappings.test.ts`): mapping-shape
  assertions — `dynamic: false` + typed legacy properties on both `metrics`
  and `matcherResults.judgeMetrics`; pre-existing `enabled:false` fields stay
  disabled; every field `OpenSearchRunOperations.search()` queries stays
  explicitly mapped.
- Integration, real OpenSearch
  (`tests/integration/services/storage/testCaseRunMetricsMappingGrowth.integration.test.ts`):
  writes one report with 1000+ distinct custom `metrics`/`judgeMetrics` names
  (500 report-level + 125 `judge()` calls × 4 dimensions), asserts it
  round-trips correctly and the index's total mapped-field count does not
  grow; asserts the query-audit fields stay queryable.
- Integration, real OpenSearch, migration recipe
  (`tests/integration/services/storage/evalsRunsMappingMigrationRecipe.integration.test.ts`):
  deliberately poisons a throwaway index the old way, runs the *existing*
  `reindexSingleIndex()`, asserts the mapping resets to `dynamic: false` and
  all document data survives byte-for-byte.

Both integration suites skip gracefully (with a console warning) if no
OpenSearch cluster is reachable at `TEST_OPENSEARCH_ENDPOINT` (default
`http://localhost:9200`) — the unit suite covers the mapping-shape assertions
unconditionally.
