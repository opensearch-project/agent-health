/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contract of the `410 Gone` response served by
 * `POST /api/storage/benchmarks/:id/execute` now that the legacy
 * per-benchmark runner has been removed. Shared by the route and its tests
 * so the wire format is pinned in one place.
 */
export const LEGACY_EXECUTE_REMOVED = {
  code: 'LEGACY_EXECUTE_REMOVED',
  error:
    'POST /api/storage/benchmarks/:id/execute has been removed. ' +
    'Create the run with POST /api/storage/evaluation-runs ' +
    '(body: { sources: [{ type: "benchmark", benchmarkId }], agentKey, ... }) ' +
    'and poll GET /api/storage/evaluation-runs/:id for progress.',
  replacement: 'POST /api/storage/evaluation-runs',
  docs: 'docs/CLI.md#benchmark-execution-path',
  /** Absolute form of `docs` for the `Link: <…>; rel="deprecation"` header (RFC 9745 §3). */
  docsUrl: 'https://github.com/opensearch-project/agent-health/blob/main/docs/CLI.md#benchmark-execution-path',
  /** RFC 9745 `Deprecation` header: the route was deprecated with 0.7.0 (2026-09-17). */
  deprecationHeader: '@1789603200',
  /** RFC 8594 `Sunset` header: the date the route stopped executing runs. */
  sunsetHeader: 'Wed, 23 Sep 2026 00:00:00 GMT',
} as const;
