/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for Sample Runs module
 */

import {
  SAMPLE_RUNS,
  getSampleRun,
  getAllSampleRuns,
  getSampleRunsByTestCase,
  getSampleRunsByBenchmark,
  getSampleRunsByBenchmarkRun,
  isSampleRunId,
} from '@/cli/demo/sampleRuns';

describe('Sample Runs', () => {
  describe('SAMPLE_RUNS', () => {
    it('should have 5 sample runs', () => {
      expect(SAMPLE_RUNS.length).toBe(5);
    });

    it('should have demo- prefix for all IDs', () => {
      SAMPLE_RUNS.forEach((run) => {
        expect(run.id).toMatch(/^demo-report-/);
      });
    });

    it('should have all required fields', () => {
      SAMPLE_RUNS.forEach((run) => {
        expect(run.id).toBeDefined();
        expect(run.testCaseId).toBeDefined();
        expect(run.experimentId).toBeDefined();
        expect(run.experimentRunId).toBeDefined();
        expect(run.trajectory).toBeDefined();
        expect(run.status).toBe('completed');
        expect(run.passFailStatus).toBeDefined();
        expect(run.metrics).toBeDefined();
      });
    });

    it('should have valid trajectory steps', () => {
      SAMPLE_RUNS.forEach((run) => {
        expect(run.trajectory.length).toBeGreaterThan(0);
        run.trajectory.forEach((step) => {
          expect(step.id).toBeDefined();
          expect(step.type).toBeDefined();
          expect(step.content).toBeDefined();
          expect(['thinking', 'action', 'tool_result', 'response']).toContain(step.type);
        });
      });
    });

    it('should have accuracy metrics', () => {
      SAMPLE_RUNS.forEach((run) => {
        expect(run.metrics?.accuracy).toBeDefined();
        expect(typeof run.metrics?.accuracy).toBe('number');
        expect(run.metrics?.accuracy).toBeGreaterThanOrEqual(0);
        expect(run.metrics?.accuracy).toBeLessThanOrEqual(100);
      });
    });

    it('should have LLM judge reasoning', () => {
      SAMPLE_RUNS.forEach((run) => {
        expect(run.llmJudgeReasoning).toBeDefined();
        expect(run.llmJudgeReasoning?.length).toBeGreaterThan(0);
      });
    });

    it('should reference demo benchmark and run IDs', () => {
      SAMPLE_RUNS.forEach((run) => {
        expect(run.experimentId).toBe('demo-benchmark-001');
        expect(run.experimentRunId).toBe('demo-run-001');
      });
    });
  });

  describe('getSampleRun', () => {
    it('should return run by ID', () => {
      const run = getSampleRun('demo-report-001');
      expect(run).toBeDefined();
      expect(run?.testCaseId).toBe('demo-otel-001');
    });

    it('should return undefined for unknown ID', () => {
      const run = getSampleRun('unknown-id');
      expect(run).toBeUndefined();
    });
  });

  describe('getAllSampleRuns', () => {
    it('should return a copy of all runs', () => {
      const runs = getAllSampleRuns();
      expect(runs.length).toBe(5);

      // Verify it's a copy, not the original
      const originalLength = SAMPLE_RUNS.length;
      runs.push({
        id: 'new-run',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test',
        testCaseVersion: 1,
        experimentId: 'benchmark',
        experimentRunId: 'run',
        agentName: 'test',
        agentKey: 'test',
        modelName: 'test',
        modelId: 'test',
        status: 'completed',
        passFailStatus: 'passed',
        runId: 'test',
        trajectory: [],
        metrics: { accuracy: 100 },
      } as any);
      expect(SAMPLE_RUNS.length).toBe(originalLength);
    });
  });

  describe('getSampleRunsByTestCase', () => {
    it('should return runs for specific test case', () => {
      const runs = getSampleRunsByTestCase('demo-otel-001');
      expect(runs.length).toBe(1);
      expect(runs[0].id).toBe('demo-report-001');
    });

    it('should return empty array for unknown test case', () => {
      const runs = getSampleRunsByTestCase('unknown-test-case');
      expect(runs).toEqual([]);
    });
  });

  describe('getSampleRunsByBenchmark', () => {
    it('should return all runs for demo benchmark', () => {
      const runs = getSampleRunsByBenchmark('demo-benchmark-001');
      expect(runs.length).toBe(5);
    });

    it('should return empty array for unknown benchmark', () => {
      const runs = getSampleRunsByBenchmark('unknown-benchmark');
      expect(runs).toEqual([]);
    });
  });

  describe('getSampleRunsByBenchmarkRun', () => {
    it('should return runs for specific benchmark run', () => {
      const runs = getSampleRunsByBenchmarkRun('demo-benchmark-001', 'demo-run-001');
      expect(runs.length).toBe(5);
    });

    it('should return empty array for mismatched benchmark', () => {
      const runs = getSampleRunsByBenchmarkRun('unknown-benchmark', 'demo-run-001');
      expect(runs).toEqual([]);
    });

    it('should return empty array for mismatched run', () => {
      const runs = getSampleRunsByBenchmarkRun('demo-benchmark-001', 'unknown-run');
      expect(runs).toEqual([]);
    });
  });

  describe('isSampleRunId', () => {
    it('should return true for demo-report- prefix', () => {
      expect(isSampleRunId('demo-report-001')).toBe(true);
      expect(isSampleRunId('demo-report-anything')).toBe(true);
    });

    it('should return true for demo-run- prefix', () => {
      expect(isSampleRunId('demo-run-001')).toBe(true);
      expect(isSampleRunId('demo-run-anything')).toBe(true);
    });

    it('should return false for non-demo IDs', () => {
      expect(isSampleRunId('report-001')).toBe(false);
      expect(isSampleRunId('run-001')).toBe(false);
      expect(isSampleRunId('random-id')).toBe(false);
    });
  });

  describe('Sample Run Content Quality', () => {
    it('should have realistic payment latency scenario', () => {
      const run = getSampleRun('demo-report-001');
      expect(run?.trajectory.some(step =>
        step.content.toLowerCase().includes('latency') ||
        step.content.toLowerCase().includes('payment')
      )).toBe(true);
    });

    it('should have error rate scenario', () => {
      const run = getSampleRun('demo-report-002');
      expect(run?.trajectory.some(step =>
        step.content.toLowerCase().includes('error') ||
        step.content.toLowerCase().includes('cart')
      )).toBe(true);
    });

    it('should have database connection pool scenario', () => {
      const run = getSampleRun('demo-report-003');
      expect(run?.trajectory.some(step =>
        step.content.toLowerCase().includes('database') ||
        step.content.toLowerCase().includes('pool') ||
        step.content.toLowerCase().includes('connection')
      )).toBe(true);
    });

    it('should have cold start scenario', () => {
      const run = getSampleRun('demo-report-004');
      expect(run?.trajectory.some(step =>
        step.content.toLowerCase().includes('cold') ||
        step.content.toLowerCase().includes('startup') ||
        step.content.toLowerCase().includes('model')
      )).toBe(true);
    });

    it('should have cascading failure scenario', () => {
      const run = getSampleRun('demo-report-005');
      expect(run?.trajectory.some(step =>
        step.content.toLowerCase().includes('cascad') ||
        step.content.toLowerCase().includes('failure') ||
        step.content.toLowerCase().includes('circuit')
      )).toBe(true);
    });
  });
});
