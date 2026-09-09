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
    getByIds: jest.fn(),
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

    // Regression coverage for the 168MB full-payload performance fix: list
    // views now call getAll({ summary: true, ... }) instead of a bare
    // getAll(). Assert the option plumbs through to the OpenSearch client
    // (opensearchClient.getAll({ fields: 'summary', ... })) unchanged, so a
    // future refactor of this passthrough can't silently drop it.
    it('passes summary=true through as fields: "summary" to the OpenSearch client', async () => {
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([createMockStorageTestCase()]));

      await asyncTestCaseStorage.getAll({ summary: true });

      expect(mockOsTestCases.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ fields: 'summary' }),
      );
    });

    it('omits fields when summary is not requested', async () => {
      mockOsTestCases.getAll.mockResolvedValue(mockGetAllResult([createMockStorageTestCase()]));

      await asyncTestCaseStorage.getAll();

      expect(mockOsTestCases.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ fields: undefined }),
      );
    });

    it('passes size/after through and returns a TestCasePage with `total` when size is set ' +
      '(the pattern Dashboard uses: summary + size=1 to read just the count)', async () => {
      mockOsTestCases.getAll.mockResolvedValue({
        testCases: [createMockStorageTestCase('tc-1')],
        total: 3941,
        after: 'tc-1',
        hasMore: true,
      });

      const page = await asyncTestCaseStorage.getAll({ summary: true, size: 1, after: 'cursor-x' });

      expect(mockOsTestCases.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ fields: 'summary', size: 1, after: 'cursor-x' }),
      );
      expect(page.total).toBe(3941);
      expect(page.testCases).toHaveLength(1);
      expect(page.after).toBe('tc-1');
      expect(page.hasMore).toBe(true);
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

  // Regression guard for the comparison page's category matrix (2026-08-27):
  // the name lookup used to call the unpaginated getAll() — every test case
  // in the whole storage backend, full body included — instead of fetching
  // only the ids it actually needs. getByIds must chunk (same policy as
  // asyncRunStorage.getReportsByIds) so a comparison over many runs' worth
  // of test cases never issues one unbounded `?ids=<all>` request nor an
  // unbounded burst of parallel ones.
  describe('getByIds', () => {
    it('returns an empty array for no ids without hitting the API', async () => {
      const result = await asyncTestCaseStorage.getByIds([]);
      expect(result).toEqual([]);
      expect(mockOsTestCases.getByIds).not.toHaveBeenCalled();
    });

    it('issues a single request and preserves requested id order for a small id list', async () => {
      mockOsTestCases.getByIds.mockResolvedValue([
        createMockStorageTestCase('tc-2'),
        createMockStorageTestCase('tc-1'),
      ]);

      const result = await asyncTestCaseStorage.getByIds(['tc-1', 'tc-2']);

      expect(mockOsTestCases.getByIds).toHaveBeenCalledTimes(1);
      expect(mockOsTestCases.getByIds).toHaveBeenCalledWith(['tc-1', 'tc-2'], undefined);
      expect(result.map(tc => tc.id)).toEqual(['tc-1', 'tc-2']);
    });

    it('chunks large id lists into batches of 100 issued in parallel', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `tc-${i}`);
      mockOsTestCases.getByIds.mockImplementation(async (chunk: string[]) =>
        chunk.map(id => createMockStorageTestCase(id))
      );

      const result = await asyncTestCaseStorage.getByIds(ids);

      expect(mockOsTestCases.getByIds).toHaveBeenCalledTimes(3);
      expect(mockOsTestCases.getByIds.mock.calls[0][0]).toHaveLength(100);
      expect(mockOsTestCases.getByIds.mock.calls[1][0]).toHaveLength(100);
      expect(mockOsTestCases.getByIds.mock.calls[2][0]).toHaveLength(50);
      // Every id present, nothing dropped or duplicated across chunk boundaries.
      expect(result.map(tc => tc.id).sort()).toEqual([...ids].sort());
    });

    it('forwards the summary option to every chunked request', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `tc-${i}`);
      mockOsTestCases.getByIds.mockImplementation(async (chunk: string[]) =>
        chunk.map(id => createMockStorageTestCase(id))
      );

      await asyncTestCaseStorage.getByIds(ids, { summary: true });

      expect(mockOsTestCases.getByIds).toHaveBeenCalledTimes(2);
      for (const call of mockOsTestCases.getByIds.mock.calls) {
        expect(call[1]).toEqual({ summary: true });
      }
    });

    it('never runs more than a modest number of chunk requests concurrently', async () => {
      const ids = Array.from({ length: 800 }, (_, i) => `tc-${i}`); // 8 chunks of 100
      let inFlight = 0;
      let maxInFlight = 0;
      mockOsTestCases.getByIds.mockImplementation(async (chunk: string[]) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 0));
        inFlight--;
        return chunk.map(id => createMockStorageTestCase(id));
      });

      await asyncTestCaseStorage.getByIds(ids);

      expect(mockOsTestCases.getByIds).toHaveBeenCalledTimes(8);
      expect(maxInFlight).toBeGreaterThan(0);
      expect(maxInFlight).toBeLessThanOrEqual(8);
    });

    it('propagates a chunk failure instead of swallowing it into an empty result', async () => {
      mockOsTestCases.getByIds.mockRejectedValue(new Error('network error'));

      await expect(asyncTestCaseStorage.getByIds(['tc-1'])).rejects.toThrow('network error');
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

    it('preserves a fixture envelope returned by the storage API', async () => {
      const fixture = {
        type: 'filesystem-workspace',
        ref: 'workspace',
        integrity: 'sha256:abc123',
        payload: { files: ['a.ts'] },
      };
      mockOsTestCases.getById.mockResolvedValue({ ...createMockStorageTestCase(), fixture });

      const result = await asyncTestCaseStorage.getById('tc-1');

      expect(result?.fixture).toEqual(fixture);
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

    it('sends a fixture envelope unchanged when creating a test case', async () => {
      const fixture = {
        type: 'filesystem-workspace',
        ref: 'workspace',
        integrity: 'sha256:abc123',
        payload: { files: ['a.ts'] },
      };
      mockOsTestCases.create.mockResolvedValue({ ...createMockStorageTestCase('new-tc'), fixture });

      const result = await asyncTestCaseStorage.create({ ...createMockCreateInput(), fixture });

      expect(mockOsTestCases.create).toHaveBeenCalledWith(expect.objectContaining({ fixture }));
      expect(result.fixture).toEqual(fixture);
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
      expect(result[0]).toHaveProperty('fixture');
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
      const createdStorageTestCase = createMockStorageTestCase('tc-created-1');
      mockOsTestCases.bulkCreate.mockResolvedValue({
        created: 3,
        errors: false,
        testCases: [createdStorageTestCase],
      });

      const testCases: CreateTestCaseInput[] = [
        createMockCreateInput(),
        { ...createMockCreateInput(), name: 'Test 2' },
      ];

      const result = await asyncTestCaseStorage.bulkCreate(testCases);

      expect(mockOsTestCases.bulkCreate).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(3);
      expect(result.errors).toBe(false);
      // Regression coverage for the "duplicated import flow" fix: bulkCreate
      // now surfaces the created records (converted to app format) so
      // callers (BenchmarksPage/TestCasesPage import handlers) can take ids
      // directly instead of re-fetching the whole test-case corpus.
      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0].id).toBe('tc-created-1');
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
