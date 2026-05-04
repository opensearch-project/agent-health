/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildPulseData, buildRadarData, getTrend, EvalTrendPoint } from '@/components/codingAgents/PerformancePulse';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function makeStats(agents: Array<{ agent: string; sessions: number; toolSuccess: number; completed: number; avgMinutes: number; daily: Array<{ date: string; sessionCount: number; messageCount: number; toolCallCount: number }> }>) {
  return {
    agents: agents.map(a => ({
      agent: a.agent,
      totalSessions: a.sessions,
      totalCost: 10,
      totalCacheSavings: 0,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalToolCalls: 100,
      totalToolErrors: 5,
      toolSuccessRate: a.toolSuccess,
      completedSessions: a.completed,
      costPerCompletion: 1.5,
      activeDays: 5,
      avgSessionMinutes: a.avgMinutes,
      dailyActivity: a.daily,
    })),
    dailyActivity: [],
    totalCost: 20,
    totalSessions: agents.reduce((s, a) => s + a.sessions, 0),
    totalTokens: 3000,
    wastedCost: 2,
    abandonedSessions: 1,
  };
}

function makeEfficiency(agents: Array<{ agent: string; toolSuccess: number; completion: number; costPer: number; sessions: number }>) {
  return {
    agents: agents.map(a => ({
      agent: a.agent,
      toolSuccessRate: a.toolSuccess,
      completedSessions: Math.round(a.sessions * a.completion),
      totalSessions: a.sessions,
      completionRate: a.completion,
      costPerCompletion: a.costPer,
      totalToolErrors: 5,
      totalToolCalls: 100,
    })),
    combined: { toolSuccessRate: 0.95, completionRate: 0.8, avgCostPerCompletion: 1.5 },
  };
}

// ─── getTrend ───────────────────────────────────────────────────────────────

describe('getTrend', () => {
  it('returns flat for empty or single-element arrays', () => {
    expect(getTrend([])).toBe('flat');
    expect(getTrend([50])).toBe('flat');
  });

  it('returns up when values increase > 5%', () => {
    expect(getTrend([10, 11, 12, 13, 14, 15, 16])).toBe('up');
  });

  it('returns down when values decrease > 5%', () => {
    expect(getTrend([16, 15, 14, 13, 12, 11, 10])).toBe('down');
  });

  it('returns flat when change is within ±5%', () => {
    expect(getTrend([100, 101, 100, 99, 100, 101, 100])).toBe('flat');
  });

  it('handles all zeros gracefully', () => {
    expect(getTrend([0, 0, 0, 0])).toBe('flat');
  });

  it('returns up when starting from zero and going positive', () => {
    expect(getTrend([0, 0, 1, 2, 3])).toBe('up');
  });
});

// ─── buildPulseData ─────────────────────────────────────────────────────────

describe('buildPulseData', () => {
  const stats = makeStats([
    {
      agent: 'claude-code',
      sessions: 10,
      toolSuccess: 0.95,
      completed: 8,
      avgMinutes: 15,
      daily: [
        { date: '2026-05-01', sessionCount: 3, messageCount: 20, toolCallCount: 50 },
        { date: '2026-05-02', sessionCount: 4, messageCount: 25, toolCallCount: 60 },
        { date: '2026-05-03', sessionCount: 3, messageCount: 18, toolCallCount: 40 },
      ],
    },
  ]);

  it('creates one data point per unique date', () => {
    const result = buildPulseData(stats, null, null);
    expect(result).toHaveLength(3);
    expect(result[0].date).toBe('2026-05-01');
    expect(result[2].date).toBe('2026-05-03');
  });

  it('includes tool success rate as percentage', () => {
    const result = buildPulseData(stats, null, null);
    expect(result[0]['claude-code_toolSuccess']).toBe(95);
  });

  it('includes completion rate as percentage', () => {
    const result = buildPulseData(stats, null, null);
    // 8/10 = 80%
    expect(result[0]['claude-code_completion']).toBe(80);
  });

  it('handles null costs gracefully', () => {
    const result = buildPulseData(stats, null, null);
    expect(result[0]['claude-code_cost']).toBeUndefined();
  });

  it('layers in cost data when available', () => {
    const costs = {
      total_cost: 5,
      total_savings: 0,
      models: [],
      by_project: [],
      daily_costs: [
        { date: '2026-05-01', cost: 1.50, agent: 'claude-code' },
        { date: '2026-05-02', cost: 2.00, agent: 'claude-code' },
      ],
    };
    const result = buildPulseData(stats, costs, null);
    expect(result[0]['claude-code_cost']).toBe(1.50);
    expect(result[1]['claude-code_cost']).toBe(2.00);
  });

  it('layers in eval trends when available', () => {
    const evalTrends: EvalTrendPoint[] = [
      { date: '2026-05-01', agentKey: 'claude-code', passRate: 85, runCount: 5 },
    ];
    const result = buildPulseData(stats, null, evalTrends);
    expect(result[0]['claude-code_evalPass']).toBe(85);
  });

  it('handles empty eval trends (no eval data)', () => {
    const result = buildPulseData(stats, null, []);
    expect(result[0]['claude-code_evalPass']).toBeUndefined();
  });

  it('sorts results by date ascending', () => {
    const result = buildPulseData(stats, null, null);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].date >= result[i - 1].date).toBe(true);
    }
  });
});

