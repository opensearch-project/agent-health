/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Legacy (pre-evals3) route → evals3 route redirect table.
 *
 * The sidebar has only linked to `/evaluations/*` for a long time, but the
 * pre-evals3 pages (`/benchmarks`, `/benchmarks/:id/runs`, `/runs/:id`,
 * `/test-cases`, …) and the older evals3 run-detail page
 * (`/evaluations/runs/:id`, superseded by the run inspector at
 * `…/inspect`) stayed mounted and reachable by deep link — two UIs for the
 * same data, drifting apart. Every one of those routes now resolves to its
 * evals3 equivalent via `<Navigate replace>`; the components behind them
 * are deleted.
 *
 * `pattern` uses react-router path syntax; `to` is a template over the same
 * `:param` names, filled with react-router's `generatePath` (URL-encodes each
 * param, throws on a missing one). The query string is carried over untouched
 * so deep links like `?reportId=<id>` keep working on the inspector.
 *
 * NOTE: `/runs/:runId` is deliberately NOT in this table — that legacy route
 * took a *report* id (an `EvaluationReport`, one test case's result), not an
 * evaluation-run id, so it needs a lookup before it can be sent anywhere. See
 * `resolveReportRedirect` below / `ReportRedirect` in App.tsx.
 */
export interface LegacyRouteRedirect {
  /** react-router route pattern the legacy page was mounted on. */
  pattern: string;
  /** Destination template — `:param` tokens are filled from the match. */
  to: string;
}

export const legacyRouteRedirects: readonly LegacyRouteRedirect[] = [
  // Pre-evals3 pages
  { pattern: '/benchmarks', to: '/evaluations/benchmarks' },
  { pattern: '/benchmarks/:benchmarkId/runs', to: '/evaluations/benchmarks/:benchmarkId/runs' },
  { pattern: '/benchmarks/:benchmarkId/runs/:runId', to: '/evaluations/benchmarks/:benchmarkId/runs/:runId/inspect' },
  { pattern: '/benchmarks/*', to: '/evaluations/benchmarks' },
  { pattern: '/test-cases', to: '/evaluations/test-cases' },
  { pattern: '/test-cases/:testCaseId/runs', to: '/evaluations/test-cases/:testCaseId' },
  { pattern: '/test-cases/*', to: '/evaluations/test-cases' },
  // Even older aliases that used to redirect to the pre-evals3 pages (one hop now)
  { pattern: '/evals', to: '/evaluations/test-cases' },
  { pattern: '/run', to: '/evaluations/test-cases' },
  { pattern: '/reports', to: '/evaluations/benchmarks' },
  { pattern: '/experiments', to: '/evaluations/benchmarks' },
  { pattern: '/experiments/:benchmarkId/runs', to: '/evaluations/benchmarks/:benchmarkId/runs' },
  // Older evals3 run-detail page → run inspector
  { pattern: '/evaluations/runs/:runId', to: '/evaluations/runs/:runId/inspect' },
];

/**
 * The evals3 route for an individual report (`EvaluationReport`) — the id the
 * legacy `/runs/:runId` route used to take. Reports that belong to a run open
 * in the run inspector (benchmark-scoped when the benchmark is known, so
 * classic embedded `benchmark.runs[]` ids resolve too) with `?reportId=` so
 * the inspector preselects that case; standalone single-case reports — and
 * reports whose run no longer exists (`runReachable === false`; the inspector
 * would only render "not found" for those) — open on the test case's detail
 * page with `?run=` preselecting the run.
 *
 * `search` (the legacy URL's query string) is merged into the destination;
 * keys the destination itself sets win.
 */
export function resolveReportRedirect(
  report: { id: string; testCaseId: string; experimentId?: string; experimentRunId?: string },
  options: { runReachable?: boolean; search?: string } = {},
): string {
  const { runReachable = true, search = '' } = options;
  const reportId = encodeURIComponent(report.id);
  let target: string;
  if (report.experimentRunId && runReachable) {
    const runId = encodeURIComponent(report.experimentRunId);
    target = report.experimentId
      ? `/evaluations/benchmarks/${encodeURIComponent(report.experimentId)}/runs/${runId}/inspect?reportId=${reportId}`
      : `/evaluations/runs/${runId}/inspect?reportId=${reportId}`;
  } else {
    target = `/evaluations/test-cases/${encodeURIComponent(report.testCaseId)}?run=${reportId}`;
  }
  return mergeSearch(target, search);
}

/** Append the params of `search` to `target` without overriding keys `target` already sets. */
function mergeSearch(target: string, search: string): string {
  const extra = new URLSearchParams(search);
  if ([...extra.keys()].length === 0) return target;
  const [path, existing = ''] = target.split('?');
  const merged = new URLSearchParams(existing);
  extra.forEach((value, key) => { if (!merged.has(key)) merged.append(key, value); });
  return `${path}?${merged.toString()}`;
}

/** Path to a single test-case run on the evals3 test-case detail page. */
export const testCaseRunPath = (testCaseId: string, reportId: string): string =>
  `/evaluations/test-cases/${encodeURIComponent(testCaseId)}?run=${encodeURIComponent(reportId)}`;
