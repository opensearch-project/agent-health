/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { asyncTestCaseStorage, CreateTestCaseInput, UpdateTestCaseInput } from '@/services/storage/asyncTestCaseStorage';
import { testCaseStorage as opensearchTestCases } from '@/services/storage/opensearchClient';
import type { AgentContextItem } from '@/types';

// Mock the OpenSearch client
jest.mock('@/services/storage/opensearchClient', () => ({
  testCaseStorage: {
    getAll: jest.fn(),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    getVersions: jest.fn(),
    getVersion: jest.fn(),
    bulkCreate: jest.fn(),
  },
}));

const mockOsTestCases = opensearchTestCases as jest.Mocked<typeof opensearchTestCases>;

/** Wrap array in the paginated response format that getAll() now returns */
function mockGetAllResult(testCases: any[]) {
  return { testCases, total: testCases.length };
}

describe('AsyncTestCaseStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a mock storage test case
  const createMockStorageTestCase = (id: string = 'tc-1') => ({
    id,
    name: 'Test Case 1',
    description: 'Test description',
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'What is the status of pod my-pod?',
    context: [
      { type: 'kubernetes_pod', content: 'pod-info-here' },
    ],
    tools: [
      { name: 'kubectl_get', description: 'Get Kubernetes resources' },
    ],
    expectedPPL: 'source=logs | where pod="my-pod"',
    expectedOutcomes: ['Agent should identify the pod status'],
    expectedTrajectory: [
      { step: 1, description: 'Check pod status', requiredTools: ['kubectl_get'] },
    ],
    labels: ['category:RCA', 'difficulty:Medium'],
    category: 'RCA',
    subcategory: 'Kubernetes',
    difficulty: 'Medium' as const,
    tags: ['promoted'],
    author: 'test-author',
  });

  // Helper to create test case input
  const createMockCreateInput = (): CreateTestCaseInput => ({
    name: 'New Test Case',
    description: 'New description',
    labels: ['category:RCA', 'difficulty:Easy'],
    initialPrompt: 'Test prompt',
    context: [{ description: 'kubernetes_pod', value: 'content' }] as AgentContextItem[],
    tools: [],
    expectedOutcomes: ['Expected outcome 1'],
    isPromoted: true,
  });

  describe('getAll', () => {
    it('returns all test cases converted to app format', async () => {
      const mockStorageTestCases = [
        createMockStorageTestCase('tc-1'),
        createMockStorageTestCase('tc-2'),
      ];
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult(mockStorageTestCases));

      const result = await asyncTestCaseStorage.getAll();

      expect(mockOsTestCases.getAll).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('tc-1');
      expect(result[1].id).toBe('tc-2');
    });

    it('converts labels and legacy fields correctly', async () => {
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([createMockStorageTestCase()]));

      const result = await asyncTestCaseStorage.getAll();

      expect(result[0].labels).toEqual(['category:RCA', 'difficulty:Medium']);
      expect(result[0].category).toBe('RCA');
      expect(result[0].difficulty).toBe('Medium');
    });

    it('handles test cases with no labels (derives from legacy fields)', async () => {
      const tcWithNoLabels = {
        ...createMockStorageTestCase(),
        labels: undefined,
        category: 'Alerts',
        difficulty: 'Hard' as const,
      };
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([tcWithNoLabels]));

      const result = await asyncTestCaseStorage.getAll();

      expect(result[0].labels).toContain('category:Alerts');
      expect(result[0].labels).toContain('difficulty:Hard');
    });

    it('handles test cases with empty arrays', async () => {
      const tcWithEmptyArrays = {
        ...createMockStorageTestCase(),
        context: undefined,
        expectedTrajectory: undefined,
      };
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([tcWithEmptyArrays]));

      const result = await asyncTestCaseStorage.getAll();

      expect(result[0].context).toEqual([]);
      expect(result[0].expectedTrajectory).toEqual([]);
    });

    it('handles isPromoted from tags', async () => {
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([createMockStorageTestCase()]));

      const result = await asyncTestCaseStorage.getAll();

      expect(result[0].isPromoted).toBe(true);
    });

    it('handles non-promoted test cases', async () => {
      const notPromoted = { ...createMockStorageTestCase(), tags: [] };
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([notPromoted]));

      const result = await asyncTestCaseStorage.getAll();

      expect(result[0].isPromoted).toBe(false);
    });
  });

  describe('getPromoted', () => {
    it('returns only promoted test cases', async () => {
      const promoted = createMockStorageTestCase('tc-1');
      const notPromoted = { ...createMockStorageTestCase('tc-2'), tags: [] };
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([promoted, notPromoted]));

      const result = await asyncTestCaseStorage.getPromoted();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tc-1');
    });
  });

  describe('getById', () => {
    it('returns test case when found', async () => {
      mockOsTestCases.getById.mockResolvedValue(createMockStorageTestCase());

      const result = await asyncTestCaseStorage.getById('tc-1');

      expect(mockOsTestCases.getById).toHaveBeenCalledWith('tc-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('tc-1');
      expect(result?.name).toBe('Test Case 1');
    });

    it('returns null when not found', async () => {
      mockOsTestCases.getById.mockResolvedValue(null);

      const result = await asyncTestCaseStorage.getById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates a new test case', async () => {
      const created = createMockStorageTestCase('new-tc');
      mockOsTestCases.create.mockResolvedValue(created);

      const result = await asyncTestCaseStorage.create(createMockCreateInput());

      expect(mockOsTestCases.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('new-tc');
    });

    it('adds promoted tag when isPromoted is true', async () => {
      const created = createMockStorageTestCase('new-tc');
      mockOsTestCases.create.mockResolvedValue(created);

      await asyncTestCaseStorage.create({
        ...createMockCreateInput(),
        tags: [],
        isPromoted: true,
      });

      expect(mockOsTestCases.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['promoted']),
        })
      );
    });

    it('builds labels from legacy fields when no labels provided', async () => {
      const created = createMockStorageTestCase('new-tc');
      mockOsTestCases.create.mockResolvedValue(created);

      await asyncTestCaseStorage.create({
        name: 'Test',
        initialPrompt: 'Test prompt',
        context: [],
        category: 'Alerts',
        difficulty: 'Hard',
      });

      expect(mockOsTestCases.create).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.arrayContaining(['category:Alerts', 'difficulty:Hard']),
        })
      );
    });
  });

  describe('update', () => {
    it('updates a test case', async () => {
      const current = createMockStorageTestCase('tc-1');
      const updated = { ...current, name: 'Updated Name' };
      mockOsTestCases.getById.mockResolvedValue(current);
      mockOsTestCases.update.mockResolvedValue(updated);

      const result = await asyncTestCaseStorage.update('tc-1', { name: 'Updated Name' });

      expect(mockOsTestCases.update).toHaveBeenCalledTimes(1);
      expect(result?.name).toBe('Updated Name');
    });

    it('returns null when test case not found', async () => {
      mockOsTestCases.getById.mockResolvedValue(null);

      const result = await asyncTestCaseStorage.update('non-existent', { name: 'Test' });

      expect(result).toBeNull();
      expect(mockOsTestCases.update).not.toHaveBeenCalled();
    });

    it('calls update with the new name', async () => {
      const current = createMockStorageTestCase('tc-1');
      mockOsTestCases.getById.mockResolvedValue(current);
      mockOsTestCases.update.mockResolvedValue({ ...current, name: 'New Name' });

      await asyncTestCaseStorage.update('tc-1', { name: 'New Name' });

      expect(mockOsTestCases.update).toHaveBeenCalledWith(
        'tc-1',
        expect.objectContaining({
          name: 'New Name',
        })
      );
    });
  });

  describe('delete', () => {
    it('returns true when deletion succeeds', async () => {
      mockOsTestCases.delete.mockResolvedValue({ deleted: 1 });

      const result = await asyncTestCaseStorage.delete('tc-1');

      expect(mockOsTestCases.delete).toHaveBeenCalledWith('tc-1');
      expect(result).toBe(true);
    });

    it('returns false when nothing deleted', async () => {
      mockOsTestCases.delete.mockResolvedValue({ deleted: 0 });

      const result = await asyncTestCaseStorage.delete('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('setPromoted', () => {
    it('adds promoted tag when isPromoted is true', async () => {
      const current = { ...createMockStorageTestCase(), tags: [] };
      mockOsTestCases.getById.mockResolvedValue(current);
      mockOsTestCases.update.mockResolvedValue({ ...current, tags: ['promoted'] });

      const result = await asyncTestCaseStorage.setPromoted('tc-1', true);

      expect(result).toBe(true);
      expect(mockOsTestCases.update).toHaveBeenCalledWith(
        'tc-1',
        expect.objectContaining({
          tags: ['promoted'],
        })
      );
    });

    it('removes promoted tag when isPromoted is false', async () => {
      const current = createMockStorageTestCase(); // has promoted tag
      mockOsTestCases.getById.mockResolvedValue(current);
      mockOsTestCases.update.mockResolvedValue({ ...current, tags: [] });

      const result = await asyncTestCaseStorage.setPromoted('tc-1', false);

      expect(result).toBe(true);
      expect(mockOsTestCases.update).toHaveBeenCalledWith(
        'tc-1',
        expect.objectContaining({
          tags: expect.not.arrayContaining(['promoted']),
        })
      );
    });

    it('returns false when test case not found', async () => {
      mockOsTestCases.getById.mockResolvedValue(null);

      const result = await asyncTestCaseStorage.setPromoted('non-existent', true);

      expect(result).toBe(false);
      expect(mockOsTestCases.update).not.toHaveBeenCalled();
    });

    it('does not duplicate promoted tag if already present', async () => {
      const current = createMockStorageTestCase(); // already has promoted tag
      mockOsTestCases.getById.mockResolvedValue(current);
      mockOsTestCases.update.mockResolvedValue(current);

      await asyncTestCaseStorage.setPromoted('tc-1', true);

      // Should only have one 'promoted' tag
      const updateCall = mockOsTestCases.update.mock.calls[0][1];
      const promotedCount = (updateCall.tags as string[]).filter((t) => t === 'promoted').length;
      expect(promotedCount).toBe(1);
    });
  });

  describe('getVersions', () => {
    it('returns all versions of a test case', async () => {
      const versions = [
        { ...createMockStorageTestCase(), version: 1 },
        { ...createMockStorageTestCase(), version: 2, initialPrompt: 'Updated prompt' },
      ];
      mockOsTestCases.getVersions.mockResolvedValue(versions);

      const result = await asyncTestCaseStorage.getVersions('tc-1');

      expect(mockOsTestCases.getVersions).toHaveBeenCalledWith('tc-1');
      expect(result).toHaveLength(2);
      expect(result[0].version).toBe(1);
      expect(result[1].version).toBe(2);
    });

    it('converts version data correctly', async () => {
      mockOsTestCases.getVersions.mockResolvedValue([createMockStorageTestCase()]);

      const result = await asyncTestCaseStorage.getVersions('tc-1');

      expect(result[0]).toHaveProperty('version');
      expect(result[0]).toHaveProperty('createdAt');
      expect(result[0]).toHaveProperty('initialPrompt');
      expect(result[0]).toHaveProperty('context');
      expect(result[0]).toHaveProperty('expectedOutcomes');
    });
  });

  describe('getVersion', () => {
    it('returns specific version when found', async () => {
      mockOsTestCases.getVersion.mockResolvedValue(createMockStorageTestCase());

      const result = await asyncTestCaseStorage.getVersion('tc-1', 1);

      expect(mockOsTestCases.getVersion).toHaveBeenCalledWith('tc-1', 1);
      expect(result).not.toBeNull();
      expect(result?.version).toBe(1);
    });

    it('returns null when version not found', async () => {
      mockOsTestCases.getVersion.mockResolvedValue(null);

      const result = await asyncTestCaseStorage.getVersion('tc-1', 99);

      expect(result).toBeNull();
    });
  });

  describe('generateId', () => {
    it('generates unique test case IDs', () => {
      const id1 = asyncTestCaseStorage.generateId();
      const id2 = asyncTestCaseStorage.generateId();

      expect(id1).toMatch(/^tc-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^tc-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('getCategories', () => {
    it('returns unique categories from all test cases', async () => {
      const testCases = [
        { ...createMockStorageTestCase('tc-1'), category: 'RCA', labels: ['category:RCA'] },
        { ...createMockStorageTestCase('tc-2'), category: 'Alerts', labels: ['category:Alerts'] },
        { ...createMockStorageTestCase('tc-3'), category: 'RCA', labels: ['category:RCA'] },
      ];
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult(testCases));

      const result = await asyncTestCaseStorage.getCategories();

      expect(result).toHaveLength(2);
      expect(result).toContain('RCA');
      expect(result).toContain('Alerts');
    });

    it('returns sorted categories', async () => {
      const testCases = [
        { ...createMockStorageTestCase('tc-1'), category: 'Zebra', labels: ['category:Zebra'] },
        { ...createMockStorageTestCase('tc-2'), category: 'Alpha', labels: ['category:Alpha'] },
      ];
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult(testCases));

      const result = await asyncTestCaseStorage.getCategories();

      expect(result).toEqual(['Alpha', 'Zebra']);
    });
  });

  describe('getLabels', () => {
    it('returns unique labels from all test cases', async () => {
      const testCases = [
        { ...createMockStorageTestCase('tc-1'), labels: ['category:RCA', 'difficulty:Easy'] },
        { ...createMockStorageTestCase('tc-2'), labels: ['category:Alerts', 'difficulty:Easy'] },
      ];
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult(testCases));

      const result = await asyncTestCaseStorage.getLabels();

      expect(result).toHaveLength(3);
      expect(result).toContain('category:RCA');
      expect(result).toContain('category:Alerts');
      expect(result).toContain('difficulty:Easy');
    });

    it('handles test cases with no labels and no legacy fields', async () => {
      const testCases = [
        {
          ...createMockStorageTestCase('tc-1'),
          labels: undefined,
          category: undefined,
          subcategory: undefined,
          difficulty: undefined,
        },
      ];
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult(testCases));

      const result = await asyncTestCaseStorage.getLabels();

      expect(result).toEqual([]);
    });
  });

  describe('getCount', () => {
    it('returns the count of test cases', async () => {
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([
        createMockStorageTestCase('tc-1'),
        createMockStorageTestCase('tc-2'),
      ]));

      const result = await asyncTestCaseStorage.getCount();

      expect(result).toBe(2);
    });
  });

  describe('getPromotedCount', () => {
    it('returns count of promoted test cases', async () => {
      const promoted1 = createMockStorageTestCase('tc-1');
      const promoted2 = createMockStorageTestCase('tc-2');
      const notPromoted = { ...createMockStorageTestCase('tc-3'), tags: [] };
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([promoted1, promoted2, notPromoted]));

      const result = await asyncTestCaseStorage.getPromotedCount();

      expect(result).toBe(2);
    });
  });

  describe('bulkCreate', () => {
    it('bulk creates test cases', async () => {
      mockOsTestCases.bulkCreate.mockResolvedValue({ created: 3, errors: false });

      const testCases: CreateTestCaseInput[] = [
        createMockCreateInput(),
        { ...createMockCreateInput(), name: 'Test 2' },
      ];

      const result = await asyncTestCaseStorage.bulkCreate(testCases);

      expect(mockOsTestCases.bulkCreate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ created: 3, errors: false });
    });
  });

  describe('format conversion edge cases', () => {
    it('handles test case with undefined tags', async () => {
      const tcWithNoTags = { ...createMockStorageTestCase(), tags: undefined };
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([tcWithNoTags]));

      const result = await asyncTestCaseStorage.getAll();

      expect(result[0].isPromoted).toBe(false);
    });

    it('handles test case with no legacy fields and no labels', async () => {
      const tcWithNothing = {
        ...createMockStorageTestCase(),
        labels: [],
        category: undefined,
        subcategory: undefined,
        difficulty: undefined,
      };
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([tcWithNothing]));

      const result = await asyncTestCaseStorage.getAll();

      // Should use defaults
      expect(result[0].category).toBe('General');
      expect(result[0].difficulty).toBe('Medium');
    });
  });
});
