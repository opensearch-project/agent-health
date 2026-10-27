/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical run-report path for a run surfaced on the compare page — always
 * the run inspector.
 *
 * Benchmark runs (embedded in a benchmark's `runs[]`) resolve at
 * `/evaluations/benchmarks/:benchmarkId/runs/:runId/inspect`; everything else —
 * ad-hoc / SDK eval-runs, or runs whose `benchmarkId` is merely a label — goes
 * to the bare `/evaluations/runs/:runId/inspect` route (the benchmark route
 * would 404/redirect for those, and the bare route 404s for classic embedded
 * benchmark run ids). The older `/evaluations/runs/:runId` detail page is
 * retired (it now redirects here).
 *
 * Shared by the scoreboard's run-name link, its "Open run" icon, and the
 * per-case table's run headers so the three can never disagree. Callers pass
 * the benchmarkId from `ComparisonPage`'s `runBenchmarkIdById` map (which is
 * `undefined` unless the run is a real benchmark member).
 */
export const runReportPath = (runId: string, benchmarkId?: string): string =>
  benchmarkId
    ? `/evaluations/benchmarks/${encodeURIComponent(benchmarkId)}/runs/${encodeURIComponent(runId)}/inspect`
    : `/evaluations/runs/${encodeURIComponent(runId)}/inspect`;
