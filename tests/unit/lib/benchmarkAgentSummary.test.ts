/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for lib/benchmarkAgentSummary — per-agent latest/trend/history
 * for the Benchmarks list page. The invariant under test: a run is never
 * compared with a run of a different agent (owner bug 11-18: two agents on
 * one benchmark collapsed into one row whose trend compared agent A's latest
 * with agent B's previous run).
 */

import type { BenchmarkRun } from '@/types';
import {
  agentIdentityKey, agentIdentityLabels, endpointHost, computeRunScore, trendBetween,
  summarizeRunsByAgent,
} from '@/lib/benchmarkAgentSummary';

const NAMES: Record<string, string> = { 'agent-a': 'Agent A', 'agent-b': 'Agent B', 'agent-c': 'Agent C' };
const nameFor = (k: string) => NAMES[k] || k;

function run(id: string, agentKey: string, createdAt: string, passed: number, total: number, extra: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id, name: id, agentKey, modelId: 'm', createdAt, status: 'completed', results: {},
    stats: { total, passed, failed: total - passed, errored: 0, pending: 0, running: 0 } as any,
    ...extra,
  } as BenchmarkRun;
}

describe('agentIdentityKey / endpointHost / agentIdentityLabels', () => {
  it('is the bare agentKey without an endpoint override and key@endpoint with one', () => {
    expect(agentIdentityKey({ agentKey: 'agent-a' })).toBe('agent-a');
    expect(agentIdentityKey({ agentKey: 'agent-a', agentEndpoint: 'https://b.example.com/v1' })).toBe('agent-a@https://b.example.com/v1');
    expect(agentIdentityKey({})).toBe('');
  });

  it('cannot collide two different (key, endpoint) pairs even when a key contains "@"', () => {
    const a = agentIdentityKey({ agentKey: 'a@https://b', agentEndpoint: undefined });
    const b = agentIdentityKey({ agentKey: 'a', agentEndpoint: 'https://b' });
    const c = agentIdentityKey({ agentKey: 'a@x', agentEndpoint: 'https://b' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('extracts the host (with port) and passes non-URLs through', () => {
    expect(endpointHost('https://a.example.com:8443/v1/chat')).toBe('a.example.com:8443');
    expect(endpointHost('not a url')).toBe('not a url');
  });

  it('labels with the plain name unless the same key has ≥2 endpoints, then `Name (host)`', () => {
    const runs = [
      { agentKey: 'agent-a' },
      { agentKey: 'agent-a', agentEndpoint: 'https://staging.example.com/agent' },
      { agentKey: 'agent-b', agentEndpoint: 'https://only.example.com/agent' }, // one endpoint → no suffix
      { agentKey: 'agent-c' },
    ];
    const labels = agentIdentityLabels(runs, nameFor);
    expect(labels.get('agent-a')).toBe('Agent A (default endpoint)');
    expect(labels.get('agent-a@https://staging.example.com/agent')).toBe('Agent A (staging.example.com)');
    expect(labels.get('agent-b@https://only.example.com/agent')).toBe('Agent B');
    expect(labels.get('agent-c')).toBe('Agent C');
  });

  it('falls back to the full endpoint when two endpoints of one key share a host', () => {
    const labels = agentIdentityLabels([
      { agentKey: 'agent-a', agentEndpoint: 'https://h.example.com/v1' },
      { agentKey: 'agent-a', agentEndpoint: 'https://h.example.com/v2' },
    ], nameFor);
    expect([...labels.values()].sort()).toEqual(['Agent A (https://h.example.com/v1)', 'Agent A (https://h.example.com/v2)']);
  });
});

describe('computeRunScore / trendBetween', () => {
  it('is the pass rate over judged cases (results first, stats fallback), null when nothing was judged', () => {
    expect(computeRunScore(run('r', 'agent-a', '2026-01-01T00:00:00Z', 3, 4))).toBe(75);
    expect(computeRunScore(run('r', 'agent-a', '2026-01-01T00:00:00Z', 1, 3, { stats: { total: 3, passed: 1, failed: 0, errored: 2 } as any }))).toBe(100);
    expect(computeRunScore(run('r', 'agent-a', '2026-01-01T00:00:00Z', 0, 2, { stats: { total: 2, passed: 0, failed: 0, errored: 2 } as any }))).toBeNull();
    expect(computeRunScore({ ...run('r', 'agent-a', '2026-01-01T00:00:00Z', 0, 0), stats: undefined })).toBeNull();
    // Results win over stale denormalized stats (same source of truth as the Runs tab).
    const results = { t1: { reportId: 'r', status: 'completed', passFailStatus: 'passed' }, t2: { reportId: 'r', status: 'completed', passFailStatus: 'failed' }, t3: { reportId: 'r', status: 'completed', passFailStatus: 'failed' } } as any;
    expect(computeRunScore(run('r', 'agent-a', '2026-01-01T00:00:00Z', 3, 3, { results }))).toBe(33);
  });

  it('is improving/regressing beyond ±5 points, stable inside, unknown without a previous score', () => {
    expect(trendBetween(60, 50)).toBe('improving');
    expect(trendBetween(44, 50)).toBe('regressing');
    expect(trendBetween(54, 50)).toBe('stable');
    expect(trendBetween(50, undefined)).toBe('unknown');
    expect(trendBetween(null, 50)).toBe('unknown');
  });
});

describe('summarizeRunsByAgent', () => {
  // Interleaved timestamps: the newest run (A, 31/62) follows a run of a
  // DIFFERENT agent (B, 27/62). A's own previous run was 45/62.
  const runs = [
    run('a-old', 'agent-a', '2026-11-01T00:00:00Z', 45, 62),
    run('b-old', 'agent-b', '2026-11-02T00:00:00Z', 10, 62),
    run('b-new', 'agent-b', '2026-11-03T00:00:00Z', 27, 62),
    run('a-new', 'agent-a', '2026-11-04T00:00:00Z', 31, 62),
    run('c-only', 'agent-c', '2026-11-02T12:00:00Z', 62, 62),
  ];

  it('produces one summary per agent, most recently active first, each with its own latest result', () => {
    const s = summarizeRunsByAgent(runs, nameFor);
    expect(s.map(x => x.agentId)).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(s[0]).toMatchObject({ label: 'Agent A', runCount: 2, passed: 31, failed: 31, total: 62, latestScore: 50 });
    expect(s[0].latestRun.id).toBe('a-new');
    expect(s[1]).toMatchObject({ label: 'Agent B', runCount: 2, passed: 27, total: 62 });
    expect(s[2]).toMatchObject({ label: 'Agent C', runCount: 1, latestScore: 100, trend: 'unknown' });
  });

  it('never compares an agent with another agent: trend and sparkline are per agent', () => {
    const s = summarizeRunsByAgent(runs, nameFor);
    // Old code: 31/62 after B's 27/62 → "improving". A's own previous run was 45/62 → regressing.
    expect(s[0].trend).toBe('regressing');
    expect(s[0].passRateHistory).toEqual([73, 50]);
    // B went 10 → 27 of 62: improving on its own history, no A points interleaved.
    expect(s[1].trend).toBe('improving');
    expect(s[1].passRateHistory).toEqual([16, 44]);
  });

  it('treats two endpoints of one agentKey as two agents with host-suffixed labels', () => {
    const s = summarizeRunsByAgent([
      run('a-prod', 'agent-a', '2026-11-01T00:00:00Z', 50, 62, { agentEndpoint: 'https://prod.example.com/agent' }),
      run('a-stg', 'agent-a', '2026-11-02T00:00:00Z', 20, 62, { agentEndpoint: 'https://staging.example.com/agent' }),
    ], nameFor);
    expect(s).toHaveLength(2);
    expect(s.map(x => x.label)).toEqual(['Agent A (staging.example.com)', 'Agent A (prod.example.com)']);
    expect(s.map(x => x.trend)).toEqual(['unknown', 'unknown']); // one run each → nothing to compare
  });

  it('derives counts from results when a run has no denormalized stats, and omits unjudged runs from the history', () => {
    const noStats = {
      ...run('x', 'agent-a', '2026-11-01T00:00:00Z', 0, 0), stats: undefined,
      results: { t1: { reportId: 'r', status: 'completed', passFailStatus: 'passed' }, t2: { reportId: 'r', status: 'failed' } } as any,
    };
    const errored = run('y', 'agent-a', '2026-11-02T00:00:00Z', 0, 2, { stats: { total: 2, passed: 0, failed: 0, errored: 2 } as any });
    const [s] = summarizeRunsByAgent([noStats, errored], nameFor);
    expect(s).toMatchObject({ passed: 0, failed: 0, total: 2, latestScore: null, trend: 'unknown' });
    // The errored run contributes no point — plotting it as 0% would fake a regression.
    expect(s.passRateHistory).toEqual([50]);
  });

  it('returns an empty list for no runs', () => {
    expect(summarizeRunsByAgent([], nameFor)).toEqual([]);
  });
});
