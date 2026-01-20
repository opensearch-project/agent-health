/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import analyticsRoutes from '@/server/routes/storage/analytics';

// Mock the opensearchClient
const mockSearch = jest.fn();

jest.mock('@/server/services/opensearchClient', () => ({
  getOpenSearchClient: () => ({
    search: mockSearch,
  }),
  INDEXES: { analytics: 'analytics-index' },
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

describe('Analytics Storage Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/storage/analytics', () => {
    it('should return records with no filters', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'analytics-1', experimentId: 'exp-1' } },
              { _source: { id: 'analytics-2', experimentId: 'exp-2' } },
            ],
            total: { value: 2 },
          },
        },
      });

      const { req, res } = createMocks({}, {}, {});
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(mockSearch).toHaveBeenCalled();
      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query).toEqual({ match_all: {} });
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          records: expect.any(Array),
          total: 2,
        })
      );
    });

    it('should apply experimentId filter', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [{ _source: { id: 'analytics-1', experimentId: 'exp-1' } }],
            total: { value: 1 },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { experimentId: 'exp-1' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual({ term: { experimentId: 'exp-1' } });
    });

    it('should apply multiple filters', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [],
            total: { value: 0 },
          },
        },
      });

      const { req, res } = createMocks({}, {}, {
        experimentId: 'exp-1',
        testCaseId: 'tc-1',
        agentId: 'agent-1',
        modelId: 'model-1',
        passFailStatus: 'passed',
      });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toHaveLength(5);
    });

    it('should respect pagination params', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: { hits: [], total: { value: 0 } },
        },
      });

      const { req, res } = createMocks({}, {}, { size: '50', from: '100' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.size).toBe(50);
      expect(searchBody.from).toBe(100);
    });

    it('should handle errors', async () => {
      mockSearch.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Connection refused' });
    });
  });

  describe('GET /api/storage/analytics/aggregations', () => {
    it('should return aggregations grouped by agentId by default', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            groups: {
              buckets: [
                {
                  key: 'agent-1',
                  avg_accuracy: { value: 0.85 },
                  avg_faithfulness: { value: 0.9 },
                  avg_latency: { value: 0.75 },
                  avg_trajectory: { value: 0.8 },
                  pass_count: { doc_count: 10 },
                  fail_count: { doc_count: 2 },
                  total_runs: { value: 12 },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks({}, {}, {});
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      expect(mockSearch).toHaveBeenCalled();
      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.aggs.groups.terms.field).toBe('agentId');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          aggregations: expect.arrayContaining([
            expect.objectContaining({
              key: 'agent-1',
              metrics: expect.objectContaining({
                avgAccuracy: 0.85,
                avgFaithfulness: 0.9,
              }),
              passCount: 10,
              failCount: 2,
              totalRuns: 12,
            }),
          ]),
          groupBy: 'agentId',
        })
      );
    });

    it('should use custom groupBy', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            groups: { buckets: [] },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { groupBy: 'modelId' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.aggs.groups.terms.field).toBe('modelId');
    });

    it('should apply experimentId filter to aggregations', async () => {
      mockSearch.mockResolvedValue({
        body: {
          aggregations: {
            groups: { buckets: [] },
          },
        },
      });

      const { req, res } = createMocks({}, {}, { experimentId: 'exp-1' });
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual({ term: { experimentId: 'exp-1' } });
    });

    it('should handle errors', async () => {
      mockSearch.mockRejectedValue(new Error('Aggregation failed'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(analyticsRoutes, 'get', '/api/storage/analytics/aggregations');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /api/storage/analytics/search', () => {
    it('should search with custom filters', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [{ _source: { id: 'analytics-1' } }],
            total: { value: 1 },
          },
          aggregations: {},
        },
      });

      const { req, res } = createMocks({}, {
        filters: { experimentId: 'exp-1', passFailStatus: 'passed' },
      });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual({ term: { experimentId: 'exp-1' } });
      expect(searchBody.query.bool.must).toContainEqual({ term: { passFailStatus: 'passed' } });
    });

    it('should handle array filters with terms query', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: { hits: [], total: { value: 0 } },
          aggregations: {},
        },
      });

      const { req, res } = createMocks({}, {
        filters: { agentId: ['agent-1', 'agent-2'] },
      });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual({
        terms: { agentId: ['agent-1', 'agent-2'] },
      });
    });

    it('should include custom aggregations', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: { hits: [], total: { value: 0 } },
          aggregations: { custom_agg: { value: 10 } },
        },
      });

      const { req, res } = createMocks({}, {
        aggs: { custom_agg: { sum: { field: 'metric_accuracy' } } },
      });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.aggs).toBeDefined();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          aggregations: expect.objectContaining({ custom_agg: { value: 10 } }),
        })
      );
    });

    it('should use match_all when no filters provided', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: { hits: [], total: { value: 0 } },
          aggregations: {},
        },
      });

      const { req, res } = createMocks({}, {});
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query).toEqual({ match_all: {} });
    });

    it('should handle errors', async () => {
      mockSearch.mockRejectedValue(new Error('Search failed'));

      const { req, res } = createMocks({}, { filters: {} });
      const handler = getRouteHandler(analyticsRoutes, 'post', '/api/storage/analytics/search');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
