/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import testCasesRoutes from '@/server/routes/storage/testCases';

// Mock client methods
const mockSearch = jest.fn();
const mockIndex = jest.fn();
const mockDeleteByQuery = jest.fn();
const mockBulk = jest.fn();

// Create mock client
const mockClient = {
  search: mockSearch,
  index: mockIndex,
  deleteByQuery: mockDeleteByQuery,
  bulk: mockBulk,
};

// Mock the storageClient middleware
jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn(),
  requireStorageClient: jest.fn(),
  INDEXES: { testCases: 'test-cases-index' },
}));

// Import mocked functions
import {
  isStorageAvailable,
  requireStorageClient,
} from '@/server/middleware/storageClient';

// Mock sample test cases
jest.mock('@/cli/demo/sampleTestCases', () => ({
  SAMPLE_TEST_CASES: [
    {
      id: 'demo-test-case-1',
      name: 'Sample Test Case 1',
      description: 'A sample test case',
      labels: ['category:RCA', 'difficulty:Medium'],
      initialPrompt: 'Test prompt that is short enough to not be truncated in summary mode',
      context: [{ type: 'incident', content: { title: 'Test incident' } }],
      expectedOutcomes: ['Expected outcome 1'],
      tags: ['promoted'],
    },
  ],
}));

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Helper to create mock request/response
function createMocks(params: any = {}, body: any = {}, query: any = {}) {
  const req = {
    params,
    body,
    query,
    storageClient: mockClient,
    storageConfig: { endpoint: 'https://localhost:9200' },
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

// Helper to get route handler
function getRouteHandler(router: any, method: string, path: string) {
  const routes = router.stack;
  const route = routes.find(
    (layer: any) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

describe('Test Cases Storage Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: storage is available
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  describe('GET /api/storage/test-cases', () => {
    it('should return combined sample and real test cases', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: 'tc-123',
                  latest: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            id: 'tc-123',
                            name: 'Real Test Case',
                            createdAt: '2024-01-01T00:00:00Z',
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          testCases: expect.arrayContaining([
            expect.objectContaining({ id: 'tc-123' }),
            expect.objectContaining({ id: 'demo-test-case-1' }),
          ]),
        })
      );
    });

    it('should return only sample data when OpenSearch unavailable', async () => {
      mockSearch.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          testCases: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-test-case-1' }),
          ]),
        })
      );
    });
  });

  describe('GET /api/storage/test-cases/:id', () => {
    it('should return sample test case for demo ID', async () => {
      const { req, res } = createMocks({ id: 'demo-test-case-1' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'demo-test-case-1',
          name: 'Sample Test Case 1',
        })
      );
    });

    it('should return 404 for non-existent sample ID', async () => {
      const { req, res } = createMocks({ id: 'demo-nonexistent' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Test case not found' });
    });

    it('should fetch from OpenSearch for non-sample ID', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _source: {
                  id: 'tc-123',
                  name: 'Real Test Case',
                  version: 1,
                },
              },
            ],
          },
        },
      });

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(mockSearch).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tc-123' })
      );
    });

    it('should return 404 when test case not found in OpenSearch', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: { hits: [] },
        },
      });

      const { req, res } = createMocks({ id: 'tc-nonexistent' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /api/storage/test-cases/:id/versions', () => {
    it('should return single version for sample test case', async () => {
      const { req, res } = createMocks({ id: 'demo-test-case-1' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          versions: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-test-case-1' }),
          ]),
          total: 1,
        })
      );
    });

    it('should return multiple versions from OpenSearch', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'tc-123', version: 2 } },
              { _source: { id: 'tc-123', version: 1 } },
            ],
          },
        },
      });

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          versions: expect.arrayContaining([
            expect.objectContaining({ version: 2 }),
            expect.objectContaining({ version: 1 }),
          ]),
          total: 2,
        })
      );
    });
  });

  describe('GET /api/storage/test-cases/:id/versions/:version', () => {
    it('should return version 1 for sample test case', async () => {
      const { req, res } = createMocks({ id: 'demo-test-case-1', version: '1' });
      const handler = getRouteHandler(
        testCasesRoutes,
        'get',
        '/api/storage/test-cases/:id/versions/:version'
      );

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'demo-test-case-1' })
      );
    });

    it('should return 404 for non-existent version of sample', async () => {
      const { req, res } = createMocks({ id: 'demo-test-case-1', version: '2' });
      const handler = getRouteHandler(
        testCasesRoutes,
        'get',
        '/api/storage/test-cases/:id/versions/:version'
      );

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should fetch specific version from OpenSearch', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [{ _source: { id: 'tc-123', version: 2 } }],
          },
        },
      });

      const { req, res } = createMocks({ id: 'tc-123', version: '2' });
      const handler = getRouteHandler(
        testCasesRoutes,
        'get',
        '/api/storage/test-cases/:id/versions/:version'
      );

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tc-123', version: 2 })
      );
    });
  });

  describe('POST /api/storage/test-cases', () => {
    it('should reject creating test case with demo prefix', async () => {
      const { req, res } = createMocks(
        {},
        { id: 'demo-new-test', name: 'Invalid Test' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('demo- prefix'),
        })
      );
    });

    it('should create new test case with generated ID', async () => {
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res } = createMocks(
        {},
        { name: 'New Test Case', initialPrompt: 'Test prompt' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(mockIndex).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Test Case',
          version: 1,
        })
      );
    });

    it('should use provided ID', async () => {
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res } = createMocks(
        {},
        { id: 'custom-id-123', name: 'New Test Case' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'custom-id-123' })
      );
    });
  });

  describe('PUT /api/storage/test-cases/:id', () => {
    it('should reject modifying sample data', async () => {
      const { req, res } = createMocks(
        { id: 'demo-test-case-1' },
        { name: 'Modified' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'put', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should create new version when updating', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [{ _source: { id: 'tc-123', version: 1 } }],
          },
        },
      });
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res } = createMocks(
        { id: 'tc-123' },
        { name: 'Updated Test Case' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'put', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tc-123',
          version: 2,
        })
      );
    });
  });

  describe('DELETE /api/storage/test-cases/:id', () => {
    it('should reject deleting sample data', async () => {
      const { req, res } = createMocks({ id: 'demo-test-case-1' });
      const handler = getRouteHandler(testCasesRoutes, 'delete', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should delete all versions', async () => {
      mockDeleteByQuery.mockResolvedValue({
        body: { deleted: 3 },
      });

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'delete', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(mockDeleteByQuery).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ deleted: 3 });
    });
  });

  describe('POST /api/storage/test-cases/bulk', () => {
    it('should reject non-array input', async () => {
      const { req, res } = createMocks({}, { testCases: 'not-an-array' });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'testCases must be an array',
      });
    });

    it('should reject test cases with demo prefix', async () => {
      const { req, res } = createMocks(
        {},
        { testCases: [{ id: 'demo-new', name: 'Invalid' }] }
      );
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('demo- prefix'),
        })
      );
    });

    it('should bulk create test cases', async () => {
      mockBulk.mockResolvedValue({
        body: { errors: false },
      });

      const { req, res } = createMocks(
        {},
        {
          testCases: [
            { name: 'Test Case 1' },
            { name: 'Test Case 2' },
          ],
        }
      );
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/bulk');

      await handler(req, res);

      expect(mockBulk).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          created: 2,
          errors: false,
        })
      );
    });
  });

  describe('Error Handling - 500 errors', () => {
    it('GET /api/storage/test-cases/:id should handle OpenSearch errors', async () => {
      mockSearch.mockRejectedValue(new Error('Database connection lost'));

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Database connection lost' });
    });

    it('GET /api/storage/test-cases/:id/versions should handle OpenSearch errors', async () => {
      mockSearch.mockRejectedValue(new Error('Index not found'));

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Index not found' });
    });

    it('GET /api/storage/test-cases/:id/versions/:version should handle OpenSearch errors', async () => {
      mockSearch.mockRejectedValue(new Error('Query timeout'));

      const { req, res } = createMocks({ id: 'tc-123', version: '1' });
      const handler = getRouteHandler(
        testCasesRoutes,
        'get',
        '/api/storage/test-cases/:id/versions/:version'
      );

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Query timeout' });
    });

    it('POST /api/storage/test-cases should handle index errors', async () => {
      mockIndex.mockRejectedValue(new Error('Index write failed'));

      const { req, res } = createMocks({}, { name: 'New Test Case' });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Index write failed' });
    });

    it('PUT /api/storage/test-cases/:id should handle update errors', async () => {
      mockSearch.mockResolvedValue({
        body: { hits: { hits: [{ _source: { id: 'tc-123', version: 1 } }] } },
      });
      mockIndex.mockRejectedValue(new Error('Update failed'));

      const { req, res } = createMocks({ id: 'tc-123' }, { name: 'Updated' });
      const handler = getRouteHandler(testCasesRoutes, 'put', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
    });

    it('DELETE /api/storage/test-cases/:id should handle delete errors', async () => {
      mockDeleteByQuery.mockRejectedValue(new Error('Delete failed'));

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'delete', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
    });

    it('POST /api/storage/test-cases/bulk should handle bulk errors', async () => {
      mockBulk.mockRejectedValue(new Error('Bulk operation failed'));

      const { req, res } = createMocks({}, { testCases: [{ name: 'Test' }] });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Bulk operation failed' });
    });
  });

  describe('Storage Not Configured - fallback behavior', () => {
    beforeEach(() => {
      (isStorageAvailable as jest.Mock).mockReturnValue(false);
    });

    afterEach(() => {
      (isStorageAvailable as jest.Mock).mockReturnValue(true);
    });

    it('GET /api/storage/test-cases/:id should return 404 when storage not configured', async () => {
      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Test case not found' });
    });

    it('GET /api/storage/test-cases/:id/versions should return 404 when storage not configured', async () => {
      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Test case not found' });
    });

    it('GET /api/storage/test-cases/:id/versions/:version should return 404 when storage not configured', async () => {
      const { req, res } = createMocks({ id: 'tc-123', version: '1' });
      const handler = getRouteHandler(
        testCasesRoutes,
        'get',
        '/api/storage/test-cases/:id/versions/:version'
      );

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Test case version not found' });
    });

    it('POST /api/storage/test-cases should return 400 when storage not configured', async () => {
      const { req, res } = createMocks({}, { name: 'New Test' });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'OpenSearch not configured. Cannot create new test cases in sample-only mode.',
      });
    });

    it('PUT /api/storage/test-cases/:id should return 400 when storage not configured', async () => {
      const { req, res } = createMocks({ id: 'tc-123' }, { name: 'Updated' });
      const handler = getRouteHandler(testCasesRoutes, 'put', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'OpenSearch not configured. Cannot update test cases in sample-only mode.',
      });
    });

    it('DELETE /api/storage/test-cases/:id should return 400 when storage not configured', async () => {
      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'delete', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'OpenSearch not configured. Cannot delete test cases in sample-only mode.',
      });
    });

    it('POST /api/storage/test-cases/bulk should return 400 when storage not configured', async () => {
      const { req, res } = createMocks({}, { testCases: [{ name: 'Test' }] });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'OpenSearch not configured. Cannot create test cases in sample-only mode.',
      });
    });
  });

  describe('Additional 404 scenarios', () => {
    it('GET /api/storage/test-cases/:id/versions should return 404 for non-existent demo', async () => {
      const { req, res } = createMocks({ id: 'demo-nonexistent' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Test case not found' });
    });

    it('GET /api/storage/test-cases/:id/versions/:version should return 404 for not found', async () => {
      mockSearch.mockResolvedValue({
        body: { hits: { hits: [] } },
      });

      const { req, res } = createMocks({ id: 'tc-123', version: '99' });
      const handler = getRouteHandler(
        testCasesRoutes,
        'get',
        '/api/storage/test-cases/:id/versions/:version'
      );

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Test case version not found' });
    });
  });

  describe('Summary mode (fields=summary)', () => {
    it('should apply _source.includes to OpenSearch query when fields=summary', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: 'tc-123',
                  latest: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            id: 'tc-123',
                            name: 'Real Test Case',
                            initialPrompt: 'Short prompt',
                            createdAt: '2024-01-01T00:00:00Z',
                            context: [{ type: 'big' }],
                            expectedOutcomes: ['outcome1'],
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify _source.includes was added to top_hits
      const searchCall = mockSearch.mock.calls[0][0];
      const topHits = searchCall.body.aggs.by_id.aggs.latest.top_hits;
      expect(topHits._source).toEqual({
        includes: expect.arrayContaining(['id', 'name', 'labels', 'initialPrompt']),
      });

      // Verify response has summary transformations
      const response = (res.json as jest.Mock).mock.calls[0][0];
      const realTc = response.testCases.find((tc: any) => tc.id === 'tc-123');
      expect(realTc.context).toEqual([]);
      expect(realTc.expectedOutcomes).toEqual([]);
    });

    it('should truncate initialPrompt to 200 chars in summary mode', async () => {
      const longPrompt = 'A'.repeat(300);
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: 'tc-long',
                  latest: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            id: 'tc-long',
                            name: 'Long Prompt TC',
                            initialPrompt: longPrompt,
                            createdAt: '2024-01-01T00:00:00Z',
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      const tc = response.testCases.find((tc: any) => tc.id === 'tc-long');
      expect(tc.initialPrompt.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(tc.initialPrompt).toMatch(/\.\.\.$/);
    });

    it('should strip heavy fields from sample data in summary mode', async () => {
      (isStorageAvailable as jest.Mock).mockReturnValue(false);

      const { req, res } = createMocks({}, {}, { fields: 'summary' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      const sampleTc = response.testCases.find((tc: any) => tc.id === 'demo-test-case-1');
      expect(sampleTc.context).toEqual([]);
      expect(sampleTc.expectedOutcomes).toEqual([]);
      expect(sampleTc.versions).toEqual([]);
    });

    it('should work with ids filter in summary mode', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: 'tc-123',
                  latest: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            id: 'tc-123',
                            name: 'Real Test Case',
                            initialPrompt: 'Short prompt',
                            createdAt: '2024-01-01T00:00:00Z',
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary', ids: 'tc-123,demo-test-case-1' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.testCases).toHaveLength(2);

      // Verify _source includes was applied
      const searchCall = mockSearch.mock.calls[0][0];
      const topHits = searchCall.body.aggs.by_id.aggs.latest.top_hits;
      expect(topHits._source).toBeDefined();
    });

    it('should return full data when no fields param (backward compat)', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: 'tc-123',
                  latest: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            id: 'tc-123',
                            name: 'Real Test Case',
                            initialPrompt: 'Short prompt',
                            createdAt: '2024-01-01T00:00:00Z',
                            context: [{ type: 'big' }],
                            expectedOutcomes: ['outcome1'],
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify no _source filtering applied
      const searchCall = mockSearch.mock.calls[0][0];
      const topHits = searchCall.body.aggs.by_id.aggs.latest.top_hits;
      expect(topHits._source).toBeUndefined();

      // Verify context/expectedOutcomes are NOT stripped
      const response = (res.json as jest.Mock).mock.calls[0][0];
      const tc = response.testCases.find((tc: any) => tc.id === 'tc-123');
      expect(tc.context).toEqual([{ type: 'big' }]);
      expect(tc.expectedOutcomes).toEqual(['outcome1']);
    });
  });

  describe('Pagination (size + after)', () => {
    it('should use composite aggregation when size param provided', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: { id: 'tc-1' },
                  latest: {
                    hits: {
                      hits: [{ _source: { id: 'tc-1', name: 'TC 1', createdAt: '2024-01-01T00:00:00Z' } }],
                    },
                  },
                },
                {
                  key: { id: 'tc-2' },
                  latest: {
                    hits: {
                      hits: [{ _source: { id: 'tc-2', name: 'TC 2', createdAt: '2024-01-02T00:00:00Z' } }],
                    },
                  },
                },
              ],
              after_key: { id: 'tc-2' },
            },
            total_count: { value: 5 },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { size: '2' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify composite aggregation was used
      const searchCall = mockSearch.mock.calls[0][0];
      expect(searchCall.body.aggs.by_id.composite).toBeDefined();
      expect(searchCall.body.aggs.by_id.composite.size).toBe(2);

      // Verify response includes pagination info
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.after).toBeDefined();
      expect(response.hasMore).toBe(true);
    });

    it('should pass after cursor to composite aggregation', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: { id: 'tc-3' },
                  latest: {
                    hits: {
                      hits: [{ _source: { id: 'tc-3', name: 'TC 3', createdAt: '2024-01-03T00:00:00Z' } }],
                    },
                  },
                },
              ],
              after_key: { id: 'tc-3' },
            },
            total_count: { value: 5 },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { size: '2', after: 'tc-2' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify after cursor was passed
      const searchCall = mockSearch.mock.calls[0][0];
      expect(searchCall.body.aggs.by_id.composite.after).toEqual({ id: 'tc-2' });
    });

    it('should not include hasMore when fewer results than page size', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: { id: 'tc-1' },
                  latest: {
                    hits: {
                      hits: [{ _source: { id: 'tc-1', name: 'TC 1', createdAt: '2024-01-01T00:00:00Z' } }],
                    },
                  },
                },
              ],
              after_key: { id: 'tc-1' },
            },
            total_count: { value: 1 },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { size: '10' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.hasMore).toBe(false);
      expect(response.after).toBeNull();
    });

    it('should use terms aggregation when no size param (backward compat)', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: 'tc-1',
                  latest: {
                    hits: {
                      hits: [{ _source: { id: 'tc-1', name: 'TC 1', createdAt: '2024-01-01T00:00:00Z' } }],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify terms aggregation (not composite) was used
      const searchCall = mockSearch.mock.calls[0][0];
      expect(searchCall.body.aggs.by_id.terms).toBeDefined();
      expect(searchCall.body.aggs.by_id.composite).toBeUndefined();

      // No pagination fields in response
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.after).toBeUndefined();
      expect(response.hasMore).toBeUndefined();
    });
  });
});
