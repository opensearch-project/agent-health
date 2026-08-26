/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { deriveAssistantContext } from '@/hooks/assistantContext';

/**
 * Regression guard for the compare-page → assistant context contract.
 * (Replaces the former assistant-compare-context e2e, which was architecturally
 * flaky: the global assistant modal closes on client-side navigation and the
 * runs-heavy ComparisonPage churns the trigger in/out of the DOM. The logic
 * under test is pure URL parsing, so it belongs at the unit level.)
 */
describe('deriveAssistantContext', () => {
  it('parses benchmarkId + comparisonRunIds from /compare/:id?runs=a,b', () => {
    const ctx = deriveAssistantContext('/compare/bench-X', '?runs=run-A,run-B');
    expect(ctx.benchmarkId).toBe('bench-X');
    expect(ctx.comparisonRunIds).toEqual(['run-A', 'run-B']);
    expect(ctx.currentUrl).toBe('/compare/bench-X?runs=run-A,run-B');
  });

  it('sets benchmarkId but omits comparisonRunIds when ?runs= is absent', () => {
    const ctx = deriveAssistantContext('/compare/bench-X', '');
    expect(ctx.benchmarkId).toBe('bench-X');
    // Empty/missing runs must NOT serialize as [] — omitted/undefined.
    expect(ctx.comparisonRunIds).toBeUndefined();
  });

  it('trims blanks and drops empty entries in ?runs=', () => {
    const ctx = deriveAssistantContext('/compare/b', '?runs=a,%20,b,');
    expect(ctx.comparisonRunIds).toEqual(['a', 'b']);
  });

  it('parses the other recognized routes', () => {
    expect(deriveAssistantContext('/benchmarks/bm1', '').benchmarkId).toBe('bm1');
    expect(deriveAssistantContext('/runs/r1', '').runId).toBe('r1');
    expect(deriveAssistantContext('/traces/t1', '').traceId).toBe('t1');
    expect(deriveAssistantContext('/test-cases/tc1', '').testCaseId).toBe('tc1');
  });

  it('returns just currentUrl for an unrecognized route', () => {
    const ctx = deriveAssistantContext('/assistant', '');
    expect(ctx.currentUrl).toBe('/assistant');
    expect(ctx.benchmarkId).toBeUndefined();
    expect(ctx.comparisonRunIds).toBeUndefined();
  });
});
