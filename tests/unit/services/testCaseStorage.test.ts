/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock the TEST_CASES import
jest.mock('@/data/testCases', () => ({
  TEST_CASES: [
    {
      id: 'predefined-tc-1',
      name: 'Predefined Test Case',
      description: 'A predefined test case',
      category: 'RCA',
      difficulty: 'Medium',
      currentVersion: 1,
      versions: [],
      isPromoted: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      initialPrompt: 'Test prompt',
      context: [],
      expectedTrajectory: [],
    },
  ],
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
import { testCaseStorage, CreateTestCaseInput, UpdateTestCaseInput } from '@/services/testCaseStorage';

describe('TestCaseStorage', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalStorage.clear();
    mockLocalStorage._setStore({});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('getAll', () => {
    it('should return empty array when localStorage is empty', () => {
      const result = testCaseStorage.getAll();
      expect(result).toEqual([]);
    });

    it('should return test cases from localStorage', () => {
      const testCases = [
        { id: 'tc-1', name: 'Test Case 1' },
        { id: 'tc-2', name: 'Test Case 2' },
      ];
      mockLocalStorage._setStore({
        test_cases: JSON.stringify(testCases),
      });

      const result = testCaseStorage.getAll();
      expect(result).toHaveLength(2);
    });

    it('should handle invalid JSON gracefully', () => {
      mockLocalStorage._setStore({
        test_cases: 'invalid json',
      });

      const result = testCaseStorage.getAll();
      expect(result).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('should return null when test case not found', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([{ id: 'tc-1', name: 'Test 1' }]),
      });

      const result = testCaseStorage.getById('non-existent');
      expect(result).toBeNull();
    });

    it('should return the test case when found', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([{ id: 'tc-1', name: 'Test 1' }]),
      });

      const result = testCaseStorage.getById('tc-1');
      expect(result).toBeDefined();
      expect(result?.name).toBe('Test 1');
    });
  });

  describe('getPromoted', () => {
    it('should return only promoted test cases', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([
          { id: 'tc-1', name: 'Promoted', isPromoted: true },
          { id: 'tc-2', name: 'Not Promoted', isPromoted: false },
        ]),
      });

      const result = testCaseStorage.getPromoted();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Promoted');
    });
  });

  describe('create', () => {
    it('should create a new test case with generated ID', () => {
      const input: CreateTestCaseInput = {
        name: 'New Test Case',
        description: 'A new test case',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Test prompt',
        context: [],
        expectedTrajectory: [],
      };

      const result = testCaseStorage.create(input);

      expect(result.id).toMatch(/^tc-/);
      expect(result.name).toBe('New Test Case');
      expect(result.currentVersion).toBe(1);
      expect(result.versions).toHaveLength(1);
      expect(result.createdAt).toBeDefined();
    });

    it('should create test case with custom labels', () => {
      const input: CreateTestCaseInput = {
        name: 'Test with Labels',
        description: 'Description',
        labels: ['custom:label1', 'custom:label2'],
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Prompt',
        context: [],
        expectedTrajectory: [],
      };

      const result = testCaseStorage.create(input);

      expect(result.labels).toEqual(['custom:label1', 'custom:label2']);
    });

    it('should create default labels from category and difficulty', () => {
      const input: CreateTestCaseInput = {
        name: 'Test',
        description: 'Description',
        category: 'Analysis',
        subcategory: 'Logs',
        difficulty: 'Hard',
        initialPrompt: 'Prompt',
        context: [],
        expectedTrajectory: [],
      };

      const result = testCaseStorage.create(input);

      expect(result.labels).toContain('difficulty:Hard');
      expect(result.labels).toContain('category:Analysis');
      expect(result.labels).toContain('subcategory:Logs');
    });

    it('should set isPromoted based on input', () => {
      const promotedInput: CreateTestCaseInput = {
        name: 'Promoted TC',
        description: 'Desc',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Prompt',
        context: [],
        expectedTrajectory: [],
        isPromoted: true,
      };

      const result = testCaseStorage.create(promotedInput);
      expect(result.isPromoted).toBe(true);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      const existingTestCase = {
        id: 'tc-existing',
        name: 'Existing Test Case',
        description: 'Description',
        category: 'RCA',
        difficulty: 'Medium',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            createdAt: '2024-01-01T00:00:00Z',
            initialPrompt: 'Old prompt',
            context: [],
            expectedTrajectory: [],
          },
        ],
        isPromoted: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        initialPrompt: 'Old prompt',
        context: [],
        expectedTrajectory: [],
      };
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([existingTestCase]),
      });
    });

    it('should return null when test case not found', () => {
      const result = testCaseStorage.update('non-existent', { name: 'New Name' });
      expect(result).toBeNull();
    });

    it('should update metadata without creating new version', () => {
      const result = testCaseStorage.update('tc-existing', {
        name: 'Updated Name',
        description: 'Updated Description',
      });

      expect(result?.name).toBe('Updated Name');
      expect(result?.description).toBe('Updated Description');
      expect(result?.currentVersion).toBe(1); // No new version
    });

    it('should create new version when content changes', () => {
      const result = testCaseStorage.update('tc-existing', {
        initialPrompt: 'New prompt content',
      });

      expect(result?.currentVersion).toBe(2);
      expect(result?.versions).toHaveLength(2);
      expect(result?.initialPrompt).toBe('New prompt content');
    });

    it('should update category and difficulty', () => {
      const result = testCaseStorage.update('tc-existing', {
        category: 'New Category',
        difficulty: 'Hard',
      });

      expect(result?.category).toBe('New Category');
      expect(result?.difficulty).toBe('Hard');
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([
          { id: 'tc-1', name: 'Test 1' },
          { id: 'tc-2', name: 'Test 2' },
        ]),
      });
    });

    it('should return false when test case not found', () => {
      const result = testCaseStorage.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should delete the test case and return true', () => {
      const result = testCaseStorage.delete('tc-1');
      expect(result).toBe(true);

      const remaining = testCaseStorage.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('tc-2');
    });
  });

  describe('setPromoted', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([
          { id: 'tc-1', name: 'Test 1', isPromoted: false },
        ]),
      });
    });

    it('should return false when test case not found', () => {
      const result = testCaseStorage.setPromoted('non-existent', true);
      expect(result).toBe(false);
    });

    it('should update promoted status', () => {
      const result = testCaseStorage.setPromoted('tc-1', true);
      expect(result).toBe(true);

      const testCase = testCaseStorage.getById('tc-1');
      expect(testCase?.isPromoted).toBe(true);
    });
  });

  describe('getVersion', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([
          {
            id: 'tc-1',
            name: 'Test 1',
            currentVersion: 2,
            versions: [
              { version: 1, createdAt: '2024-01-01T00:00:00Z' },
              { version: 2, createdAt: '2024-01-02T00:00:00Z' },
            ],
          },
        ]),
      });
    });

    it('should return null when test case not found', () => {
      const result = testCaseStorage.getVersion('non-existent', 1);
      expect(result).toBeNull();
    });

    it('should return null when version not found', () => {
      const result = testCaseStorage.getVersion('tc-1', 99);
      expect(result).toBeNull();
    });

    it('should return the specific version', () => {
      const result = testCaseStorage.getVersion('tc-1', 1);
      expect(result?.version).toBe(1);
    });
  });

  describe('getVersions', () => {
    beforeEach(() => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([
          {
            id: 'tc-1',
            name: 'Test 1',
            currentVersion: 3,
            versions: [
              { version: 1, createdAt: '2024-01-01T00:00:00Z' },
              { version: 2, createdAt: '2024-01-02T00:00:00Z' },
              { version: 3, createdAt: '2024-01-03T00:00:00Z' },
            ],
          },
        ]),
      });
    });

    it('should return empty array when test case not found', () => {
      const result = testCaseStorage.getVersions('non-existent');
      expect(result).toEqual([]);
    });

    it('should return versions sorted by version number descending', () => {
      const result = testCaseStorage.getVersions('tc-1');
      expect(result).toHaveLength(3);
      expect(result[0].version).toBe(3);
      expect(result[1].version).toBe(2);
      expect(result[2].version).toBe(1);
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs starting with tc-', () => {
      const id1 = testCaseStorage.generateId();
      const id2 = testCaseStorage.generateId();

      expect(id1).toMatch(/^tc-/);
      expect(id2).toMatch(/^tc-/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('getCategories', () => {
    it('should return unique sorted categories', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([
          { id: 'tc-1', category: 'Zebra' },
          { id: 'tc-2', category: 'Apple' },
          { id: 'tc-3', category: 'Apple' },
        ]),
      });

      const result = testCaseStorage.getCategories();
      expect(result).toEqual(['Apple', 'Zebra']);
    });
  });

  describe('getCount', () => {
    it('should return the count of test cases', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([{ id: 'tc-1' }, { id: 'tc-2' }, { id: 'tc-3' }]),
      });

      expect(testCaseStorage.getCount()).toBe(3);
    });
  });

  describe('getPromotedCount', () => {
    it('should return the count of promoted test cases', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([
          { id: 'tc-1', isPromoted: true },
          { id: 'tc-2', isPromoted: false },
          { id: 'tc-3', isPromoted: true },
        ]),
      });

      expect(testCaseStorage.getPromotedCount()).toBe(2);
    });
  });

  describe('saveAll error handling', () => {
    it('should throw error when localStorage.setItem fails', () => {
      mockLocalStorage._setStore({
        test_cases: JSON.stringify([{ id: 'tc-existing', name: 'Test' }]),
      });

      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage quota exceeded');
      });

      expect(() => testCaseStorage.delete('tc-existing')).toThrow('Failed to save test cases');
    });
  });
});
