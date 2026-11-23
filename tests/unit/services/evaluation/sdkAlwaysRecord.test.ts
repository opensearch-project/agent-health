/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the "always-record" helpers used by the code-SDK
 * deterministic path (services/evaluationRunner.ts / benchmarkRunner.ts).
 *
 * Bug (owner-hit, measurement-harness-defeating): chai's `expect()` is
 * fail-fast — the first failing assertion in a test body throws, so any
 * later `expect()`/`judge()`/`evaluate()` calls never execute. Pre-fix this
 * silently dropped objective, runner-owned actuals (token usage, USD cost)
 * that the body would otherwise have read off `result.traces` — an
 * optimizer reading these reports needs all four axes (accuracy, latency,
 * tokens, cost) even when one gate fails.
 *
 * `stampObjectiveActuals` closes that gap: it reads token/cost usage
 * straight from the runner's own TracesAccessor (bypassing the user's test
 * body entirely) and stamps it onto `report.performanceMetrics`.
 *
 * `appendNotReachedMarker` gives the matcher panel a way to show a
 * distinct row for the tail of a test that never ran, instead of silently
 * omitting it.
 */

import {
  stampObjectiveActuals,
  appendNotReachedMarker,
  computeSdkMatcherSessionMetrics,
} from '@/services/evaluation';
import { buildTracesAccessor, emptyTracesAccessor, unavailableTracesAccessor } from '@/lib/matchers/traces';
import type { MatcherResult } from '@/lib/matchers/types';
import type { TestCasePerformanceMetrics } from '@/types';
import type { Span } from '@/types';

const m = (overrides: Partial<MatcherResult>): MatcherResult => ({
  description: overrides.description ?? 'matcher',
  pass: overrides.pass ?? true,
  method: overrides.method ?? 'code-assertion',
  ...overrides,
});

describe('stampObjectiveActuals', () => {
  it('is a no-op when agent.run() was never called (hasCapturedResult=false)', () => {
    const perf: TestCasePerformanceMetrics = { durationMs: 0, agentDurationMs: 0 };
    stampObjectiveActuals(perf, buildTracesAccessor([]), false);
    expect(perf.totalTokens).toBeUndefined();
    expect(perf.totalCostUsd).toBeUndefined();
  });

  it('is a no-op when performanceMetrics is undefined (defensive)', () => {
    expect(() => stampObjectiveActuals(undefined, buildTracesAccessor([]), true)).not.toThrow();
  });

  // The headline regression: real, non-zero token/cost numbers survive
  // being stamped even though NOTHING in a test body ever read them —
  // this is exactly the "cost n/a" / "totalCost never recorded" symptom
  // from the bug report, fixed at the source (not dependent on the body
  // reaching a `traces.totalCost` matcher at all).
  it('stamps real non-zero totalTokens/totalCostUsd straight from the TracesAccessor', () => {
    const spans: Span[] = [
      {
        traceId: 't1', spanId: 's1', name: 'llm-call', startTimeUnixNano: 0, endTimeUnixNano: 1_000_000,
        attributes: {
          'gen_ai.usage.prompt_tokens': 1200,
          'gen_ai.usage.completion_tokens': 340,
          'gen_ai.usage.cost_usd': 0.0421,
        },
      } as unknown as Span,
    ];
    const perf: TestCasePerformanceMetrics = { durationMs: 500, agentDurationMs: 500 };
    stampObjectiveActuals(perf, buildTracesAccessor(spans), true);
    expect(perf.totalTokens).toBe(1540);
    expect(perf.totalCostUsd).toBeCloseTo(0.0421, 6);
    // durationMs/agentDurationMs (already-working fields) must be untouched.
    expect(perf.durationMs).toBe(500);
    expect(perf.agentDurationMs).toBe(500);
  });

  it('stamps legitimate zeros when useTraces=false (emptyTracesAccessor) — distinct from "unset"', () => {
    const perf: TestCasePerformanceMetrics = { durationMs: 10, agentDurationMs: 10 };
    stampObjectiveActuals(perf, emptyTracesAccessor(), true);
    expect(perf.totalTokens).toBe(0);
    expect(perf.totalCostUsd).toBe(0);
  });

  it('leaves totalTokens/totalCostUsd UNSET (not 0) when the accessor is the loud-failure kind', () => {
    // useTraces: true but spans never arrived (#230 semantics) — every read
    // throws. Writing 0 here would misleadingly assert "no cost incurred";
    // the correct behavior is "we don't know", i.e. leave it unset.
    const perf: TestCasePerformanceMetrics = { durationMs: 10, agentDurationMs: 10 };
    stampObjectiveActuals(perf, unavailableTracesAccessor('no spans found'), true);
    expect(perf.totalTokens).toBeUndefined();
    expect(perf.totalCostUsd).toBeUndefined();
  });

  it('survives being called AFTER a simulated mid-body throw — the whole point of the fix', () => {
    // Simulates the runner's call site: the traces accessor was loaded
    // before the (simulated) throw, and stamping happens unconditionally
    // afterwards regardless of what happened in between.
    const spans: Span[] = [
      { traceId: 't', spanId: 's', name: 'x', attributes: { 'gen_ai.usage.prompt_tokens': 100, 'gen_ai.usage.cost_usd': 0.5 } } as unknown as Span,
    ];
    const loadedTraces = buildTracesAccessor(spans);
    const perf: TestCasePerformanceMetrics = { durationMs: 1, agentDurationMs: 1 };
    let evalError: unknown;
    try {
      throw new Error('token gate failed');
    } catch (err) {
      evalError = err;
    }
    expect(evalError).toBeDefined();
    stampObjectiveActuals(perf, loadedTraces, true);
    expect(perf.totalCostUsd).toBe(0.5);
  });
});

