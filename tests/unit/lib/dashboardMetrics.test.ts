/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers just the app-wide per-agent color hook (`getAgentColor`), newly
 * relied upon by AgentBenchmarkDotPlot for "color coded for datapoints,
 * consistent palette with the rest of the app" (owner feedback). The rest
 * of lib/dashboardMetrics.ts is exercised indirectly by its consumers.
 */

import {
  AGENT_COLORS,
  aggregateMetricsByBenchmarkAgent,
  getAgentColor,
} from '@/lib/dashboardMetrics';

describe('getAgentColor', () => {
  it('honors an explicit AGENT_COLORS override', () => {
    expect(getAgentColor('demo')).toBe(AGENT_COLORS['demo']);
  });

  it('is deterministic for an unmapped key (same key -> same color, every call)', () => {
    const first = getAgentColor('claude-code-agent');
    for (let i = 0; i < 5; i++) {
      expect(getAgentColor('claude-code-agent')).toBe(first);
    }
  });

  it('is independent of any other agent being resolved in between (a hash, not a sorted-index assignment)', () => {
    const before = getAgentColor('agent-x');
    getAgentColor('agent-a');
    getAgentColor('agent-z');
    getAgentColor('zzz-agent');
    expect(getAgentColor('agent-x')).toBe(before);
  });

  it('assigns different colors to at least some of a varied set of agent keys (not a single flat fallback)', () => {
    const keys = ['pi-agent', 'claude-code-agent', 'kiro-agent', 'observio-sample-agent', 'my-custom-agent'];
    const colors = new Set(keys.map(getAgentColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('always returns a non-empty hex-ish color string for an arbitrary key', () => {
    expect(getAgentColor('')).toMatch(/^#/);
    expect(getAgentColor('some-very-long-agent-key-with-many-characters-in-it')).toMatch(/^#/);
  });
});

describe('dashboard pass-rate aggregation', () => {
  it('uses matcher verdicts and excludes reports with no verdict', () => {
    const benchmarks = [{
      id: 'benchmark-1',
      name: 'Benchmark',
      runs: [{ id: 'run-1', agentKey: 'demo', createdAt: '2026-01-01T00:00:00.000Z' }],
    }] as any;
    const reports = [
      {
        id: 'passed', experimentRunId: 'run-1', status: 'completed',
        metricsStatus: 'error', passFailStatus: null,
        matcherResults: [{ method: 'llm-judge', role: 'gate', pass: true, score: 1 }],
      },
      {
        id: 'failed', experimentRunId: 'run-1', status: 'completed',
        passFailStatus: 'failed', metrics: { accuracy: 0 },
      },
      {
        id: 'unjudged', experimentRunId: 'run-1', status: 'completed',
        metricsStatus: 'error', passFailStatus: null,
      },
    ] as any;

    const [result] = aggregateMetricsByBenchmarkAgent(benchmarks, reports, new Map());
    expect(result.avgPassRate).toBe(50);
    expect(result.runCount).toBe(1);
  });
});
