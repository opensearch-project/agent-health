/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for sample data modules
 */

import {
  SAMPLE_TEST_CASES,
  getSampleTestCase,
  getAllSampleTestCases,
} from '@/cli/demo/sampleTestCases';

import {
  SAMPLE_EXPERIMENTS,
  getSampleBenchmark,
  getAllSampleExperiments,
  isSampleExperimentId,
} from '@/cli/demo/sampleBenchmarks';

describe('Sample Test Cases', () => {
  describe('SAMPLE_TEST_CASES', () => {
    it('should have 5 sample test cases', () => {
      expect(SAMPLE_TEST_CASES.length).toBe(5);
    });

    it('should have all required fields for each test case', () => {
      SAMPLE_TEST_CASES.forEach((tc) => {
        expect(tc.id).toBeDefined();
        expect(tc.name).toBeDefined();
        expect(tc.initialPrompt).toBeDefined();
        expect(tc.context).toBeDefined();
        expect(tc.expectedOutcomes).toBeDefined();
        expect(tc.labels).toBeDefined();
      });
    });

    it('should have demo- prefix for all IDs', () => {
      SAMPLE_TEST_CASES.forEach((tc) => {
        expect(tc.id).toMatch(/^demo-/);
      });
    });

    it('should have promoted tag on all test cases', () => {
      SAMPLE_TEST_CASES.forEach((tc) => {
        expect(tc.tags).toContain('promoted');
      });
    });
  });

  describe('getSampleTestCase', () => {
    it('should return test case by ID', () => {
      const tc = getSampleTestCase('demo-otel-001');
      expect(tc).toBeDefined();
      expect(tc?.name).toBe('Payment Service Latency Spike');
    });

    it('should return undefined for unknown ID', () => {
      const tc = getSampleTestCase('unknown-id');
      expect(tc).toBeUndefined();
    });
  });

  describe('getAllSampleTestCases', () => {
    it('should return a copy of all test cases', () => {
      const testCases = getAllSampleTestCases();
      expect(testCases.length).toBe(5);

      // Verify it's a copy, not the original
      testCases.push({
        id: 'new-test',
        name: 'New Test',
        initialPrompt: 'Test prompt',
        context: [],
        expectedOutcomes: [],
        labels: [],
      });
      expect(SAMPLE_TEST_CASES.length).toBe(5);
    });
  });
});

describe('Sample Experiments', () => {
  describe('SAMPLE_EXPERIMENTS', () => {
    it('should have 2 sample experiments', () => {
      expect(SAMPLE_EXPERIMENTS.length).toBe(2);
    });

    it('should have correct experiment structure', () => {
      const exp = SAMPLE_EXPERIMENTS[0];
      expect(exp.id).toBe('demo-exp-001');
      expect(exp.name).toBe('RCA Agent Evaluation - Demo');
      expect(exp.testCaseIds).toHaveLength(5);
      expect(exp.runs).toHaveLength(1);
    });

    it('should have 5 test case IDs', () => {
      const exp = SAMPLE_EXPERIMENTS[0];
      expect(exp.testCaseIds).toEqual([
        'demo-otel-001',
        'demo-otel-002',
        'demo-otel-003',
        'demo-otel-004',
        'demo-otel-005',
      ]);
    });

    it('should have a completed baseline run', () => {
      const exp = SAMPLE_EXPERIMENTS[0];
      const run = exp.runs[0];
      expect(run.id).toBe('demo-run-001');
      expect(run.name).toBe('Baseline Run');
      expect(run.status).toBe('completed');
    });

    it('should have results for all test cases in the run', () => {
      const exp = SAMPLE_EXPERIMENTS[0];
      const run = exp.runs[0];
      expect(Object.keys(run.results)).toHaveLength(5);

      exp.testCaseIds.forEach((tcId) => {
        expect(run.results[tcId]).toBeDefined();
        expect(run.results[tcId].status).toBe('completed');
      });
    });
  });

  describe('getSampleBenchmark', () => {
    it('should return experiment by ID', () => {
      const exp = getSampleBenchmark('demo-exp-001');
      expect(exp).toBeDefined();
      expect(exp?.name).toBe('RCA Agent Evaluation - Demo');
    });

    it('should return undefined for unknown ID', () => {
      const exp = getSampleBenchmark('unknown-id');
      expect(exp).toBeUndefined();
    });
  });

  describe('getAllSampleExperiments', () => {
    it('should return a copy of all experiments', () => {
      const experiments = getAllSampleExperiments();
      expect(experiments.length).toBe(2);
    });
  });

  describe('isSampleExperimentId', () => {
    it('should return true for demo-exp- prefix', () => {
      expect(isSampleExperimentId('demo-exp-001')).toBe(true);
      expect(isSampleExperimentId('demo-exp-anything')).toBe(true);
    });

    it('should return true for demo-run- prefix', () => {
      expect(isSampleExperimentId('demo-run-001')).toBe(true);
      expect(isSampleExperimentId('demo-run-anything')).toBe(true);
    });

    it('should return false for non-demo IDs', () => {
      expect(isSampleExperimentId('exp-001')).toBe(false);
      expect(isSampleExperimentId('run-001')).toBe(false);
      expect(isSampleExperimentId('random-id')).toBe(false);
    });
  });
});
