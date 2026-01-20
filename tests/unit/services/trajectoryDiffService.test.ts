/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  calculateStepSimilarity,
  alignTrajectories,
  compareJsonObjects,
  calculateDiffStats,
  AlignedStep,
} from '@/services/trajectoryDiffService';
import { TrajectoryStep } from '@/types';

// Test data factories
function createStep(type: TrajectoryStep['type'], overrides: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return {
    id: `step-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    type,
    content: overrides.content ?? '',
    toolName: overrides.toolName,
    toolArgs: overrides.toolArgs,
    latencyMs: overrides.latencyMs ?? 100,
    ...overrides,
  };
}

describe('TrajectoryDiffService', () => {
  describe('calculateStepSimilarity', () => {
    it('should return 1.0 for identical steps', () => {
      const step: TrajectoryStep = createStep('action', {
        toolName: 'search',
        toolArgs: { query: 'test' },
        content: 'Running search',
      });

      const similarity = calculateStepSimilarity(step, step);
      expect(similarity).toBe(1.0);
    });

    it('should return 0.4 for steps with same tool name only', () => {
      const step1 = createStep('action', {
        toolName: 'search',
        toolArgs: { query: 'test1' },
        content: 'First search',
      });
      const step2 = createStep('thinking', {
        toolName: 'search',
        toolArgs: { query: 'test2' },
        content: 'Different content',
      });

      const similarity = calculateStepSimilarity(step1, step2);
      // 0.4 (tool match) + 0 (type mismatch) + partial arg + partial content
      expect(similarity).toBeGreaterThanOrEqual(0.4);
      expect(similarity).toBeLessThan(1.0);
    });

    it('should return 0.2 for steps with same type only', () => {
      const step1 = createStep('thinking', {
        content: 'First thought',
      });
      const step2 = createStep('thinking', {
        content: 'Completely different idea',
      });

      const similarity = calculateStepSimilarity(step1, step2);
      // 0 (no tool) + 0.2 (type match) + 0.2 (no args) + partial content
      expect(similarity).toBeGreaterThanOrEqual(0.2);
    });

    it('should give higher similarity for matching arguments', () => {
      const step1 = createStep('action', {
        toolName: 'api_call',
        toolArgs: { method: 'GET', url: '/test', headers: {} },
      });
      const step2 = createStep('action', {
        toolName: 'api_call',
        toolArgs: { method: 'GET', url: '/test' },
      });

      const similarity = calculateStepSimilarity(step1, step2);
      // Should have high similarity due to matching tool, type, and similar args
      expect(similarity).toBeGreaterThan(0.7);
    });

    it('should give partial content similarity for overlapping words', () => {
      const step1 = createStep('response', {
        content: 'The search results show multiple matches',
      });
      const step2 = createStep('response', {
        content: 'The results show different data',
      });

      const similarity = calculateStepSimilarity(step1, step2);
      // Type match (0.2) + no args match (0.2) + partial content
      expect(similarity).toBeGreaterThan(0.4);
    });

    it('should handle missing toolArgs', () => {
      const step1 = createStep('thinking', { content: 'Test' });
      const step2 = createStep('thinking', { content: 'Test' });

      const similarity = calculateStepSimilarity(step1, step2);
      // Type match (0.2) + no toolArgs both (0.2) + content match (0.2) = 0.6
      // No tool name so no 0.4 bonus
      expect(similarity).toBeCloseTo(0.6, 5);
    });

    it('should handle missing content', () => {
      const step1 = createStep('action', {
        toolName: 'test',
        toolArgs: { key: 'value' },
      });
      const step2 = createStep('action', {
        toolName: 'test',
        toolArgs: { key: 'value' },
      });

      const similarity = calculateStepSimilarity(step1, step2);
      expect(similarity).toBe(1.0);
    });
  });

  describe('alignTrajectories', () => {
    it('should return empty array for two empty arrays', () => {
      const result = alignTrajectories([], []);
      expect(result).toEqual([]);
    });

    it('should mark all comparison steps as added when baseline is empty', () => {
      const comparison = [
        createStep('thinking', { content: 'First' }),
        createStep('action', { toolName: 'search' }),
      ];

      const result = alignTrajectories([], comparison);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('added');
      expect(result[1].type).toBe('added');
      expect(result.every(s => s.comparisonStep !== undefined)).toBe(true);
    });

    it('should mark all baseline steps as removed when comparison is empty', () => {
      const baseline = [
        createStep('thinking', { content: 'First' }),
        createStep('action', { toolName: 'search' }),
      ];

      const result = alignTrajectories(baseline, []);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('removed');
      expect(result[1].type).toBe('removed');
      expect(result.every(s => s.baselineStep !== undefined)).toBe(true);
    });

    it('should correctly align identical trajectories', () => {
      const trajectory = [
        createStep('thinking', { content: 'Analyzing' }),
        createStep('action', { toolName: 'search', toolArgs: { query: 'test' } }),
        createStep('response', { content: 'Done' }),
      ];

      const result = alignTrajectories(trajectory, trajectory);

      expect(result).toHaveLength(3);
      expect(result.every(s => s.type === 'matched')).toBe(true);
    });

    it('should detect added steps in comparison', () => {
      const baseline = [
        createStep('thinking', { content: 'Analyzing' }),
        createStep('response', { content: 'Done' }),
      ];
      const comparison = [
        createStep('thinking', { content: 'Analyzing' }),
        createStep('action', { toolName: 'search', toolArgs: { query: 'new' } }),
        createStep('response', { content: 'Done' }),
      ];

      const result = alignTrajectories(baseline, comparison);

      const addedSteps = result.filter(s => s.type === 'added');
      expect(addedSteps.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect removed steps from baseline', () => {
      const baseline = [
        createStep('thinking', { content: 'Analyzing' }),
        createStep('action', { toolName: 'search', toolArgs: { query: 'old' } }),
        createStep('response', { content: 'Done' }),
      ];
      const comparison = [
        createStep('thinking', { content: 'Analyzing' }),
        createStep('response', { content: 'Done' }),
      ];

      const result = alignTrajectories(baseline, comparison);

      const removedSteps = result.filter(s => s.type === 'removed');
      expect(removedSteps.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect modified steps', () => {
      const baseline = [
        createStep('action', {
          toolName: 'search',
          toolArgs: { query: 'original query' },
        }),
      ];
      const comparison = [
        createStep('action', {
          toolName: 'search',
          toolArgs: { query: 'modified query' },
        }),
      ];

      const result = alignTrajectories(baseline, comparison);

      // Should be marked as modified since it's the same tool but different args
      const modifiedOrMatched = result.filter(s => s.type === 'modified' || s.type === 'matched');
      expect(modifiedOrMatched.length).toBeGreaterThan(0);
    });

    it('should provide correct indexes', () => {
      const baseline = [createStep('thinking', { content: 'A' })];
      const comparison = [
        createStep('thinking', { content: 'A' }),
        createStep('action', { toolName: 'new' }),
      ];

      const result = alignTrajectories(baseline, comparison);

      // Check indexes are sequential
      for (let i = 0; i < result.length; i++) {
        expect(result[i].index).toBe(i);
      }
    });

    it('should handle complex trajectory differences', () => {
      const baseline = [
        createStep('thinking', { content: 'Step 1' }),
        createStep('action', { toolName: 'tool_a', toolArgs: { x: 1 } }),
        createStep('thinking', { content: 'Step 3' }),
        createStep('response', { content: 'Done' }),
      ];
      const comparison = [
        createStep('thinking', { content: 'Step 1' }),
        createStep('action', { toolName: 'tool_b', toolArgs: { y: 2 } }),
        createStep('action', { toolName: 'tool_c', toolArgs: { z: 3 } }),
        createStep('response', { content: 'Done differently' }),
      ];

      const result = alignTrajectories(baseline, comparison);

      // Should have some alignment
      expect(result.length).toBeGreaterThan(0);
      // First steps should match
      expect(result[0].type).toBe('matched');
    });
  });

  describe('compareJsonObjects', () => {
    it('should return empty diff for identical objects', () => {
      const obj = { a: 1, b: 'test', c: { nested: true } };
      const result = compareJsonObjects(obj, obj);

      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
    });

    it('should detect added keys', () => {
      const obj1 = { a: 1 };
      const obj2 = { a: 1, b: 2, c: 3 };

      const result = compareJsonObjects(obj1, obj2);

      expect(result.added).toEqual(['b', 'c']);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
    });

    it('should detect removed keys', () => {
      const obj1 = { a: 1, b: 2, c: 3 };
      const obj2 = { a: 1 };

      const result = compareJsonObjects(obj1, obj2);

      expect(result.added).toHaveLength(0);
      expect(result.removed).toEqual(['b', 'c']);
      expect(result.modified).toHaveLength(0);
    });

    it('should detect modified values', () => {
      const obj1 = { a: 1, b: 'old' };
      const obj2 = { a: 1, b: 'new' };

      const result = compareJsonObjects(obj1, obj2);

      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0]).toEqual({
        key: 'b',
        oldValue: 'old',
        newValue: 'new',
      });
    });

    it('should handle null objects', () => {
      const result1 = compareJsonObjects(null, { a: 1 });
      expect(result1.added).toEqual(['a']);

      const result2 = compareJsonObjects({ a: 1 }, null);
      expect(result2.removed).toEqual(['a']);

      const result3 = compareJsonObjects(null, null);
      expect(result3.added).toHaveLength(0);
      expect(result3.removed).toHaveLength(0);
    });

    it('should handle undefined objects', () => {
      const result = compareJsonObjects(undefined, { a: 1 });
      expect(result.added).toEqual(['a']);
    });

    it('should detect nested object changes', () => {
      const obj1 = { config: { timeout: 100 } };
      const obj2 = { config: { timeout: 200 } };

      const result = compareJsonObjects(obj1, obj2);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].key).toBe('config');
    });

    it('should detect array changes', () => {
      const obj1 = { items: [1, 2, 3] };
      const obj2 = { items: [1, 2, 3, 4] };

      const result = compareJsonObjects(obj1, obj2);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].key).toBe('items');
    });
  });

  describe('calculateDiffStats', () => {
    it('should calculate correct counts', () => {
      const alignedSteps: AlignedStep[] = [
        { type: 'matched', index: 0, baselineStep: createStep('thinking'), comparisonStep: createStep('thinking') },
        { type: 'added', index: 1, comparisonStep: createStep('action', { toolName: 'new' }) },
        { type: 'removed', index: 2, baselineStep: createStep('action', { toolName: 'old' }) },
        { type: 'modified', index: 3, baselineStep: createStep('response'), comparisonStep: createStep('response') },
        { type: 'matched', index: 4, baselineStep: createStep('thinking'), comparisonStep: createStep('thinking') },
      ];

      const baseline = [
        createStep('thinking'),
        createStep('action', { toolName: 'old' }),
        createStep('response'),
        createStep('thinking'),
      ];
      const comparison = [
        createStep('thinking'),
        createStep('action', { toolName: 'new' }),
        createStep('response'),
        createStep('thinking'),
      ];

      const stats = calculateDiffStats(alignedSteps, baseline, comparison);

      expect(stats.matchedCount).toBe(2);
      expect(stats.addedCount).toBe(1);
      expect(stats.removedCount).toBe(1);
      expect(stats.modifiedCount).toBe(1);
      expect(stats.baselineSteps).toBe(4);
      expect(stats.comparisonSteps).toBe(4);
    });

    it('should calculate latency totals', () => {
      const baseline = [
        createStep('action', { latencyMs: 100 }),
        createStep('action', { latencyMs: 200 }),
      ];
      const comparison = [
        createStep('action', { latencyMs: 150 }),
        createStep('action', { latencyMs: 250 }),
        createStep('action', { latencyMs: 50 }),
      ];

      const stats = calculateDiffStats([], baseline, comparison);

      expect(stats.baselineLatencyMs).toBe(300);
      expect(stats.comparisonLatencyMs).toBe(450);
    });

    it('should handle missing latencyMs', () => {
      const baseline = [
        createStep('thinking', { latencyMs: undefined }),
      ];
      const comparison = [
        createStep('thinking', { latencyMs: undefined }),
      ];

      const stats = calculateDiffStats([], baseline, comparison);

      expect(stats.baselineLatencyMs).toBe(0);
      expect(stats.comparisonLatencyMs).toBe(0);
    });

    it('should return zeros for empty arrays', () => {
      const stats = calculateDiffStats([], [], []);

      expect(stats.matchedCount).toBe(0);
      expect(stats.addedCount).toBe(0);
      expect(stats.removedCount).toBe(0);
      expect(stats.modifiedCount).toBe(0);
      expect(stats.baselineSteps).toBe(0);
      expect(stats.comparisonSteps).toBe(0);
      expect(stats.baselineLatencyMs).toBe(0);
      expect(stats.comparisonLatencyMs).toBe(0);
    });
  });

  describe('Integration: full trajectory alignment workflow', () => {
    it('should correctly process a complete diff scenario', () => {
      const baseline: TrajectoryStep[] = [
        createStep('thinking', { content: 'Analyzing the problem', latencyMs: 50 }),
        createStep('action', { toolName: 'search', toolArgs: { query: 'error logs' }, latencyMs: 200 }),
        createStep('tool_result', { content: 'Found 5 errors', latencyMs: 10 }),
        createStep('thinking', { content: 'Processing results', latencyMs: 30 }),
        createStep('response', { content: 'The issue is...', latencyMs: 100 }),
      ];

      const comparison: TrajectoryStep[] = [
        createStep('thinking', { content: 'Analyzing the problem', latencyMs: 45 }),
        createStep('action', { toolName: 'search', toolArgs: { query: 'error logs', limit: 10 }, latencyMs: 180 }),
        createStep('tool_result', { content: 'Found 8 errors', latencyMs: 15 }),
        createStep('action', { toolName: 'analyze', toolArgs: { type: 'root_cause' }, latencyMs: 300 }),
        createStep('tool_result', { content: 'Root cause identified', latencyMs: 20 }),
        createStep('response', { content: 'The root cause is...', latencyMs: 120 }),
      ];

      const aligned = alignTrajectories(baseline, comparison);
      const stats = calculateDiffStats(aligned, baseline, comparison);

      expect(stats.baselineSteps).toBe(5);
      expect(stats.comparisonSteps).toBe(6);
      expect(stats.baselineLatencyMs).toBe(390);
      expect(stats.comparisonLatencyMs).toBe(680);

      // Should have at least some matches (first thinking step)
      expect(stats.matchedCount + stats.modifiedCount).toBeGreaterThan(0);
    });
  });
});
