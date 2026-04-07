/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { RunAggregateMetrics } from '@/types';
import { getPassRateColorClass, getVisibleMetricRows, getUniformValue, getHeatmapClass } from '@/components/comparison/RunSummaryTable';

// Mock DEFAULT_CONFIG to avoid importing real config
jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [
      { key: 'pulsar', name: 'Pulsar' },
      { key: 'travel-planner', name: 'Travel Planner' },
    ],
    models: {},
  },
}));

const createMockRun = (overrides: Partial<RunAggregateMetrics> = {}): RunAggregateMetrics => ({
  runId: 'run-1',
  runName: 'Run A',
  createdAt: '2026-02-15T10:00:00Z',
  modelId: 'claude-sonnet-4-20250514',
  agentKey: 'pulsar',
  totalTestCases: 7,
  passedCount: 1,
  failedCount: 6,
  avgAccuracy: 25,
  passRatePercent: 14,
  ...overrides,
});

describe('RunSummaryTable', () => {
  describe('getPassRateColorClass', () => {
    it('returns green for pass rate >= 80', () => {
      expect(getPassRateColorClass(80)).toBe('text-green-700 dark:text-green-400');
      expect(getPassRateColorClass(100)).toBe('text-green-700 dark:text-green-400');
      expect(getPassRateColorClass(95)).toBe('text-green-700 dark:text-green-400');
    });

    it('returns amber for pass rate >= 50 and < 80', () => {
      expect(getPassRateColorClass(50)).toBe('text-amber-700 dark:text-amber-400');
      expect(getPassRateColorClass(79)).toBe('text-amber-700 dark:text-amber-400');
      expect(getPassRateColorClass(65)).toBe('text-amber-700 dark:text-amber-400');
    });

    it('returns red for pass rate < 50', () => {
      expect(getPassRateColorClass(0)).toBe('text-red-700 dark:text-red-400');
      expect(getPassRateColorClass(49)).toBe('text-red-700 dark:text-red-400');
      expect(getPassRateColorClass(25)).toBe('text-red-700 dark:text-red-400');
    });
  });

  describe('getVisibleMetricRows', () => {
    it('excludes trace metric rows when no run has trace data', () => {
      const runs = [
        createMockRun({ runId: 'run-1' }),
        createMockRun({ runId: 'run-2' }),
      ];

      const rows = getVisibleMetricRows(runs);
      const keys = rows.map(r => r.key);

      expect(keys).toContain('agent');
      expect(keys).toContain('model');
      expect(keys).toContain('date');
      expect(keys).toContain('passRate');
      expect(keys).toContain('accuracy');
      expect(keys).not.toContain('tokens');
      expect(keys).not.toContain('cost');
      expect(keys).not.toContain('duration');
    });

    it('includes trace metric rows when at least one run has trace data', () => {
      const runs = [
        createMockRun({ runId: 'run-1', totalTokens: 250000 }),
        createMockRun({ runId: 'run-2' }),
      ];

      const rows = getVisibleMetricRows(runs);
      const keys = rows.map(r => r.key);

      expect(keys).toContain('tokens');
      expect(keys).toContain('cost');
      expect(keys).toContain('duration');
    });

    it('includes all 8 metric rows when trace data is present', () => {
      const runs = [
        createMockRun({ runId: 'run-1', totalTokens: 250000, totalCostUsd: 7.89, avgDurationMs: 50800 }),
      ];

      const rows = getVisibleMetricRows(runs);
      expect(rows).toHaveLength(8);
    });

    it('includes 5 metric rows when no trace data', () => {
      const runs = [createMockRun()];

      const rows = getVisibleMetricRows(runs);
      expect(rows).toHaveLength(5);
    });
  });

  describe('metric row getValue functions', () => {
    it('formats pass rate with percentage', () => {
      const run = createMockRun({ passedCount: 3, totalTestCases: 7 });
      const rows = getVisibleMetricRows([run]);
      const passRateRow = rows.find(r => r.key === 'passRate')!;

      expect(passRateRow.getValue(run)).toBe('43%');
    });

    it('formats accuracy with percentage', () => {
      const run = createMockRun({ avgAccuracy: 59 });
      const rows = getVisibleMetricRows([run]);
      const accuracyRow = rows.find(r => r.key === 'accuracy')!;

      expect(accuracyRow.getValue(run)).toBe('59%');
    });

    it('formats tokens with suffix', () => {
      const run = createMockRun({ totalTokens: 2500000 });
      const rows = getVisibleMetricRows([run]);
      const tokensRow = rows.find(r => r.key === 'tokens')!;

      expect(tokensRow.getValue(run)).toBe('2.5M');
    });

    it('shows dash for missing token data', () => {
      const run = createMockRun({ totalTokens: undefined });
      // Force trace metrics visible by adding another run with data
      const runWithTraces = createMockRun({ runId: 'run-2', totalTokens: 1000 });
      const rows = getVisibleMetricRows([run, runWithTraces]);
      const tokensRow = rows.find(r => r.key === 'tokens')!;

      expect(tokensRow.getValue(run)).toBe('-');
    });

    it('formats cost as USD', () => {
      const run = createMockRun({ totalTokens: 100000, totalCostUsd: 7.89 });
      const rows = getVisibleMetricRows([run]);
      const costRow = rows.find(r => r.key === 'cost')!;

      expect(costRow.getValue(run)).toBe('$7.89');
    });

    it('formats duration in human-readable format', () => {
      const run = createMockRun({ totalTokens: 100000, avgDurationMs: 50800 });
      const rows = getVisibleMetricRows([run]);
      const durationRow = rows.find(r => r.key === 'duration')!;

      expect(durationRow.getValue(run)).toBe('50.8s');
    });

    it('formats duration over a minute', () => {
      const run = createMockRun({ totalTokens: 100000, avgDurationMs: 88000 });
      const rows = getVisibleMetricRows([run]);
      const durationRow = rows.find(r => r.key === 'duration')!;

      expect(durationRow.getValue(run)).toBe('1m 28s');
    });

    it('returns agent display name', () => {
      const run = createMockRun({ agentKey: 'pulsar' });
      const rows = getVisibleMetricRows([run]);
      const agentRow = rows.find(r => r.key === 'agent')!;

      expect(agentRow.getValue(run)).toBe('Pulsar');
    });

    it('returns raw agent key when not found in config', () => {
      const run = createMockRun({ agentKey: 'unknown-agent' });
      const rows = getVisibleMetricRows([run]);
      const agentRow = rows.find(r => r.key === 'agent')!;

      expect(agentRow.getValue(run)).toBe('unknown-agent');
    });

    it('handles zero pass rate', () => {
      const run = createMockRun({ passedCount: 0, totalTestCases: 7 });
      const rows = getVisibleMetricRows([run]);
      const passRateRow = rows.find(r => r.key === 'passRate')!;

      expect(passRateRow.getValue(run)).toBe('0%');
    });

    it('handles zero total test cases', () => {
      const run = createMockRun({ passedCount: 0, totalTestCases: 0 });
      const rows = getVisibleMetricRows([run]);
      const passRateRow = rows.find(r => r.key === 'passRate')!;

      expect(passRateRow.getValue(run)).toBe('0%');
    });
  });

  describe('metric row getNumericValue functions', () => {
    it('returns passRatePercent for pass rate row', () => {
      const run = createMockRun({ passRatePercent: 43 });
      const rows = getVisibleMetricRows([run]);
      const passRateRow = rows.find(r => r.key === 'passRate')!;

      expect(passRateRow.getNumericValue!(run)).toBe(43);
    });

    it('returns avgAccuracy for accuracy row', () => {
      const run = createMockRun({ avgAccuracy: 59 });
      const rows = getVisibleMetricRows([run]);
      const accuracyRow = rows.find(r => r.key === 'accuracy')!;

      expect(accuracyRow.getNumericValue!(run)).toBe(59);
    });

    it('returns undefined for trace metrics when not available', () => {
      const run = createMockRun();
      const runWithTraces = createMockRun({ runId: 'run-2', totalTokens: 1000 });
      const rows = getVisibleMetricRows([run, runWithTraces]);

      const tokensRow = rows.find(r => r.key === 'tokens')!;
      const costRow = rows.find(r => r.key === 'cost')!;
      const durationRow = rows.find(r => r.key === 'duration')!;

      expect(tokensRow.getNumericValue!(run)).toBeUndefined();
      expect(costRow.getNumericValue!(run)).toBeUndefined();
      expect(durationRow.getNumericValue!(run)).toBeUndefined();
    });
  });

  describe('higherIsBetter configuration', () => {
    it('marks passRate and accuracy as higherIsBetter', () => {
      const run = createMockRun({ totalTokens: 1000 });
      const rows = getVisibleMetricRows([run]);

      const passRate = rows.find(r => r.key === 'passRate')!;
      const accuracy = rows.find(r => r.key === 'accuracy')!;

      expect(passRate.higherIsBetter).toBe(true);
      expect(accuracy.higherIsBetter).toBe(true);
    });

    it('marks cost and duration as lowerIsBetter', () => {
      const run = createMockRun({ totalTokens: 1000 });
      const rows = getVisibleMetricRows([run]);

      const cost = rows.find(r => r.key === 'cost')!;
      const duration = rows.find(r => r.key === 'duration')!;

      expect(cost.higherIsBetter).toBe(false);
      expect(duration.higherIsBetter).toBe(false);
    });

    it('does not set higherIsBetter for agent, model, date', () => {
      const run = createMockRun();
      const rows = getVisibleMetricRows([run]);

      const agent = rows.find(r => r.key === 'agent')!;
      const model = rows.find(r => r.key === 'model')!;
      const date = rows.find(r => r.key === 'date')!;

      expect(agent.higherIsBetter).toBeUndefined();
      expect(model.higherIsBetter).toBeUndefined();
      expect(date.higherIsBetter).toBeUndefined();
    });
  });

  describe('showDelta configuration', () => {
    it('only passRate and accuracy have showDelta true', () => {
      const run = createMockRun({ totalTokens: 1000 });
      const rows = getVisibleMetricRows([run]);

      const withDelta = rows.filter(r => r.showDelta);
      expect(withDelta).toHaveLength(2);
      expect(withDelta.map(r => r.key)).toEqual(['passRate', 'accuracy']);
    });

    it('trace metric rows do not show delta', () => {
      const run = createMockRun({ totalTokens: 1000 });
      const rows = getVisibleMetricRows([run]);

      const traceRows = rows.filter(r => r.isTraceMetric);
      expect(traceRows.every(r => !r.showDelta)).toBe(true);
    });
  });

  describe('group configuration', () => {
    it('assigns config group to agent, model, and date rows', () => {
      const run = createMockRun();
      const rows = getVisibleMetricRows([run]);

      expect(rows.find(r => r.key === 'agent')!.group).toBe('config');
      expect(rows.find(r => r.key === 'model')!.group).toBe('config');
      expect(rows.find(r => r.key === 'date')!.group).toBe('config');
    });

    it('assigns performance group to passRate and accuracy', () => {
      const run = createMockRun();
      const rows = getVisibleMetricRows([run]);

      expect(rows.find(r => r.key === 'passRate')!.group).toBe('performance');
      expect(rows.find(r => r.key === 'accuracy')!.group).toBe('performance');
    });

    it('assigns resource group to tokens, cost, and duration', () => {
      const run = createMockRun({ totalTokens: 1000 });
      const rows = getVisibleMetricRows([run]);

      expect(rows.find(r => r.key === 'tokens')!.group).toBe('resource');
      expect(rows.find(r => r.key === 'cost')!.group).toBe('resource');
      expect(rows.find(r => r.key === 'duration')!.group).toBe('resource');
    });
  });

  describe('getUniformValue', () => {
    it('returns value when all runs have the same value', () => {
      const runs = [
        createMockRun({ runId: 'run-1', agentKey: 'pulsar' }),
        createMockRun({ runId: 'run-2', agentKey: 'pulsar' }),
        createMockRun({ runId: 'run-3', agentKey: 'pulsar' }),
      ];

      const result = getUniformValue(runs, r => r.agentKey);
      expect(result).toBe('pulsar');
    });

    it('returns null when runs have different values', () => {
      const runs = [
        createMockRun({ runId: 'run-1', agentKey: 'pulsar' }),
        createMockRun({ runId: 'run-2', agentKey: 'travel-planner' }),
      ];

      const result = getUniformValue(runs, r => r.agentKey);
      expect(result).toBeNull();
    });

    it('returns the value for a single run', () => {
      const runs = [createMockRun({ agentKey: 'pulsar' })];

      const result = getUniformValue(runs, r => r.agentKey);
      expect(result).toBe('pulsar');
    });

    it('returns null for empty runs array', () => {
      const result = getUniformValue([], r => r.agentKey);
      expect(result).toBeNull();
    });

    it('returns null when only one run differs', () => {
      const runs = [
        createMockRun({ runId: 'run-1', modelId: 'model-a' }),
        createMockRun({ runId: 'run-2', modelId: 'model-a' }),
        createMockRun({ runId: 'run-3', modelId: 'model-b' }),
      ];

      const result = getUniformValue(runs, r => r.modelId);
      expect(result).toBeNull();
    });

    it('works with getValue functions from SUMMARY_ROWS', () => {
      const runs = [
        createMockRun({ runId: 'run-1', agentKey: 'pulsar' }),
        createMockRun({ runId: 'run-2', agentKey: 'pulsar' }),
      ];
      const rows = getVisibleMetricRows(runs);
      const agentRow = rows.find(r => r.key === 'agent')!;

      // Uses the agent display name resolver
      const result = getUniformValue(runs, agentRow.getValue);
      expect(result).toBe('Pulsar');
    });
  });

  describe('getHeatmapClass', () => {
    describe('higherIsBetter = true', () => {
      it('returns emerald/10 for values at the top (>= 80th percentile)', () => {
        expect(getHeatmapClass(100, 0, 100, true)).toBe('bg-emerald-500/10');
        expect(getHeatmapClass(90, 0, 100, true)).toBe('bg-emerald-500/10');
        expect(getHeatmapClass(80, 0, 100, true)).toBe('bg-emerald-500/10');
      });

      it('returns emerald/5 for values in 60-80th percentile', () => {
        expect(getHeatmapClass(70, 0, 100, true)).toBe('bg-emerald-500/5');
        expect(getHeatmapClass(60, 0, 100, true)).toBe('bg-emerald-500/5');
      });

      it('returns empty string for middle values (40-60th percentile)', () => {
        expect(getHeatmapClass(50, 0, 100, true)).toBe('');
        expect(getHeatmapClass(40, 0, 100, true)).toBe('');
      });

      it('returns red/5 for values in 20-40th percentile', () => {
        expect(getHeatmapClass(30, 0, 100, true)).toBe('bg-red-500/5');
        expect(getHeatmapClass(20, 0, 100, true)).toBe('bg-red-500/5');
      });

      it('returns red/10 for values at the bottom (< 20th percentile)', () => {
        expect(getHeatmapClass(10, 0, 100, true)).toBe('bg-red-500/10');
        expect(getHeatmapClass(0, 0, 100, true)).toBe('bg-red-500/10');
      });
    });

    describe('higherIsBetter = false (lower is better)', () => {
      it('returns emerald/10 for lowest values', () => {
        expect(getHeatmapClass(0, 0, 100, false)).toBe('bg-emerald-500/10');
        expect(getHeatmapClass(10, 0, 100, false)).toBe('bg-emerald-500/10');
      });

      it('returns red/10 for highest values', () => {
        expect(getHeatmapClass(100, 0, 100, false)).toBe('bg-red-500/10');
        expect(getHeatmapClass(90, 0, 100, false)).toBe('bg-red-500/10');
      });

      it('returns empty string for middle values', () => {
        expect(getHeatmapClass(50, 0, 100, false)).toBe('');
      });
    });

    describe('edge cases', () => {
      it('returns empty string when min equals max (all identical)', () => {
        expect(getHeatmapClass(50, 50, 50, true)).toBe('');
        expect(getHeatmapClass(50, 50, 50, false)).toBe('');
      });

      it('handles boundary values correctly', () => {
        // At min boundary
        expect(getHeatmapClass(0, 0, 100, true)).toBe('bg-red-500/10');
        // At max boundary
        expect(getHeatmapClass(100, 0, 100, true)).toBe('bg-emerald-500/10');
      });

      it('handles small ranges', () => {
        // Range of 1: value at max
        expect(getHeatmapClass(11, 10, 11, true)).toBe('bg-emerald-500/10');
        // Range of 1: value at min
        expect(getHeatmapClass(10, 10, 11, true)).toBe('bg-red-500/10');
      });

      it('handles decimal values', () => {
        // 8.5 / 10 = 0.85 normalized → best bucket
        expect(getHeatmapClass(8.5, 0, 10.0, true)).toBe('bg-emerald-500/10');
        // 2.5 / 10 = 0.25 normalized → poor bucket
        expect(getHeatmapClass(2.5, 0, 10.0, true)).toBe('bg-red-500/5');
      });
    });
  });
});
