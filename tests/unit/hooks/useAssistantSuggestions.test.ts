/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the route classifier behind the assistant modal's
 * contextual suggestions + nudge.
 *
 * The hook itself (which uses React + sessionStorage + timers) is exercised
 * by the existing E2E suite. Here we lock in the route → suggestions/nudge
 * mapping that drives every other behaviour.
 */

import { classifyRoute, DEFAULT_SUGGESTIONS } from '@/hooks/useAssistantSuggestions';

describe('useAssistantSuggestions › classifyRoute', () => {
  it('returns default suggestions and no nudge for an unknown route', () => {
    const ctx = classifyRoute('/some/random/path');
    expect(ctx.key).toBe('default');
    expect(ctx.suggestions).toEqual(DEFAULT_SUGGESTIONS);
    expect(ctx.nudge).toBeUndefined();
  });

  it('classifies a run-detail page (e.g. /runs/:id) and produces a failure-aware nudge', () => {
    const ctx = classifyRoute('/runs/report-abc-123');
    expect(ctx.key).toBe('run-detail');
    expect(ctx.suggestions).toHaveLength(3);
    expect(ctx.suggestions.some((s) => /improvement strategies/i.test(s))).toBe(true);
    expect(ctx.nudge).toBeTruthy();
  });

  it('classifies the nested benchmark-run-detail path the same as a standalone run', () => {
    const ctx = classifyRoute('/benchmarks/bench-1/runs/run-2');
    expect(ctx.key).toBe('run-detail');
    expect(ctx.nudge).toBeTruthy();
  });

  it('classifies a benchmark-detail page', () => {
    const ctx = classifyRoute('/benchmarks/bench-1');
    expect(ctx.key).toBe('benchmark-detail');
    expect(ctx.suggestions.some((s) => /regress/i.test(s))).toBe(true);
    expect(ctx.nudge).toBeTruthy();
  });

  it('classifies the benchmarks-list page (no nudge — listing is low-context)', () => {
    const ctx = classifyRoute('/benchmarks');
    expect(ctx.key).toBe('benchmarks-list');
    expect(ctx.nudge).toBeUndefined();
  });

  it('classifies the traces page', () => {
    const ctx = classifyRoute('/traces');
    expect(ctx.key).toBe('traces');
    expect(ctx.suggestions.some((s) => /bottleneck/i.test(s))).toBe(true);
    expect(ctx.nudge).toBeTruthy();
  });

  it('classifies a test-case detail page', () => {
    const ctx = classifyRoute('/test-cases/tc-1');
    expect(ctx.key).toBe('test-case-detail');
    expect(ctx.suggestions.some((s) => /expected outcomes/i.test(s))).toBe(true);
  });

  it('classifies the settings page (no nudge)', () => {
    const ctx = classifyRoute('/settings');
    expect(ctx.key).toBe('settings');
    expect(ctx.nudge).toBeUndefined();
  });

  it('classifies the dashboard root', () => {
    const ctx = classifyRoute('/');
    expect(ctx.key).toBe('dashboard');
    expect(ctx.suggestions.some((s) => /focus on/i.test(s))).toBe(true);
    expect(ctx.nudge).toBeTruthy();
  });

  it('produces exactly 3 suggestions for every classified route', () => {
    const samples = [
      '/',
      '/benchmarks',
      '/benchmarks/x',
      '/benchmarks/x/runs/y',
      '/runs/r',
      '/traces',
      '/traces/abc',
      '/test-cases/tc',
      '/settings',
      '/something-else',
    ];
    for (const p of samples) {
      const ctx = classifyRoute(p);
      expect(ctx.suggestions).toHaveLength(3);
    }
  });

  describe('/evaluations/* (evals3) routes', () => {
    it('classifies /evaluations/benchmarks/:id/runs as a benchmark detail', () => {
      const ctx = classifyRoute('/evaluations/benchmarks/bench-1/runs');
      expect(ctx.key).toBe('benchmark-detail');
      expect(ctx.nudge).toBeTruthy();
    });

    it('classifies /evaluations/benchmarks/:id/runs/:rid/inspect as a run detail', () => {
      const ctx = classifyRoute('/evaluations/benchmarks/bench-1/runs/r-2/inspect');
      expect(ctx.key).toBe('run-detail');
    });

    it('classifies /evaluations/runs/:id as a run detail', () => {
      const ctx = classifyRoute('/evaluations/runs/r-1');
      expect(ctx.key).toBe('run-detail');
    });

    it('classifies /evaluations/benchmarks (list) without a nudge', () => {
      const ctx = classifyRoute('/evaluations/benchmarks');
      expect(ctx.key).toBe('benchmarks-list');
      expect(ctx.nudge).toBeUndefined();
    });

    it('classifies /evaluations/test-cases/:id as a test-case detail', () => {
      const ctx = classifyRoute('/evaluations/test-cases/tc-1');
      expect(ctx.key).toBe('test-case-detail');
    });

    it('classifies /agent-traces as traces', () => {
      const ctx = classifyRoute('/agent-traces');
      expect(ctx.key).toBe('traces');
    });
  });
});