describe('appendNotReachedMarker', () => {
  it('is a no-op when there is no evalError', () => {
    const results: MatcherResult[] = [m({ pass: true })];
    appendNotReachedMarker(results, undefined, false);
    expect(results).toHaveLength(1);
  });

  it('is a no-op for an agent crash (agentFailed=true) — no coherent "test body" to speak of', () => {
    const results: MatcherResult[] = [];
    appendNotReachedMarker(results, new Error('subprocess timed out'), true);
    expect(results).toHaveLength(0);
  });

  it('appends exactly one distinctly-flagged entry when the body threw', () => {
    const results: MatcherResult[] = [m({ pass: false, description: 'token gate' })];
    appendNotReachedMarker(results, new Error('token gate failed'), false);
    expect(results).toHaveLength(2);
    const marker = results[1];
    expect(marker.notReached).toBe(true);
    expect(marker.pass).toBe(false);
    expect(marker.errorMessage).toBe('token gate failed');
  });

  it('stringifies a non-Error evalError', () => {
    const results: MatcherResult[] = [];
    appendNotReachedMarker(results, 'boom', false);
    expect(results[0].errorMessage).toBe('boom');
  });
});

describe('computeSdkMatcherSessionMetrics — excludes notReached markers from the gate denominator', () => {
  // Metrics exist only when a judge() call ran (code-assertion-only bodies
  // get `{}`), so the passing gate here is a judged claim.
  it('a notReached entry does not count against accuracy (1 passing gate + 1 notReached → 100, not 50)', () => {
    const res = computeSdkMatcherSessionMetrics([
      m({ pass: true, method: 'llm-judge' }),
      m({ pass: false, notReached: true }),
    ]);
    expect(res.accuracy).toBe(100);
  });

  it('mirrors the existing observe/errored exclusions — notReached is excluded the same way', () => {
    const withMarker = computeSdkMatcherSessionMetrics([
      m({ pass: true, method: 'llm-judge' }),
      m({ pass: true }),
      m({ pass: false, notReached: true }),
    ]);
    const withoutMarker = computeSdkMatcherSessionMetrics([
      m({ pass: true, method: 'llm-judge' }),
      m({ pass: true }),
    ]);
    expect(withMarker).toEqual(withoutMarker);
  });
});
