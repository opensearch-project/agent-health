/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Experiment, ExperimentRun } from '@/types';

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
import { experimentStorage } from '@/services/experimentStorage';

describe('ExperimentStorage', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  const mockExperiment: Experiment = {
    id: 'exp-1',
    name: 'Test Experiment',
    description: 'Test description',
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const mockRun: ExperimentRun = {
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
      const result = experimentStorage.getAll();
      expect(result).toEqual([]);
    });

    it('should return experiments sorted by updatedAt descending', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({
          'exp-1': { ...mockExperiment, id: 'exp-1', updatedAt: '2024-01-01T00:00:00Z' },
          'exp-2': { ...mockExperiment, id: 'exp-2', updatedAt: '2024-01-03T00:00:00Z' },
          'exp-3': { ...mockExperiment, id: 'exp-3', updatedAt: '2024-01-02T00:00:00Z' },
        }),
      });

      const result = experimentStorage.getAll();
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('exp-2');
      expect(result[1].id).toBe('exp-3');
      expect(result[2].id).toBe('exp-1');
    });

    it('should handle invalid JSON gracefully', () => {
      mockLocalStorage._setStore({
        experiments: 'invalid json',
      });

      const result = experimentStorage.getAll();
      expect(result).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('should return null when experiment not found', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const result = experimentStorage.getById('non-existent');
      expect(result).toBeNull();
    });

    it('should return the experiment when found', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const result = experimentStorage.getById('exp-1');
      expect(result).toBeDefined();
      expect(result?.name).toBe('Test Experiment');
    });
  });

  describe('save', () => {
    it('should create a new experiment', () => {
      const newExperiment: Experiment = {
        ...mockExperiment,
        id: 'exp-new',
        createdAt: undefined as unknown as string, // Will be set by save
      };

      experimentStorage.save(newExperiment);

      const saved = experimentStorage.getById('exp-new');
      expect(saved).toBeDefined();
      expect(saved?.createdAt).toBeDefined();
      expect(saved?.runs).toEqual([]);
    });

    it('should update an existing experiment', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const updatedExperiment = { ...mockExperiment, name: 'Updated Name' };
      experimentStorage.save(updatedExperiment);

      const result = experimentStorage.getById('exp-1');
      expect(result?.name).toBe('Updated Name');
    });

    it('should update updatedAt timestamp', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      const oldUpdatedAt = mockExperiment.updatedAt;
      experimentStorage.save(mockExperiment);

      const result = experimentStorage.getById('exp-1');
      expect(result?.updatedAt).not.toBe(oldUpdatedAt);
    });

    it('should throw error when localStorage.setItem fails', () => {
      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage quota exceeded');
      });

      expect(() => experimentStorage.save(mockExperiment)).toThrow('Failed to save experiment');
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({
          'exp-1': mockExperiment,
          'exp-2': { ...mockExperiment, id: 'exp-2' },
        }),
      });
    });

    it('should return false when experiment not found', () => {
      const result = experimentStorage.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should delete the experiment and return true', () => {
      const result = experimentStorage.delete('exp-1');
      expect(result).toBe(true);

      const remaining = experimentStorage.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('exp-2');
    });

    it('should return false when localStorage operation fails', () => {
      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      const result = experimentStorage.delete('exp-1');
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('getCount', () => {
    it('should return 0 when no experiments', () => {
      expect(experimentStorage.getCount()).toBe(0);
    });

    it('should return the count of experiments', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({
          'exp-1': mockExperiment,
          'exp-2': { ...mockExperiment, id: 'exp-2' },
          'exp-3': { ...mockExperiment, id: 'exp-3' },
        }),
      });

      expect(experimentStorage.getCount()).toBe(3);
    });
  });

  describe('getRuns', () => {
    it('should return empty array when experiment not found', () => {
      const result = experimentStorage.getRuns('non-existent');
      expect(result).toEqual([]);
    });

    it('should return runs sorted by createdAt descending', () => {
      const experimentWithRuns: Experiment = {
        ...mockExperiment,
        runs: [
          { ...mockRun, id: 'run-1', createdAt: '2024-01-01T00:00:00Z' },
          { ...mockRun, id: 'run-3', createdAt: '2024-01-03T00:00:00Z' },
          { ...mockRun, id: 'run-2', createdAt: '2024-01-02T00:00:00Z' },
        ],
      };
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': experimentWithRuns }),
      });

      const result = experimentStorage.getRuns('exp-1');
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('run-3');
      expect(result[1].id).toBe('run-2');
      expect(result[2].id).toBe('run-1');
    });

    it('should handle experiment without runs array', () => {
      const experimentWithoutRuns = { ...mockExperiment, runs: undefined };
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': experimentWithoutRuns }),
      });

      const result = experimentStorage.getRuns('exp-1');
      expect(result).toEqual([]);
    });
  });

  describe('getRunById', () => {
    beforeEach(() => {
      const experimentWithRuns: Experiment = {
        ...mockExperiment,
        runs: [mockRun, { ...mockRun, id: 'run-2' }],
      };
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': experimentWithRuns }),
      });
    });

    it('should return null when experiment not found', () => {
      const result = experimentStorage.getRunById('non-existent', 'run-1');
      expect(result).toBeNull();
    });

    it('should return null when run not found', () => {
      const result = experimentStorage.getRunById('exp-1', 'non-existent');
      expect(result).toBeNull();
    });

    it('should return the run when found', () => {
      const result = experimentStorage.getRunById('exp-1', 'run-1');
      expect(result).toBeDefined();
      expect(result?.id).toBe('run-1');
    });
  });

  describe('saveRun', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });
    });

    it('should throw error when experiment not found', () => {
      expect(() => experimentStorage.saveRun('non-existent', mockRun)).toThrow(
        'Experiment not found'
      );
    });

    it('should add a new run to the experiment', () => {
      experimentStorage.saveRun('exp-1', mockRun);

      const runs = experimentStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-1');
    });

    it('should update an existing run', () => {
      experimentStorage.saveRun('exp-1', mockRun);
      experimentStorage.saveRun('exp-1', { ...mockRun, name: 'Updated Run' });

      const runs = experimentStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
      expect(runs[0].name).toBe('Updated Run');
    });

    it('should initialize runs array if undefined', () => {
      const experimentWithoutRuns = { ...mockExperiment, runs: undefined };
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': experimentWithoutRuns }),
      });

      experimentStorage.saveRun('exp-1', mockRun);

      const runs = experimentStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
    });
  });

  describe('deleteRun', () => {
    beforeEach(() => {
      const experimentWithRuns: Experiment = {
        ...mockExperiment,
        runs: [mockRun, { ...mockRun, id: 'run-2' }],
      };
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': experimentWithRuns }),
      });
    });

    it('should return false when experiment not found', () => {
      const result = experimentStorage.deleteRun('non-existent', 'run-1');
      expect(result).toBe(false);
    });

    it('should return false when run not found', () => {
      const result = experimentStorage.deleteRun('exp-1', 'non-existent');
      expect(result).toBe(false);
    });

    it('should delete the run and return true', () => {
      const result = experimentStorage.deleteRun('exp-1', 'run-1');
      expect(result).toBe(true);

      const runs = experimentStorage.getRuns('exp-1');
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-2');
    });

    it('should return false when experiment has no runs array', () => {
      const experimentWithoutRuns = { ...mockExperiment, runs: undefined };
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': experimentWithoutRuns }),
      });

      const result = experimentStorage.deleteRun('exp-1', 'run-1');
      expect(result).toBe(false);
    });
  });

  describe('generateExperimentId', () => {
    it('should generate unique IDs starting with exp-', () => {
      const id1 = experimentStorage.generateExperimentId();
      const id2 = experimentStorage.generateExperimentId();

      expect(id1).toMatch(/^exp-/);
      expect(id2).toMatch(/^exp-/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateRunId', () => {
    it('should generate unique IDs starting with run-', () => {
      const id1 = experimentStorage.generateRunId();
      const id2 = experimentStorage.generateRunId();

      expect(id1).toMatch(/^run-/);
      expect(id2).toMatch(/^run-/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('clearAll', () => {
    it('should remove all experiments from localStorage', () => {
      mockLocalStorage._setStore({
        experiments: JSON.stringify({ 'exp-1': mockExperiment }),
      });

      experimentStorage.clearAll();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('experiments');
      expect(consoleLogSpy).toHaveBeenCalledWith('All experiments cleared');
    });

    it('should handle errors gracefully', () => {
      mockLocalStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      experimentStorage.clearAll();

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error clearing experiments:', expect.any(Error));
    });
  });
});
