/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import {
  getLocalStorageCounts,
  hasLocalStorageData,
  migrateToOpenSearch,
  clearLocalStorageData,
  exportLocalStorageData,
} from '@/services/storage/migration';
import type { TestCase, Benchmark, EvaluationReport } from '@/types';

// Mock asyncTestCaseStorage
jest.mock('@/services/storage/asyncTestCaseStorage', () => ({
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((tc) => Promise.resolve({ ...tc, id: `new-${tc.name}` })),
  },
}));

// Mock asyncBenchmarkStorage
jest.mock('@/services/storage/asyncBenchmarkStorage', () => ({
  asyncBenchmarkStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock asyncRunStorage
jest.mock('@/services/storage/asyncRunStorage', () => ({
  asyncRunStorage: {
    getAllReports: jest.fn().mockResolvedValue([]),
    saveReport: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock localStorage
const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] || null),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn((key: string) => {
      delete store[key];
    }),
    clear: jest.fn(() => {
      store = {};
    }),
    _setStore: (newStore: Record<string, string>) => {
      store = { ...newStore };
    },
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
});

describe('Migration Service', () => {
  const mockTestCase: TestCase = {
    id: 'tc-1',
    name: 'Test Case 1',
    prompt: 'Test prompt',
    context: 'Test context',
    expectedOutcomes: ['Outcome 1'],
    currentVersion: 1,
    labels: [],
    versions: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const mockExperiment: Benchmark = {
    id: 'exp-1',
    name: 'Test Benchmark',
    description: 'Test description',
    testCaseIds: ['tc-1'],
    runs: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const mockReport: EvaluationReport = {
    id: 'report-1',
    timestamp: '2024-01-01T00:00:00Z',
    agentName: 'Test Agent',
    modelName: 'test-model',
    testCaseId: 'tc-1',
    testCaseVersion: 1,
    status: 'completed',
    trajectory: [],
    metrics: {
      accuracy: 0.9,
      faithfulness: 0.85,
      latency_score: 0.8,
      trajectory_alignment_score: 0.75,
    },
    llmJudgeReasoning: 'Test reasoning',
    improvementStrategies: [],
  };

  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalStorage.clear();
    mockLocalStorage._setStore({});

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('getLocalStorageCounts', () => {
    it('should return zero counts when localStorage is empty', () => {
      const counts = getLocalStorageCounts();
      expect(counts).toEqual({
        testCases: 0,
        experiments: 0,
        reports: 0,
      });
    });

    it('should return correct counts for test cases', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase, { ...mockTestCase, id: 'tc-2' }]),
      });

      const counts = getLocalStorageCounts();
      expect(counts.testCases).toBe(2);
    });

    it('should return correct counts for experiments', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const counts = getLocalStorageCounts();
      expect(counts.experiments).toBe(1);
    });

    it('should return correct counts for reports', () => {
      mockLocalStorage._setStore({
        test_case_runs: JSON.stringify({ 'tc-1': [mockReport] }),
      });

      const counts = getLocalStorageCounts();
      expect(counts.reports).toBe(1);
    });

    it('should handle invalid JSON gracefully', () => {
      mockLocalStorage._setStore({
        test_cases: 'invalid json',
      });

      const counts = getLocalStorageCounts();
      expect(counts.testCases).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('hasLocalStorageData', () => {
    it('should return false when localStorage is empty', () => {
      expect(hasLocalStorageData()).toBe(false);
    });

    it('should return true when test cases exist', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
      });
      expect(hasLocalStorageData()).toBe(true);
    });

    it('should return true when experiments exist', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });
      expect(hasLocalStorageData()).toBe(true);
    });

    it('should return true when reports exist', () => {
      mockLocalStorage._setStore({
        test_case_runs: JSON.stringify({ 'tc-1': [mockReport] }),
      });
      expect(hasLocalStorageData()).toBe(true);
    });
  });

  describe('migrateToOpenSearch', () => {
    it('should return empty stats when localStorage is empty', async () => {
      const stats = await migrateToOpenSearch();

      expect(stats.testCases.total).toBe(0);
      expect(stats.experiments.total).toBe(0);
      expect(stats.reports.total).toBe(0);
    });

    it('should migrate test cases to OpenSearch', async () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
      });

      const { asyncTestCaseStorage } = require('@/services/storage/asyncTestCaseStorage');

      const stats = await migrateToOpenSearch();

      expect(stats.testCases.total).toBe(1);
      expect(stats.testCases.migrated).toBe(1);
      expect(asyncTestCaseStorage.create).toHaveBeenCalled();
    });

    it('should skip existing test cases when skipExisting is true', async () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
      });

      const { asyncTestCaseStorage } = require('@/services/storage/asyncTestCaseStorage');
      asyncTestCaseStorage.getAll.mockResolvedValue([
        { id: 'existing-id', name: 'Test Case 1' },
      ]);

      const stats = await migrateToOpenSearch({ skipExisting: true });

      expect(stats.testCases.skipped).toBe(1);
      expect(stats.testCases.migrated).toBe(0);
    });

    it('should migrate experiments to OpenSearch', async () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const { asyncBenchmarkStorage } = require('@/services/storage/asyncBenchmarkStorage');

      const stats = await migrateToOpenSearch();

      expect(stats.experiments.total).toBe(1);
      expect(stats.experiments.migrated).toBe(1);
      expect(asyncBenchmarkStorage.save).toHaveBeenCalled();
    });

    it('should migrate reports to OpenSearch', async () => {
      mockLocalStorage._setStore({
        test_case_runs: JSON.stringify({ 'tc-1': [mockReport] }),
      });

      const { asyncRunStorage } = require('@/services/storage/asyncRunStorage');

      const stats = await migrateToOpenSearch();

      expect(stats.reports.total).toBe(1);
      expect(stats.reports.migrated).toBe(1);
      expect(asyncRunStorage.saveReport).toHaveBeenCalled();
    });

    it('should use legacy reports key when primary key is empty', async () => {
      mockLocalStorage._setStore({
        eval_reports_by_testcase: JSON.stringify({ 'tc-1': [mockReport] }),
      });

      const stats = await migrateToOpenSearch();

      expect(stats.reports.total).toBe(1);
    });

    it('should handle dry run mode', async () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
      });

      const { asyncTestCaseStorage } = require('@/services/storage/asyncTestCaseStorage');

      const stats = await migrateToOpenSearch({ dryRun: true });

      expect(stats.testCases.total).toBe(1);
      expect(stats.testCases.migrated).toBe(1);
      expect(asyncTestCaseStorage.create).not.toHaveBeenCalled();
    });

    it('should call onProgress callback', async () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
      });

      const onProgress = jest.fn();

      await migrateToOpenSearch({ onProgress });

      expect(onProgress).toHaveBeenCalled();
    });

    it('should handle test case migration errors', async () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
      });

      const { asyncTestCaseStorage } = require('@/services/storage/asyncTestCaseStorage');
      asyncTestCaseStorage.getAll.mockResolvedValue([]); // No existing test cases
      asyncTestCaseStorage.create.mockRejectedValueOnce(new Error('OpenSearch error'));

      const stats = await migrateToOpenSearch({ skipExisting: false });

      expect(stats.testCases.errors).toHaveLength(1);
      expect(stats.testCases.errors[0]).toContain('Failed to migrate test case');
    });

    it('should handle experiment migration errors', async () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const { asyncBenchmarkStorage } = require('@/services/storage/asyncBenchmarkStorage');
      asyncBenchmarkStorage.save.mockRejectedValue(new Error('Save failed'));

      const stats = await migrateToOpenSearch();

      expect(stats.experiments.errors).toHaveLength(1);
    });

    it('should handle report migration errors', async () => {
      mockLocalStorage._setStore({
        test_case_runs: JSON.stringify({ 'tc-1': [mockReport] }),
      });

      const { asyncRunStorage } = require('@/services/storage/asyncRunStorage');
      asyncRunStorage.saveReport.mockRejectedValue(new Error('Save failed'));

      const stats = await migrateToOpenSearch();

      expect(stats.reports.errors).toHaveLength(1);
    });

    it('should remap test case IDs in experiments', async () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const { asyncTestCaseStorage } = require('@/services/storage/asyncTestCaseStorage');
      const { asyncBenchmarkStorage } = require('@/services/storage/asyncBenchmarkStorage');

      // Ensure no existing test cases so new ones are created
      asyncTestCaseStorage.getAll.mockResolvedValue([]);
      asyncBenchmarkStorage.getAll.mockResolvedValue([]);

      await migrateToOpenSearch({ skipExisting: false });

      // Check that the experiment was saved with remapped test case ID
      expect(asyncBenchmarkStorage.save).toHaveBeenCalledWith(
        expect.objectContaining({
          testCaseIds: expect.arrayContaining([expect.stringContaining('new-')]),
        })
      );
    });

    it('should warn when test case ID mapping not found', async () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      await migrateToOpenSearch();

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test case ID mapping not found')
      );
    });

    it('should handle getAll failures gracefully', async () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
      });

      const { asyncTestCaseStorage } = require('@/services/storage/asyncTestCaseStorage');
      asyncTestCaseStorage.getAll.mockRejectedValue(new Error('Connection failed'));

      // Should not throw and should continue migration
      const stats = await migrateToOpenSearch({ skipExisting: true });

      expect(stats.testCases.total).toBe(1);
    });
  });

  describe('clearLocalStorageData', () => {
    it('should clear all storage keys', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
        experiments: JSON.stringify({}),
        test_case_runs: JSON.stringify({}),
        eval_reports_by_testcase: JSON.stringify({}),
        eval_annotations: JSON.stringify({}),
        test_cases_seeded: 'true',
        test_cases_migration_v1: 'true',
      });

      clearLocalStorageData();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('test_cases');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('experiments');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('test_case_runs');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('eval_reports_by_testcase');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('eval_annotations');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('test_cases_seeded');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('test_cases_migration_v1');
    });

    it('should handle removeItem errors gracefully', () => {
      mockLocalStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      // Should not throw
      expect(() => clearLocalStorageData()).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('exportLocalStorageData', () => {
    it('should export data as JSON string', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([mockTestCase]),
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
        test_case_runs: JSON.stringify({ 'tc-1': [mockReport] }),
      });

      const exported = exportLocalStorageData();
      const parsed = JSON.parse(exported);

      expect(parsed.version).toBe('1.0');
      expect(parsed.exportDate).toBeDefined();
      expect(parsed.testCases).toHaveLength(1);
      expect(parsed.experiments).toHaveLength(1);
      expect(parsed.reports).toHaveLength(1);
    });

    it('should export empty arrays when localStorage is empty', () => {
      const exported = exportLocalStorageData();
      const parsed = JSON.parse(exported);

      expect(parsed.testCases).toEqual([]);
      expect(parsed.experiments).toEqual([]);
      expect(parsed.reports).toEqual([]);
    });

    it('should format JSON with indentation', () => {
      const exported = exportLocalStorageData();

      // Pretty printed JSON has newlines
      expect(exported).toContain('\n');
    });
  });
});
