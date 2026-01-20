/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  transformSpan,
  fetchTraces,
  checkTracesHealth,
  OpenSearchSpanSource,
  OpenSearchConfig,
} from '@/server/services/tracesService';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Silence console.log/error in tests
const originalConsole = { log: console.log, error: console.error };
beforeAll(() => {
  console.log = jest.fn();
  console.error = jest.fn();
});
afterAll(() => {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
});

describe('tracesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('transformSpan', () => {
    it('should transform basic span fields', () => {
      const source: OpenSearchSpanSource = {
        traceId: 'trace-123',
        spanId: 'span-456',
        parentSpanId: 'parent-789',
        name: 'test-span',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
        durationInNanos: 1000000000, // 1 second
        kind: 'INTERNAL',
        serviceName: 'test-service',
      };

      const result = transformSpan(source);

      expect(result.traceId).toBe('trace-123');
      expect(result.spanId).toBe('span-456');
      expect(result.parentSpanId).toBe('parent-789');
      expect(result.name).toBe('test-span');
      expect(result.startTime).toBe('2024-01-01T00:00:00Z');
      expect(result.endTime).toBe('2024-01-01T00:00:01Z');
      expect(result.duration).toBe(1000); // converted to ms
      expect(result.attributes.spanKind).toBe('INTERNAL');
      expect(result.attributes.serviceName).toBe('test-service');
    });

    it('should convert status codes correctly', () => {
      expect(transformSpan({ 'status.code': 1 }).status).toBe('OK');
      expect(transformSpan({ 'status.code': 2 }).status).toBe('ERROR');
      expect(transformSpan({ 'status.code': 0 }).status).toBe('UNSET');
      expect(transformSpan({}).status).toBe('UNSET');
    });

    it('should convert span.attributes with @ notation to dot notation', () => {
      const source: OpenSearchSpanSource = {
        'span.attributes.gen_ai@request@id': 'run-123',
        'span.attributes.gen_ai@usage@input_tokens': 1000,
        'span.attributes.gen_ai@tool@name': 'search',
      };

      const result = transformSpan(source);

      expect(result.attributes['gen_ai.request.id']).toBe('run-123');
      expect(result.attributes['gen_ai.usage.input_tokens']).toBe(1000);
      expect(result.attributes['gen_ai.tool.name']).toBe('search');
    });

    it('should convert resource.attributes with @ notation', () => {
      const source: OpenSearchSpanSource = {
        'resource.attributes.service@name': 'my-service',
        'resource.attributes.host@name': 'localhost',
      };

      const result = transformSpan(source);

      expect(result.attributes['service.name']).toBe('my-service');
      expect(result.attributes['host.name']).toBe('localhost');
    });

    it('should process events with attribute conversion', () => {
      const source: OpenSearchSpanSource = {
        events: [
          {
            name: 'log',
            time: '2024-01-01T00:00:00.500Z',
            attributes: {
              'message@text': 'Test message',
              'level': 'INFO',
            },
          },
        ],
      };

      const result = transformSpan(source);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].name).toBe('log');
      expect(result.events[0].time).toBe('2024-01-01T00:00:00.500Z');
      expect(result.events[0].attributes['message.text']).toBe('Test message');
      expect(result.events[0].attributes['level']).toBe('INFO');
    });

    it('should handle empty events array', () => {
      const result = transformSpan({ events: [] });
      expect(result.events).toEqual([]);
    });

    it('should handle missing events', () => {
      const result = transformSpan({});
      expect(result.events).toEqual([]);
    });

    it('should add instrumentation scope name to attributes', () => {
      const source: OpenSearchSpanSource = {
        'instrumentationScope.name': 'opentelemetry.instrumentation.requests',
      };

      const result = transformSpan(source);

      expect(result.attributes['instrumentation.scope.name']).toBe(
        'opentelemetry.instrumentation.requests'
      );
    });

    it('should handle null durationInNanos', () => {
      const result = transformSpan({ durationInNanos: undefined });
      expect(result.duration).toBeNull();
    });
  });

  describe('fetchTraces', () => {
    const defaultConfig: OpenSearchConfig = {
      endpoint: 'http://localhost:9200',
      username: 'admin',
      password: 'admin',
      indexPattern: 'otel-v1-apm-span-*',
    };

    it('should throw error when no filter provided', async () => {
      await expect(fetchTraces({}, defaultConfig)).rejects.toThrow(
        'Either traceId, runIds, or time range is required'
      );
    });

    it('should fetch traces by traceId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  traceId: 'trace-123',
                  spanId: 'span-1',
                  name: 'test-span',
                  'status.code': 1,
                },
              },
            ],
            total: { value: 1 },
          },
        }),
      });

      const result = await fetchTraces({ traceId: 'trace-123' }, defaultConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/otel-v1-apm-span-*/_search',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: expect.stringContaining('Basic'),
          }),
        })
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query.bool.must).toContainEqual({
        term: { traceId: 'trace-123' },
      });

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0].traceId).toBe('trace-123');
      expect(result.total).toBe(1);
    });

    it('should fetch traces by runIds', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              { _source: { traceId: 't1', spanId: 's1' } },
              { _source: { traceId: 't2', spanId: 's2' } },
            ],
            total: { value: 2 },
          },
        }),
      });

      const result = await fetchTraces(
        { runIds: ['run-1', 'run-2'] },
        defaultConfig
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query.bool.must).toContainEqual({
        terms: { 'span.attributes.gen_ai@request@id': ['run-1', 'run-2'] },
      });

      expect(result.spans).toHaveLength(2);
    });

    it('should fetch traces by time range', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: { hits: [], total: { value: 0 } },
        }),
      });

      const startTime = new Date('2024-01-01T00:00:00Z').getTime();
      const endTime = new Date('2024-01-02T00:00:00Z').getTime();

      await fetchTraces({ startTime, endTime }, defaultConfig);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const rangeFilter = requestBody.query.bool.must.find(
        (m: any) => m.range && m.range['startTime']
      );

      expect(rangeFilter).toBeDefined();
      expect(rangeFilter.range['startTime'].gte).toBe('2024-01-01T00:00:00.000Z');
      expect(rangeFilter.range['startTime'].lte).toBe('2024-01-02T00:00:00.000Z');
    });

    it('should filter by serviceName', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: { hits: [], total: { value: 0 } },
        }),
      });

      await fetchTraces(
        { traceId: 'trace-123', serviceName: 'my-service' },
        defaultConfig
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const serviceFilter = requestBody.query.bool.must.find(
        (m: any) => m.bool && m.bool.should
      );

      expect(serviceFilter).toBeDefined();
      expect(serviceFilter.bool.should).toContainEqual({
        term: { serviceName: 'my-service' },
      });
      expect(serviceFilter.bool.should).toContainEqual({
        term: { 'span.attributes.gen_ai@agent@name': 'my-service' },
      });
    });

    it('should apply text search filter', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: { hits: [], total: { value: 0 } },
        }),
      });

      await fetchTraces(
        { traceId: 'trace-123', textSearch: 'error' },
        defaultConfig
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const textFilter = requestBody.query.bool.must.find(
        (m: any) => m.query_string
      );

      expect(textFilter).toBeDefined();
      expect(textFilter.query_string.query).toBe('*error*');
    });

    it('should use custom size', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: { hits: [], total: { value: 0 } },
        }),
      });

      await fetchTraces({ traceId: 'trace-123', size: 100 }, defaultConfig);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.size).toBe(100);
    });

    it('should throw error on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      await expect(
        fetchTraces({ traceId: 'trace-123' }, defaultConfig)
      ).rejects.toThrow('OpenSearch error');
    });

    it('should use default index pattern when not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: { hits: [], total: { value: 0 } },
        }),
      });

      const configNoIndex: OpenSearchConfig = {
        endpoint: 'http://localhost:9200',
        username: 'admin',
        password: 'admin',
      };

      await fetchTraces({ traceId: 'trace-123' }, configNoIndex);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/otel-v1-apm-span-*/_search',
        expect.any(Object)
      );
    });

    it('should transform spans correctly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  traceId: 'trace-123',
                  spanId: 'span-1',
                  name: 'test-span',
                  durationInNanos: 500000000, // 500ms
                  'status.code': 1,
                  'span.attributes.gen_ai@request@id': 'run-123',
                },
              },
            ],
            total: { value: 1 },
          },
        }),
      });

      const result = await fetchTraces({ traceId: 'trace-123' }, defaultConfig);

      expect(result.spans[0].duration).toBe(500);
      expect(result.spans[0].status).toBe('OK');
      expect(result.spans[0].attributes['gen_ai.request.id']).toBe('run-123');
    });
  });

  describe('checkTracesHealth', () => {
    const defaultConfig: OpenSearchConfig = {
      endpoint: 'http://localhost:9200',
      username: 'admin',
      password: 'admin',
      indexPattern: 'otel-v1-apm-span-*',
    };

    it('should return error when endpoint not configured', async () => {
      const result = await checkTracesHealth({
        endpoint: '',
        username: 'admin',
        password: 'admin',
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('OpenSearch not configured');
    });

    it('should return error when username not configured', async () => {
      const result = await checkTracesHealth({
        endpoint: 'http://localhost:9200',
        username: '',
        password: 'admin',
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('OpenSearch not configured');
    });

    it('should return error when password not configured', async () => {
      const result = await checkTracesHealth({
        endpoint: 'http://localhost:9200',
        username: 'admin',
        password: '',
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('OpenSearch not configured');
    });

    it('should return ok status on successful health check', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const result = await checkTracesHealth(defaultConfig);

      expect(result.status).toBe('ok');
      expect(result.index).toBe('otel-v1-apm-span-*');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/_cat/indices/otel-v1-apm-span-*?format=json',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Basic'),
          }),
        })
      );
    });

    it('should return error status on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await checkTracesHealth(defaultConfig);

      expect(result.status).toBe('error');
      expect(result.index).toBe('otel-v1-apm-span-*');
    });

    it('should return error on fetch exception', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await checkTracesHealth(defaultConfig);

      expect(result.status).toBe('error');
      expect(result.error).toBe('Connection refused');
    });

    it('should use default index pattern when not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const configNoIndex: OpenSearchConfig = {
        endpoint: 'http://localhost:9200',
        username: 'admin',
        password: 'admin',
      };

      await checkTracesHealth(configNoIndex);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('otel-v1-apm-span-*'),
        expect.any(Object)
      );
    });
  });
});
