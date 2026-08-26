/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantContext } from '@/types';

/**
 * Derive the assistant page context from a URL (pathname + search). Pure and
 * dependency-free (no assistant-ui / react imports) so the URL→context
 * contract is unit-testable without mounting the route-heavy pages that host
 * the assistant.
 *
 * Routes we recognize:
 *   /benchmarks/:benchmarkId       → benchmarkId
 *   /runs/:runId                   → runId
 *   /traces/:traceId               → traceId
 *   /test-cases/:testCaseId        → testCaseId
 *   /compare/:benchmarkId?runs=a,b → benchmarkId + comparisonRunIds
 */
export function deriveAssistantContext(pathname: string, search: string): AssistantContext {
  const parts = pathname.split('/');
  const params = new URLSearchParams(search);

  // /compare/:benchmarkId carries the benchmark id in the URL too — the
  // original parser only looked for the literal "benchmarks" segment, which
  // meant the assistant got an empty context on the comparison page.
  const benchmarkFromCompare =
    parts.includes('compare') && parts.indexOf('compare') + 1 < parts.length
      ? parts[parts.indexOf('compare') + 1]
      : undefined;

  const runsParam = params.get('runs');
  const comparisonRunIds = runsParam
    ? runsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  return {
    currentUrl: pathname + (search || ''),
    benchmarkId: parts.includes('benchmarks')
      ? parts[parts.indexOf('benchmarks') + 1]
      : benchmarkFromCompare,
    runId: parts.includes('runs') ? parts[parts.indexOf('runs') + 1] : undefined,
    traceId: parts.includes('traces') ? parts[parts.indexOf('traces') + 1] : undefined,
    testCaseId: parts.includes('test-cases') ? parts[parts.indexOf('test-cases') + 1] : undefined,
    comparisonRunIds: comparisonRunIds && comparisonRunIds.length > 0 ? comparisonRunIds : undefined,
  };
}
