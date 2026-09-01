/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import testCasesRoutes from '@/server/routes/storage/testCases';

// Mock the adapters module
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn(),
}));

import { getStorageModule } from '@/server/adapters/index';

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

// Create mock storage module
function createMockStorage(configured = true) {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    testCases: {
      getAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getById: jest.fn().mockResolvedValue(null),
      getVersions: jest.fn().mockResolvedValue([]),
      getVersion: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      search: jest.fn(),
    },
    benchmarks: {},
    runs: {},
    analytics: {},
    health: jest.fn(),
  };
}

// Helper to create mock request/response
function createMocks(params: any = {}, body: any = {}, query: any = {}) {
  const req = {
    params,
    body,
    query,
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
  let mockStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: storage is configured
    mockStorage = createMockStorage(true);
    (getStorageModule as jest.Mock).mockReturnValue(mockStorage);
  });

  describe('GET /api/storage/test-cases', () => {
    it('should return combined sample and real test cases', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          {
            id: 'tc-123',
            name: 'Real Test Case',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { includeSample: 'true' });
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

    it('should return only sample data when storage unavailable', async () => {
      mockStorage.testCases.getAll.mockRejectedValue(new Error('Connection refused'));

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

    // Eval-source IDE view feature: the full eval-file source can be many
    // KB. List views (fields=summary) strip it the same way they already
    // strip context/expectedOutcomes/versions -- the Test Case detail page
    // fetches the full record separately via GET /:id. Regression guard for
    // "list view got slow/huge after adding sourceCode".
    it('fields=summary strips sourceCode but keeps sourceFile/sourceFileName/sourceLanguage', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          {
            id: 'tc-code-1',
            name: 'Code SDK Test',
            initialPrompt: 'short prompt',
            sourceFile: 'evals/rca.eval.ts',
            sourceHash: 'hash1',
            sourceCode: 'x'.repeat(5000),
            sourceFileName: 'rca.eval.ts',
            sourceLanguage: 'typescript',
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      const tc = payload.testCases.find((t: any) => t.id === 'tc-code-1');
      expect(tc).toBeDefined();
      expect(tc.sourceCode).toBeUndefined();
      expect(tc.sourceFile).toBe('evals/rca.eval.ts');
      expect(tc.sourceFileName).toBe('rca.eval.ts');
      expect(tc.sourceLanguage).toBe('typescript');
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

    it('should fetch from storage for non-sample ID', async () => {
      mockStorage.testCases.getById.mockResolvedValue({
        id: 'tc-123',
        name: 'Real Test Case',
        version: 1,
      });

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(mockStorage.testCases.getById).toHaveBeenCalledWith('tc-123');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tc-123' })
      );
    });

    it('should return 404 when test case not found in storage', async () => {
      mockStorage.testCases.getById.mockResolvedValue(null);

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

    it('should return multiple versions from storage', async () => {
      mockStorage.testCases.getVersions.mockResolvedValue([
        { id: 'tc-123', version: 2 },
        { id: 'tc-123', version: 1 },
      ]);

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(mockStorage.testCases.getVersions).toHaveBeenCalledWith('tc-123');
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

    it('should fetch specific version from storage', async () => {
      mockStorage.testCases.getVersion.mockResolvedValue({ id: 'tc-123', version: 2 });

      const { req, res } = createMocks({ id: 'tc-123', version: '2' });
      const handler = getRouteHandler(
        testCasesRoutes,
        'get',
        '/api/storage/test-cases/:id/versions/:version'
      );

      await handler(req, res);

      expect(mockStorage.testCases.getVersion).toHaveBeenCalledWith('tc-123', 2);
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

    it('rejects an invalid fixture before calling storage', async () => {
      const { req, res } = createMocks({}, {
        name: 'Invalid fixture case',
        initialPrompt: 'Investigate',
        fixture: {
          type: 'filesystem-workspace',
          ref: '',
          integrity: 'sha256:not valid',
        },
      });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('fixture.ref: Fixture ref must be a non-empty string'),
        errors: expect.arrayContaining([
          expect.stringContaining('fixture.integrity: Fixture integrity must use algorithm:digest format'),
        ]),
      }));
      expect(mockStorage.testCases.create).not.toHaveBeenCalled();
    });

    it('should create new test case', async () => {
      mockStorage.testCases.create.mockResolvedValue({
        id: 'tc-generated-123',
        name: 'New Test Case',
        version: 1,
        initialPrompt: 'Test prompt',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const { req, res } = createMocks(
        {},
        { name: 'New Test Case', initialPrompt: 'Test prompt' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(mockStorage.testCases.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Test Case',
          initialPrompt: 'Test prompt',
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Test Case',
          version: 1,
        })
      );
    });

    it('should use provided ID', async () => {
      mockStorage.testCases.create.mockResolvedValue({
        id: 'custom-id-123',
        name: 'New Test Case',
        version: 1,
        createdAt: '2024-01-01T00:00:00Z',
      });

      const { req, res } = createMocks(
        {},
        { id: 'custom-id-123', name: 'New Test Case' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(mockStorage.testCases.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'custom-id-123' })
      );
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

    it('rejects an invalid fixture before updating storage', async () => {
      const { req, res } = createMocks(
        { id: 'tc-123' },
        { fixture: { type: 'filesystem-workspace', ref: '', integrity: 'not-pinned' } },
      );
      const handler = getRouteHandler(testCasesRoutes, 'put', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Invalid test-case fixture'),
        errors: expect.arrayContaining([expect.stringContaining('fixture.ref')]),
      }));
      expect(mockStorage.testCases.update).not.toHaveBeenCalled();
    });

    it('should create new version when updating', async () => {
      mockStorage.testCases.update.mockResolvedValue({
        id: 'tc-123',
        name: 'Updated Test Case',
        version: 2,
      });

      const { req, res } = createMocks(
        { id: 'tc-123' },
        { name: 'Updated Test Case' }
      );
      const handler = getRouteHandler(testCasesRoutes, 'put', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(mockStorage.testCases.update).toHaveBeenCalledWith('tc-123', { name: 'Updated Test Case' });
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
      mockStorage.testCases.delete.mockResolvedValue({ deleted: 3 });

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'delete', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(mockStorage.testCases.delete).toHaveBeenCalledWith('tc-123');
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

    it('rejects a bulk import when any fixture is invalid and identifies its array index', async () => {
      const { req, res } = createMocks({}, {
        testCases: [
          { name: 'Legacy case' },
          {
            name: 'Invalid fixture',
            fixture: { type: 'filesystem-workspace', ref: 'workspace', integrity: 'sha256:' },
          },
        ],
      });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('testCases.1.fixture.integrity'),
      }));
      expect(mockStorage.testCases.bulkCreate).not.toHaveBeenCalled();
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
      mockStorage.testCases.bulkCreate.mockResolvedValue({
        created: 2,
        errors: 0,
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

      expect(mockStorage.testCases.bulkCreate).toHaveBeenCalledWith([
        { name: 'Test Case 1' },
        { name: 'Test Case 2' },
      ]);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          created: 2,
          errors: 0,
        })
      );
    });
  });

  describe('Error Handling - 500 errors', () => {
    it('GET /api/storage/test-cases/:id should handle storage errors', async () => {
      mockStorage.testCases.getById.mockRejectedValue(new Error('Database connection lost'));

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Database connection lost' });
    });

    it('GET /api/storage/test-cases/:id/versions should handle storage errors', async () => {
      mockStorage.testCases.getVersions.mockRejectedValue(new Error('Index not found'));

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Index not found' });
    });

    it('GET /api/storage/test-cases/:id/versions/:version should handle storage errors', async () => {
      mockStorage.testCases.getVersion.mockRejectedValue(new Error('Query timeout'));

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

    it('POST /api/storage/test-cases should handle create errors', async () => {
      mockStorage.testCases.create.mockRejectedValue(new Error('Index write failed'));

      const { req, res } = createMocks({}, { name: 'New Test Case' });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Index write failed' });
    });

    it('PUT /api/storage/test-cases/:id should handle update errors', async () => {
      mockStorage.testCases.update.mockRejectedValue(new Error('Update failed'));

      const { req, res } = createMocks({ id: 'tc-123' }, { name: 'Updated' });
      const handler = getRouteHandler(testCasesRoutes, 'put', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
    });

    it('DELETE /api/storage/test-cases/:id should handle delete errors', async () => {
      mockStorage.testCases.delete.mockRejectedValue(new Error('Delete failed'));

      const { req, res } = createMocks({ id: 'tc-123' });
      const handler = getRouteHandler(testCasesRoutes, 'delete', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
    });

    it('POST /api/storage/test-cases/bulk should handle bulk errors', async () => {
      mockStorage.testCases.bulkCreate.mockRejectedValue(new Error('Bulk operation failed'));

      const { req, res } = createMocks({}, { testCases: [{ name: 'Test' }] });
      const handler = getRouteHandler(testCasesRoutes, 'post', '/api/storage/test-cases/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Bulk operation failed' });
    });
  });

  describe('Storage Not Configured - fallback behavior', () => {
    beforeEach(() => {
      mockStorage.isConfigured.mockReturnValue(false);
    });

    it('GET /api/storage/test-cases should return only sample data', async () => {
      const { req, res } = createMocks();
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Should not attempt to call storage
      expect(mockStorage.testCases.getAll).not.toHaveBeenCalled();

      // Should return sample data
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          testCases: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-test-case-1' }),
          ]),
        })
      );
    });

    it('GET /api/storage/test-cases/:id should return sample for demo ID', async () => {
      const { req, res } = createMocks({ id: 'demo-test-case-1' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'demo-test-case-1' })
      );
    });

    it('GET /api/storage/test-cases/:id/versions should return sample versions for demo ID', async () => {
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

    it('GET /api/storage/test-cases/:id/versions/:version should return version 1 for demo ID', async () => {
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
      mockStorage.testCases.getVersion.mockResolvedValue(null);

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

    it('GET /api/storage/test-cases/:id/versions should return 404 when no versions found', async () => {
      mockStorage.testCases.getVersions.mockResolvedValue([]);

      const { req, res } = createMocks({ id: 'tc-nonexistent' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases/:id/versions');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Test case not found' });
    });
  });

  describe('Summary mode (fields=summary)', () => {
    it('should apply summary transformation to storage results', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          {
            id: 'tc-123',
            name: 'Real Test Case',
            initialPrompt: 'Short prompt',
            createdAt: '2024-01-01T00:00:00Z',
            context: [{ type: 'big' }],
            expectedOutcomes: ['outcome1'],
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify response has summary transformations
      const response = (res.json as jest.Mock).mock.calls[0][0];
      const realTc = response.testCases.find((tc: any) => tc.id === 'tc-123');
      expect(realTc.context).toEqual([]);
      expect(realTc.expectedOutcomes).toEqual([]);
    });

    // Regression coverage for the actual root cause of the reported
    // ~168MB full-payload performance bug on the shared cluster: measured
    // live, ~165MB of that came from `sourceCode` (the full eval-file text
    // stored on code-imported test cases by the in-flight eval-code-view
    // feature) -- not context/expectedOutcomes/versions, which are tiny by
    // comparison. `sourceCode` isn't declared on this branch's TestCase
    // type (that feature hasn't merged to origin/main yet), but real
    // stored documents already carry it, and the naive `{ ...doc }` spread
    // in toSummary() would otherwise pass it straight through untouched.
    it('should strip sourceCode (large eval-file text) from storage results in summary mode', async () => {
      const hugeSourceCode = 'x'.repeat(500000);
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          {
            id: 'tc-code-imported',
            name: 'Code-imported TC',
            initialPrompt: 'Short prompt',
            createdAt: '2024-01-01T00:00:00Z',
            sourceFile: 'evals/demo.eval.ts',
            sourceHash: 'abc123',
            sourceCode: hugeSourceCode,
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      const tc = response.testCases.find((t: any) => t.id === 'tc-code-imported');
      expect(tc.sourceCode).toBeUndefined();
      // Lightweight provenance fields (used to render a "has source" badge)
      // are NOT heavy and must survive the summary transform.
      expect(tc.sourceFile).toBe('evals/demo.eval.ts');
      expect(tc.sourceHash).toBe('abc123');
    });

    it('should truncate initialPrompt to 200 chars in summary mode', async () => {
      const longPrompt = 'A'.repeat(300);
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          {
            id: 'tc-long',
            name: 'Long Prompt TC',
            initialPrompt: longPrompt,
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1,
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
      mockStorage.isConfigured.mockReturnValue(false);

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
      mockStorage.testCases.getById.mockResolvedValue({
        id: 'tc-123',
        name: 'Real Test Case',
        initialPrompt: 'Short prompt',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary', ids: 'tc-123,demo-test-case-1', includeSample: 'true' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.testCases).toHaveLength(2);

      // Verify getById was called for the non-sample ID
      expect(mockStorage.testCases.getById).toHaveBeenCalledWith('tc-123');
    });

    // Regression/contract guard: the comparison page's category matrix (and
    // any other id-scoped name lookup) fetches test cases with
    // `fields=summary` specifically to avoid the sourceCode/context payload
    // — but it still needs `name` and `labels` (the `subcategory:<x>` /
    // `topic:<x>` tags `extractRowCategory` reads, plus the `[bracket]`
    // name-tag fallback). A future change to `toSummary()` that starts
    // stripping `labels` or `name` — the same failure mode that has bitten
    // other lightweight report/test-case projections in this codebase —
    // would silently collapse every row to `(uncategorized)` and hide the
    // matrix again, with no error anywhere. Pin that these survive summary
    // mode, via both the unfiltered (getAll) and ids-filtered (getById) code
    // paths the route can take.
    it('preserves labels and name in summary mode (category matrix depends on these)', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          {
            id: 'tc-labeled',
            name: 'qst_0011 [basic] How long is the validity period',
            initialPrompt: 'Short prompt',
            createdAt: '2024-01-01T00:00:00Z',
            labels: ['category:RAG', 'difficulty:Medium', 'subcategory:basic'],
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { fields: 'summary' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');
      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      const tc = response.testCases.find((t: any) => t.id === 'tc-labeled');
      expect(tc.name).toBe('qst_0011 [basic] How long is the validity period');
      expect(tc.labels).toEqual(['category:RAG', 'difficulty:Medium', 'subcategory:basic']);

      // Same guarantee via the ids-filtered path (what the comparison page
      // actually calls: GET /test-cases?ids=...&fields=summary).
      mockStorage.testCases.getById.mockResolvedValue({
        id: 'tc-labeled-2',
        name: 'qst_0492 [info_not_found] For the missing doc',
        initialPrompt: 'Short prompt',
        createdAt: '2024-01-01T00:00:00Z',
        labels: ['category:RAG', 'subcategory:info_not_found'],
      });
      const { req: req2, res: res2 } = createMocks({}, {}, { fields: 'summary', ids: 'tc-labeled-2' });
      await handler(req2, res2);
      const response2 = (res2.json as jest.Mock).mock.calls[0][0];
      const tc2 = response2.testCases.find((t: any) => t.id === 'tc-labeled-2');
      expect(tc2.name).toBe('qst_0492 [info_not_found] For the missing doc');
      expect(tc2.labels).toEqual(['category:RAG', 'subcategory:info_not_found']);
    });

    it('should return full data when no fields param (backward compat)', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          {
            id: 'tc-123',
            name: 'Real Test Case',
            initialPrompt: 'Short prompt',
            createdAt: '2024-01-01T00:00:00Z',
            context: [{ type: 'big' }],
            expectedOutcomes: ['outcome1'],
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify context/expectedOutcomes are NOT stripped
      const response = (res.json as jest.Mock).mock.calls[0][0];
      const tc = response.testCases.find((tc: any) => tc.id === 'tc-123');
      expect(tc.context).toEqual([{ type: 'big' }]);
      expect(tc.expectedOutcomes).toEqual(['outcome1']);
    });
  });

  describe('Pagination (size + after)', () => {
    it('should paginate results when size param provided', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          { id: 'tc-1', name: 'TC 1', createdAt: '2024-01-01T00:00:00Z' },
          { id: 'tc-2', name: 'TC 2', createdAt: '2024-01-02T00:00:00Z' },
          { id: 'tc-3', name: 'TC 3', createdAt: '2024-01-03T00:00:00Z' },
        ],
        total: 3,
      });

      const { req, res } = createMocks({}, {}, { size: '2' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Verify response includes pagination info
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.hasMore).toBeDefined();
      expect(response.after).toBeDefined();
    });

    it('should handle after cursor for subsequent pages', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          { id: 'tc-1', name: 'TC 1', createdAt: '2024-01-01T00:00:00Z' },
          { id: 'tc-2', name: 'TC 2', createdAt: '2024-01-02T00:00:00Z' },
          { id: 'tc-3', name: 'TC 3', createdAt: '2024-01-03T00:00:00Z' },
        ],
        total: 3,
      });

      const { req, res } = createMocks({}, {}, { size: '2', after: 'tc-2' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // Should return results after the cursor
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.testCases).toBeDefined();
    });

    it('should not include hasMore when fewer results than page size', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          { id: 'tc-1', name: 'TC 1', createdAt: '2024-01-01T00:00:00Z' },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { size: '10' });
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.hasMore).toBe(false);
      expect(response.after).toBeNull();
    });

    it('should return all results when no size param (backward compat)', async () => {
      mockStorage.testCases.getAll.mockResolvedValue({
        items: [
          { id: 'tc-1', name: 'TC 1', createdAt: '2024-01-01T00:00:00Z' },
        ],
        total: 1,
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(testCasesRoutes, 'get', '/api/storage/test-cases');

      await handler(req, res);

      // No pagination fields in response
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.after).toBeUndefined();
      expect(response.hasMore).toBeUndefined();
    });
  });
});
