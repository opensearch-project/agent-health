/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  transformSpan,
  fetchTraces,
  checkTracesHealth,
  OpenSearchSpanSource,
} from '@/server/services/tracesService';

// Create a mock OpenSearch SDK Client
function createMockClient(overrides: any = {}) {
  return {
    search: jest.fn().mockResolvedValue({
      body: { hits: { hits: [], total: { value: 0 } } },
      statusCode: 200,
    }),
    cat: {
      indices: jest.fn().mockResolvedValue({ statusCode: 200, body: [] }),
    },
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

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

    it('should read plain-raw nested attributes (literal dotted OTel keys) (#296)', () => {
      const source: OpenSearchSpanSource = {
        attributes: {
          'agent_health.run.id': 'run-456',
          'gen_ai.usage.input_tokens': 250,
          'gen_ai.agent.name': 'retail-agent',
        },
        resource: { attributes: { 'service.name': 'retail-agent' } },
        status: { code: 2 },
      } as any;

      const result = transformSpan(source);

      expect(result.attributes['agent_health.run.id']).toBe('run-456');
      expect(result.attributes['gen_ai.usage.input_tokens']).toBe(250);
      expect(result.attributes['gen_ai.agent.name']).toBe('retail-agent');
      expect(result.attributes['service.name']).toBe('retail-agent');
      expect(result.status).toBe('ERROR');
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
    it('should throw error when no filter provided', async () => {
      const client = createMockClient();
      await expect(fetchTraces({}, client)).rejects.toThrow(
        'Either traceId, runIds, sessionId, agents, or time range is required'
      );
    });

    it('should fetch traces by traceId', async () => {
      const client = createMockClient({
        search: jest.fn().mockResolvedValue({
          body: {
            hits: {
              hits: [
                {
                  _source: {
                    traceId: 'trace-123',
                    spanId: 'span-1',
                    name: 'test-span',
                    status: { code: 1 },
                  },
                },
              ],
              total: { value: 1 },
            },
          },
        }),
      });

      const result = await fetchTraces({ traceId: 'trace-123' }, client);

      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'otel-v1-apm-span-*',
        })
      );
      expect(result.spans).toHaveLength(1);
      expect(result.spans[0].traceId).toBe('trace-123');
      expect(result.total).toBe(1);
    });

    it('should fetch traces by runIds', async () => {
      const client = createMockClient({
        search: jest.fn().mockResolvedValue({
          body: {
            hits: {
              hits: [
                { _source: { traceId: 't1', spanId: 's1' } },
                { _source: { traceId: 't2', spanId: 's2' } },
              ],
              total: { value: 2 },
            },
          },
        }),
      });

      const result = await fetchTraces({ runIds: ['run-1', 'run-2'] }, client);

      expect(result.spans).toHaveLength(2);
    });

    it('correlates runIds via the plain-raw attributes.agent_health.run.id field (#296)', async () => {
      const search = jest.fn().mockResolvedValue({
        body: { hits: { hits: [], total: { value: 0 } } },
      });
      const client = createMockClient({ search });

      await fetchTraces({ runIds: ['run-1', 'run-2'] }, client);

      const clause = JSON.stringify(search.mock.calls[0][0].body.query);
      // The OTEL-faithful (Data Prepper trace-analytics-plain-raw) field path,
      // NOT the legacy custom `span.attributes.gen_ai@request@id` shape.
      expect(clause).toContain('attributes.agent_health.run.id');
      expect(clause).not.toContain('gen_ai@request@id');
    });

    it('also correlates runIds via the OTEL-standard attributes.gen_ai.conversation.id (#313)', async () => {
      const search = jest.fn().mockResolvedValue({
        body: { hits: { hits: [], total: { value: 0 } } },
      });
      const client = createMockClient({ search });

      await fetchTraces({ runIds: ['run-1', 'run-2'] }, client);

      const query = search.mock.calls[0][0].body.query;
      const clause = JSON.stringify(query);
      // Strategy B is now an OR over our own attribute and the OTEL-standard one.
      expect(clause).toContain('attributes.agent_health.run.id');
      expect(clause).toContain('attributes.gen_ai.conversation.id');
      // Both terms carry the same runIds.
      const runIdClause = query.bool.must.find((c: any) => c?.bool?.should?.some(
        (s: any) => s.terms?.['attributes.gen_ai.conversation.id']));
      expect(runIdClause.bool.should).toEqual(expect.arrayContaining([
        { terms: { 'attributes.agent_health.run.id': ['run-1', 'run-2'] } },
        { terms: { 'attributes.gen_ai.conversation.id': ['run-1', 'run-2'] } },
      ]));
    });

    it('Strategy D: correlates agents[].sessionId on attributes.session.id, unioned with the window (#313)', async () => {
      const search = jest.fn().mockResolvedValue({
        body: { hits: { hits: [], total: { value: 0 } } },
      });
      const client = createMockClient({ search });

      await fetchTraces({
        runIds: ['run-1'],
        agents: [{ serviceName: 'claude-code-agent', startedAt: 1000, endedAt: 2000, sessionId: 'sess-abc' }],
      }, client);

      const query = search.mock.calls[0][0].body.query;
      const clause = JSON.stringify(query);
      // session.id is present as a precise per-run correlator.
      expect(clause).toContain('attributes.session.id');
      expect(clause).toContain('sess-abc');
      // The agents clause is a should over (session.id) OR (serviceName+window),
      // so a span matching EITHER correlates.
      const agentClause = query.bool.should.find((c: any) => c?.bool?.should?.some(
        (s: any) => s.term?.['attributes.session.id'] === 'sess-abc'));
      expect(agentClause).toBeTruthy();
      expect(agentClause.bool.minimum_should_match).toBe(1);
    });

    it('correlates sessionId via attributes.session.id (#296)', async () => {
      const search = jest.fn().mockResolvedValue({
        body: { hits: { hits: [], total: { value: 0 } } },
      });
      const client = createMockClient({ search });

      await fetchTraces({ sessionId: 'sess-1' }, client);

      expect(JSON.stringify(search.mock.calls[0][0].body.query)).toContain('attributes.session.id');
    });

    it('should fetch traces by time range', async () => {
      const client = createMockClient();
      const startTime = new Date('2024-01-01T00:00:00Z').getTime();
      const endTime = new Date('2024-01-02T00:00:00Z').getTime();

      await fetchTraces({ startTime, endTime }, client);

      expect(client.search).toHaveBeenCalled();
    });

    it('should filter by serviceName', async () => {
      const client = createMockClient();

      await fetchTraces(
        { traceId: 'trace-123', serviceName: 'my-service' },
        client
      );

      expect(client.search).toHaveBeenCalled();
    });

    it('should apply text search filter', async () => {
      const client = createMockClient();

      await fetchTraces(
        { traceId: 'trace-123', textSearch: 'error' },
        client
      );

      expect(client.search).toHaveBeenCalled();
    });

    it('text search matches session.id as a case-insensitive substring (dashes/colons literal)', async () => {
      const client = createMockClient();

      // A bare UUID out of a pi-web URL; the real session.id on spans is
      // `<ts>_<uuid>`, so this only matches as a substring wildcard.
      await fetchTraces({ startTime: Date.now() - 86400000, endTime: Date.now(), textSearch: '019f3ae3-656d-70e7-8e0a-e6609e83d977' }, client);

      const body = client.search.mock.calls[0][0].body;
      const clauses = JSON.stringify(body.query);
      // No query_string (its parser would choke on the dashes).
      expect(clauses).not.toContain('query_string');
      // Wildcards on session.id across both index schemas (Data Prepper's
      // `span.attributes.session@id` and ss4o's `attributes.session.id.keyword`).
      expect(clauses).toContain('span.attributes.session@id');
      expect(body.query.bool.must).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bool: expect.objectContaining({
              should: expect.arrayContaining([
                {
                  wildcard: {
                    'attributes.session.id.keyword': {
                      value: '*019f3ae3-656d-70e7-8e0a-e6609e83d977*',
                      case_insensitive: true,
                    },
                  },
                },
              ]),
            }),
          }),
        ])
      );
    });

    it('skips the expensive id/wildcard fan-out for a too-short query, but still matches by name', async () => {
      const client = createMockClient();

      await fetchTraces({ startTime: Date.now() - 86400000, endTime: Date.now(), textSearch: 'ab' }, client);

      const body = client.search.mock.calls[0][0].body;
      const clauses = JSON.stringify(body.query);
      // No leading-wildcard clauses on the high-cardinality id/service fields
      // for a 2-character query — that's a full terms-dictionary scan for a
      // query too short to be selective.
      expect(clauses).not.toContain('wildcard');
      expect(clauses).not.toContain('span.attributes.session@id');
      // The cheap `name` match still runs, so short input isn't a dead no-op.
      expect(body.query.bool.must).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bool: expect.objectContaining({
              should: [{ match: { name: 'ab' } }],
            }),
          }),
        ])
      );
    });

    it('should use custom size', async () => {
      const client = createMockClient();

      await fetchTraces({ traceId: 'trace-123', size: 100 }, client);

      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ size: 100 }),
        })
      );
    });

    it('should use custom index pattern', async () => {
      const client = createMockClient();

      await fetchTraces({ traceId: 'trace-123' }, client, 'custom-traces-*');

      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'custom-traces-*',
        })
      );
    });

    it('should use default index pattern when not provided', async () => {
      const client = createMockClient();

      await fetchTraces({ traceId: 'trace-123' }, client);

      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'otel-v1-apm-span-*',
        })
      );
    });

    it('should transform spans correctly', async () => {
      const client = createMockClient({
        search: jest.fn().mockResolvedValue({
          body: {
            hits: {
              hits: [
                {
                  _source: {
                    traceId: 'trace-123',
                    spanId: 'span-1',
                    name: 'test-span',
                    durationInNanos: 500000000, // 500ms
                    status: { code: 1 },
                    attributes: { 'gen_ai.request.id': 'run-123' },
                  },
                },
              ],
              total: { value: 1 },
            },
          },
        }),
      });

      const result = await fetchTraces({ traceId: 'trace-123' }, client);

      expect(result.spans[0].duration).toBe(500);
      expect(result.spans[0].status).toBe('OK');
      expect(result.spans[0].attributes['gen_ai.request.id']).toBe('run-123');
    });
  });

  describe('checkTracesHealth', () => {
    it('should return ok status on successful health check', async () => {
      const client = createMockClient({
        cat: {
          indices: jest.fn().mockResolvedValue({ statusCode: 200, body: [] }),
        },
      });

      const result = await checkTracesHealth(client, 'otel-v1-apm-span-*');

      expect(result.status).toBe('ok');
      expect(result.index).toBe('otel-v1-apm-span-*');
    });

    it('should return error status on non-OK response', async () => {
      const client = createMockClient({
        cat: {
          indices: jest.fn().mockResolvedValue({ statusCode: 404, body: [] }),
        },
      });

      const result = await checkTracesHealth(client, 'otel-v1-apm-span-*');

      expect(result.status).toBe('error');
      expect(result.index).toBe('otel-v1-apm-span-*');
    });

    it('should return error on exception', async () => {
      const client = createMockClient({
        cat: {
          indices: jest.fn().mockRejectedValue(new Error('Connection refused')),
        },
      });

      const result = await checkTracesHealth(client);

      expect(result.status).toBe('error');
      expect(result.error).toBe('Cannot connect to OpenSearch: Connection refused');
      expect(result.errorCategory).toBe('connection');
      expect(result.suggestion).toBeDefined();
    });

    it('should use default index pattern when not provided', async () => {
      const client = createMockClient();

      await checkTracesHealth(client);

      expect(client.cat.indices).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'otel-v1-apm-span-*',
          format: 'json',
        })
      );
    });
  });
});
