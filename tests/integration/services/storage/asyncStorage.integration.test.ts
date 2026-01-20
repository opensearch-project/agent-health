/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for async storage services
 *
 * These tests require the backend server to be running:
 *   npm run dev:judge
 *
 * Run tests:
 *   npm test -- --testPathPattern=asyncStorage.integration
 */

import { asyncExperimentStorage } from '@/services/storage/asyncExperimentStorage';
import { asyncTestCaseStorage } from '@/services/storage/asyncTestCaseStorage';
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { storageAdmin } from '@/services/storage/opensearchClient';

// Skip tests if backend is not running
const checkBackend = async (): Promise<boolean> => {
  try {
    const health = await storageAdmin.health();
    return health.status === 'connected';
  } catch {
    return false;
  }
};

describe('OpenSearch Storage Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
    }
  });

  describe('storageAdmin', () => {
    it('should check health status', async () => {
      if (!backendAvailable) return;

      const health = await storageAdmin.health();
      expect(health.status).toBe('connected');
    });

    it('should get storage stats', async () => {
      if (!backendAvailable) return;

      const stats = await storageAdmin.stats();
      expect(stats.stats).toBeDefined();
      expect(stats.stats.evals_test_cases).toBeDefined();
      expect(stats.stats.evals_experiments).toBeDefined();
      expect(stats.stats.evals_runs).toBeDefined();
      expect(stats.stats.evals_analytics).toBeDefined();
    });
  });

  describe('asyncTestCaseStorage', () => {
    let createdTestCaseId: string | null = null;

    afterAll(async () => {
      if (!backendAvailable || !createdTestCaseId) return;
      // Cleanup: delete test case
      try {
        await asyncTestCaseStorage.delete(createdTestCaseId);
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should create a test case', async () => {
      if (!backendAvailable) return;

      const testCase = await asyncTestCaseStorage.create({
        name: 'Integration Test Case',
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Test prompt',
        context: [],
        expectedTrajectory: [],
      });

      expect(testCase).toBeDefined();
      expect(testCase.id).toBeDefined();
      expect(testCase.name).toBe('Integration Test Case');
      expect(testCase.currentVersion).toBe(1);

      // Store ID for cleanup and subsequent tests
      createdTestCaseId = testCase.id;
    });

    it('should get test case by ID', async () => {
      if (!backendAvailable || !createdTestCaseId) return;

      const testCase = await asyncTestCaseStorage.getById(createdTestCaseId);
      expect(testCase).toBeDefined();
      expect(testCase?.id).toBe(createdTestCaseId);
    });

    it('should get all test cases', async () => {
      if (!backendAvailable) return;

      const testCases = await asyncTestCaseStorage.getAll();
      expect(Array.isArray(testCases)).toBe(true);
      expect(testCases.length).toBeGreaterThan(0);
    });

    it('should update test case (create new version)', async () => {
      if (!backendAvailable || !createdTestCaseId) return;

      const updated = await asyncTestCaseStorage.update(createdTestCaseId, {
        name: 'Updated Test Case',
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Test Case');
      expect(updated?.currentVersion).toBe(2);
    });

    it('should get test case versions', async () => {
      if (!backendAvailable || !createdTestCaseId) return;

      const versions = await asyncTestCaseStorage.getVersions(createdTestCaseId);
      expect(Array.isArray(versions)).toBe(true);
      expect(versions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('asyncExperimentStorage', () => {
    let experimentId: string;

    afterAll(async () => {
      if (!backendAvailable || !experimentId) return;
      // Cleanup: delete experiment
      try {
        await asyncExperimentStorage.delete(experimentId);
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should create an experiment', async () => {
      if (!backendAvailable) return;

      const experiment = await asyncExperimentStorage.create({
        name: 'Integration Test Experiment',
        description: 'Test experiment',
        testCaseIds: ['tc-001', 'tc-002'],
        runs: [],
      });

      expect(experiment).toBeDefined();
      expect(experiment.id).toBeDefined();
      expect(experiment.name).toBe('Integration Test Experiment');
      experimentId = experiment.id;
    });

    it('should get experiment by ID', async () => {
      if (!backendAvailable || !experimentId) return;

      const experiment = await asyncExperimentStorage.getById(experimentId);
      expect(experiment).toBeDefined();
      expect(experiment?.id).toBe(experimentId);
    });

    it('should get all experiments', async () => {
      if (!backendAvailable) return;

      const experiments = await asyncExperimentStorage.getAll();
      expect(Array.isArray(experiments)).toBe(true);
    });

    it('should delete run from experiment', async () => {
      if (!backendAvailable || !experimentId) return;

      // First, we need to save an experiment with runs
      // This tests the deleteRun method
      const result = await asyncExperimentStorage.deleteRun(experimentId, 'non-existent-run');
      expect(result).toBe(false); // Should return false since run doesn't exist
    });
  });

  describe('asyncRunStorage', () => {
    it('should get all reports', async () => {
      if (!backendAvailable) return;

      const reports = await asyncRunStorage.getAllReports({
        sortBy: 'timestamp',
        order: 'desc',
      });

      expect(Array.isArray(reports)).toBe(true);
    });

    it('should handle report not found', async () => {
      if (!backendAvailable) return;

      const report = await asyncRunStorage.getReportById('non-existent-id');
      expect(report).toBeNull();
    });
  });
});
