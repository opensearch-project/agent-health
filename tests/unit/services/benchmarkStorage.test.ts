/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, BenchmarkRun } from '@/types';

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
    _getStore: () => store,
    _setStore: (newStore: Record<string, string>) => {
      store = { ...newStore };
    },
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
});

// Import after mocking
import { benchmarkStorage } from '@/services/benchmarkStorage';

describe('BenchmarkStorage', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  const mockBenchmark: Benchmark = {
    id: 'exp-1',
    name: 'Test Benchmark',
    description: 'Test description',
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [{
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      testCaseIds: ['tc-1', 'tc-2'],
    }],
  };

  const mockRun: BenchmarkRun = {
    id: 'run-1',
    name: 'Test Run',
    createdAt: '2024-01-01T00:00:00Z',
    agentKey: 'test-agent',
    modelId: 'test-model',
    status: 'completed',
    results: {},
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalStorage.clear();
    mockLocalStorage._setStore({});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe('getAll', () => {
    it('should return empty array when localStorage is empty', () => {
      const result = benchmarkStorage.getAll();
      expect(result).toEqual([]);
    });

    it('should return experiments sorted by updatedAt descending', () => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({
          'exp-1': { ...mockBenchmark, id: 'exp-1', updatedAt: '2024-01-01T00:00:00Z' },
          'exp-2': { ...mockBenchmark, id: 'exp-2', updatedAt: '2024-01-03T00:00:00Z' },
          'exp-3': { ...mockBenchmark, id: 'exp-3', updatedAt: '2024-01-02T00:00:00Z' },
        }),
      });

      const result = benchmarkStorage.getAll();
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('exp-2');
      expect(result[1].id).toBe('exp-3');
      expect(result[2].id).toBe('exp-1');
    });

    it('should handle invalid JSON gracefully', () => {
      mockLocalStorage._setStore({
        benchmarks: 'invalid json',
      });

      const result = benchmarkStorage.getAll();
      expect(result).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('should return null when experiment not found', () => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': mockBenchmark }),
      });

      const result = benchmarkStorage.getById('non-existent');
      expect(result).toBeNull();
    });

    it('should return the experiment when found', () => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': mockBenchmark }),
      });

      const result = benchmarkStorage.getById('exp-1');
      expect(result).toBeDefined();
      expect(result?.name).toBe('Test Benchmark');
    });
  });

  describe('save', () => {
    it('should create a new experiment', () => {
      const newExperiment: Benchmark = {
        ...mockBenchmark,
        id: 'exp-new',
        createdAt: undefined as unknown as string, // Will be set by save
      };

      benchmarkStorage.save(newExperiment);

      const saved = benchmarkStorage.getById('exp-new');
      expect(saved).toBeDefined();
      expect(saved?.createdAt).toBeDefined();
      expect(saved?.runs).toEqual([]);
    });

    it('should update an existing experiment', () => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': mockBenchmark }),
      });

      const updatedExperiment = { ...mockBenchmark, name: 'Updated Name' };
      benchmarkStorage.save(updatedExperiment);

      const result = benchmarkStorage.getById('exp-1');
      expect(result?.name).toBe('Updated Name');
    });

    it('should update updatedAt timestamp', () => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': mockBenchmark }),
      });

      const oldUpdatedAt = mockBenchmark.updatedAt;
      benchmarkStorage.save(mockBenchmark);

      const result = benchmarkStorage.getById('exp-1');
      expect(result?.updatedAt).not.toBe(oldUpdatedAt);
    });

    it('should throw error when localStorage.setItem fails', () => {
      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage quota exceeded');
      });

      expect(() => benchmarkStorage.save(mockBenchmark)).toThrow('Failed to save benchmark');
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({
          'exp-1': mockBenchmark,
          'exp-2': { ...mockBenchmark, id: 'exp-2' },
        }),
      });
    });

    it('should return false when experiment not found', () => {
      const result = benchmarkStorage.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should delete the experiment and return true', () => {
      const result = benchmarkStorage.delete('exp-1');
      expect(result).toBe(true);

      const remaining = benchmarkStorage.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('exp-2');
    });

    it('should return false when localStorage operation fails', () => {
      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      const result = benchmarkStorage.delete('exp-1');
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('getCount', () => {
    it('should return 0 when no experiments', () => {
      expect(benchmarkStorage.getCount()).toBe(0);
    });

    it('should return the count of experiments', () => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({
          'exp-1': mockBenchmark,
          'exp-2': { ...mockBenchmark, id: 'exp-2' },
          'exp-3': { ...mockBenchmark, id: 'exp-3' },
        }),
      });

      expect(benchmarkStorage.getCount()).toBe(3);
    });
  });

  describe('getRuns', () => {
    it('should return empty array when experiment not found', () => {
      const result = benchmarkStorage.getRuns('non-existent');
      expect(result).toEqual([]);
    });

    it('should return runs sorted by createdAt descending', () => {
      const experimentWithRuns: Benchmark = {
        ...mockBenchmark,
        runs: [
          { ...mockRun, id: 'run-1', createdAt: '2024-01-01T00:00:00Z' },
          { ...mockRun, id: 'run-3', createdAt: '2024-01-03T00:00:00Z' },
          { ...mockRun, id: 'run-2', createdAt: '2024-01-02T00:00:00Z' },
        ],
      };
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': experimentWithRuns }),
      });

      const result = benchmarkStorage.getRuns('exp-1');
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('run-3');
      expect(result[1].id).toBe('run-2');
      expect(result[2].id).toBe('run-1');
    });

    it('should handle experiment without runs array', () => {
      const experimentWithoutRuns = { ...mockBenchmark, runs: undefined };
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': experimentWithoutRuns }),
      });

      const result = benchmarkStorage.getRuns('exp-1');
      expect(result).toEqual([]);
    });
  });

  describe('getRunById', () => {
    beforeEach(() => {
      const experimentWithRuns: Benchmark = {
        ...mockBenchmark,
        runs: [mockRun, { ...mockRun, id: 'run-2' }],
      };
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': experimentWithRuns }),
      });
    });

    it('should return null when experiment not found', () => {
      const result = benchmarkStorage.getRunById('non-existent', 'run-1');
      expect(result).toBeNull();
    });

    it('should return null when run not found', () => {
      const result = benchmarkStorage.getRunById('exp-1', 'non-existent');
      expect(result).toBeNull();
    });

    it('should return the run when found', () => {
      const result = benchmarkStorage.getRunById('exp-1', 'run-1');
      expect(result).toBeDefined();
      expect(result?.id).toBe('run-1');
    });
  });

  describe('saveRun', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': mockBenchmark }),
      });
    });

    it('should throw error when experiment not found', () => {
      expect(() => benchmarkStorage.saveRun('non-existent', mockRun)).toThrow(
        'Benchmark not found'
      );
    });

    it('should add a new run to the experiment', () => {
      benchmarkStorage.saveRun('exp-1', mockRun);

      const runs = benchmarkStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-1');
    });

    it('should update an existing run', () => {
      benchmarkStorage.saveRun('exp-1', mockRun);
      benchmarkStorage.saveRun('exp-1', { ...mockRun, name: 'Updated Run' });

      const runs = benchmarkStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
      expect(runs[0].name).toBe('Updated Run');
    });

    it('should initialize runs array if undefined', () => {
      const experimentWithoutRuns = { ...mockBenchmark, runs: undefined };
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': experimentWithoutRuns }),
      });

      benchmarkStorage.saveRun('exp-1', mockRun);

      const runs = benchmarkStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
    });
  });

  describe('deleteRun', () => {
    beforeEach(() => {
      const experimentWithRuns: Benchmark = {
        ...mockBenchmark,
        runs: [mockRun, { ...mockRun, id: 'run-2' }],
      };
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': experimentWithRuns }),
      });
    });

    it('should return false when experiment not found', () => {
      const result = benchmarkStorage.deleteRun('non-existent', 'run-1');
      expect(result).toBe(false);
    });

    it('should return false when run not found', () => {
      const result = benchmarkStorage.deleteRun('exp-1', 'non-existent');
      expect(result).toBe(false);
    });

    it('should delete the run and return true', () => {
      const result = benchmarkStorage.deleteRun('exp-1', 'run-1');
      expect(result).toBe(true);

      const runs = benchmarkStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-2');
    });

    it('should return false when experiment has no runs array', () => {
      const experimentWithoutRuns = { ...mockBenchmark, runs: undefined };
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': experimentWithoutRuns }),
      });

      const result = benchmarkStorage.deleteRun('exp-1', 'run-1');
      expect(result).toBe(false);
    });
  });

  describe('generateBenchmarkId', () => {
    it('should generate unique IDs starting with bench-', () => {
      const id1 = benchmarkStorage.generateBenchmarkId();
      const id2 = benchmarkStorage.generateBenchmarkId();

      expect(id1).toMatch(/^bench-/);
      expect(id2).toMatch(/^bench-/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateRunId', () => {
    it('should generate unique IDs starting with run-', () => {
      const id1 = benchmarkStorage.generateRunId();
      const id2 = benchmarkStorage.generateRunId();

      expect(id1).toMatch(/^run-/);
      expect(id2).toMatch(/^run-/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('clearAll', () => {
    it('should remove all experiments from localStorage', () => {
      mockLocalStorage._setStore({
        benchmarks: JSON.stringify({ 'exp-1': mockBenchmark }),
      });

      benchmarkStorage.clearAll();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('benchmarks');
      expect(consoleLogSpy).toHaveBeenCalledWith('All benchmarks cleared');
    });

    it('should handle errors gracefully', () => {
      mockLocalStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      benchmarkStorage.clearAll();

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error clearing benchmarks:', expect.any(Error));
    });
  });
});