// ─── buildRadarData ─────────────────────────────────────────────────────────

describe('buildRadarData', () => {
  const efficiency = makeEfficiency([
    { agent: 'claude-code', toolSuccess: 0.95, completion: 0.80, costPer: 1.5, sessions: 10 },
    { agent: 'kiro', toolSuccess: 0.90, completion: 0.70, costPer: 2.0, sessions: 8 },
  ]);

  const stats = makeStats([
    { agent: 'claude-code', sessions: 10, toolSuccess: 0.95, completed: 8, avgMinutes: 10, daily: [] },
    { agent: 'kiro', sessions: 8, toolSuccess: 0.90, completed: 6, avgMinutes: 20, daily: [] },
  ]);

  it('returns 4 dimensions when no eval data', () => {
    const result = buildRadarData(efficiency, stats, null);
    expect(result).toHaveLength(4);
    expect(result.map(r => r.dimension)).toEqual(['Tool Success', 'Completion', 'Cost Efficiency', 'Speed']);
  });

  it('returns 5 dimensions when eval data exists', () => {
    const evalTrends: EvalTrendPoint[] = [
      { date: '2026-05-01', agentKey: 'claude-code', passRate: 90, runCount: 5 },
    ];
    const result = buildRadarData(efficiency, stats, evalTrends);
    expect(result).toHaveLength(5);
    expect(result[4].dimension).toBe('Eval Pass');
  });

  it('normalizes tool success as percentage', () => {
    const result = buildRadarData(efficiency, stats, null);
    const toolSuccess = result.find(r => r.dimension === 'Tool Success')!;
    expect(toolSuccess['claude-code']).toBe(95);
    expect(toolSuccess['kiro']).toBe(90);
  });

  it('inverts cost efficiency (lower cost = higher score)', () => {
    const result = buildRadarData(efficiency, stats, null);
    const costEff = result.find(r => r.dimension === 'Cost Efficiency')!;
    // claude-code has lower cost ($1.5) than kiro ($2.0), so should score higher
    expect((costEff['claude-code'] as number) > (costEff['kiro'] as number)).toBe(true);
  });

  it('inverts speed (faster = higher score)', () => {
    const result = buildRadarData(efficiency, stats, null);
    const speed = result.find(r => r.dimension === 'Speed')!;
    // claude-code is faster (10min) than kiro (20min), so should score higher
    expect((speed['claude-code'] as number) > (speed['kiro'] as number)).toBe(true);
  });

  it('uses average eval pass rate per agent', () => {
    const evalTrends: EvalTrendPoint[] = [
      { date: '2026-05-01', agentKey: 'claude-code', passRate: 80, runCount: 5 },
      { date: '2026-05-02', agentKey: 'claude-code', passRate: 90, runCount: 5 },
    ];
    const result = buildRadarData(efficiency, stats, evalTrends);
    const evalDim = result.find(r => r.dimension === 'Eval Pass')!;
    expect(evalDim['claude-code']).toBe(85); // average of 80 and 90
  });

  it('returns 0 for agents with no eval data', () => {
    const evalTrends: EvalTrendPoint[] = [
      { date: '2026-05-01', agentKey: 'claude-code', passRate: 90, runCount: 5 },
    ];
    const result = buildRadarData(efficiency, stats, evalTrends);
    const evalDim = result.find(r => r.dimension === 'Eval Pass')!;
    expect(evalDim['kiro']).toBe(0);
  });
});
