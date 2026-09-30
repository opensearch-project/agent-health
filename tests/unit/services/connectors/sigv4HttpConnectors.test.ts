/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `auth.type: 'aws-sigv4'` through the real HTTP connectors: the request that
 * reaches `fetch` must be exactly the request that was signed.
 */

import { createHash } from 'crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import { AGUIStreamingConnector } from '@/services/connectors/agui/AGUIStreamingConnector';
import { LangGraphConnector } from '@/services/connectors/langgraph/LangGraphConnector';
import { OpenAICompatibleConnector } from '@/services/connectors/openai-compatible/OpenAICompatibleConnector';
import { BaseConnector } from '@/services/connectors/base/BaseConnector';
import { invokeAgent } from '@/services/evaluation';
import type { ConnectorAuth, ConnectorRequest } from '@/services/connectors/types';
import type { AgentConfig, TestCase } from '@/types';

const AUTH: ConnectorAuth = {
  type: 'aws-sigv4',
  awsRegion: 'us-west-2',
  awsService: 'execute-api',
  awsAccessKeyId: 'AKIDEXAMPLE',
  awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  awsSessionToken: 'SESSION-TOKEN',
};

const testCase: TestCase = {
  id: 'tc-sigv4',
  name: 'sigv4 case',
  initialPrompt: 'search products',
  context: 'ctx',
  expectedOutcomes: ['ok'],
  currentVersion: 1,
  labels: [],
  versions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as TestCase;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function parseAuthorization(value: string) {
  const m = value.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/
  );
  if (!m) throw new Error(`unexpected Authorization header: ${value}`);
  return { accessKeyId: m[1], date: m[2], region: m[3], service: m[4], signedHeaders: m[5].split(';'), signature: m[6] };
}

/**
 * Server-side verification: rebuild the canonical request from what `fetch`
 * received (method, url, headers, body), sign it with the same static
 * credentials at the same x-amz-date, and compare Authorization headers.
 */
async function recomputeAuthorization(url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<string> {
  const received = init.headers;
  const authz = parseAuthorization(received.authorization ?? received.Authorization);
  const u = new URL(url);
  const signedHeaders: Record<string, string> = {};
  for (const name of authz.signedHeaders) {
    if (name === 'host') { signedHeaders.host = u.host; continue; }
    const key = Object.keys(received).find((k) => k.toLowerCase() === name);
    if (!key) throw new Error(`signed header ${name} missing from request`);
    signedHeaders[name] = received[key];
  }
  const amzDate = received['x-amz-date'];
  const signingDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );
  const verifier = new SignatureV4({
    credentials: { accessKeyId: AUTH.awsAccessKeyId!, secretAccessKey: AUTH.awsSecretAccessKey!, sessionToken: AUTH.awsSessionToken },
    region: authz.region,
    service: authz.service,
    sha256: Sha256,
  });
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of u.searchParams.entries()) {
    const cur = query[k];
    query[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  const signed = await verifier.sign(
    { method: init.method ?? 'GET', protocol: u.protocol, hostname: u.hostname, ...(u.port ? { port: Number(u.port) } : {}), path: u.pathname, query, headers: signedHeaders, body: init.body },
    { signingDate }
  );
  return signed.headers.authorization;
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: new Map<string, string>(),
  } as unknown as Response;
}

describe('aws-sigv4 through HTTP connectors', () => {
  let fetchMock: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ response: 'done' }));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    fetchMock.mockRestore();
    warnSpy.mockRestore();
  });

  function lastFetch() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, { method: string; headers: Record<string, string>; body?: string }];
    return { url, init };
  }

  describe('RESTConnector', () => {
    const connector = new RESTConnector();
    const request: ConnectorRequest = { testCase, modelId: 'm' };
    const endpoint = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke?stage=x';

    it('sends a signed request that verifies server-side against the bytes actually sent', async () => {
      await connector.execute(endpoint, request, AUTH);
      const { url, init } = lastFetch();
      expect(url).toBe(endpoint);
      const authz = parseAuthorization(init.headers.authorization);
      expect(authz).toMatchObject({ accessKeyId: 'AKIDEXAMPLE', region: 'us-west-2', service: 'execute-api' });
      expect(init.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
      expect(init.headers['x-amz-security-token']).toBe('SESSION-TOKEN');
      expect(init.headers['x-amz-content-sha256']).toBe(sha256Hex(init.body!));
      expect(authz.signedHeaders).toEqual(expect.arrayContaining(['host', 'content-type', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256']));
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });

    it('REGRESSION: exactly one content-type header reaches fetch (no `Content-Type` + `content-type` pair)', async () => {
      await connector.execute(endpoint, request, AUTH);
      const { init } = lastFetch();
      const ctKeys = Object.keys(init.headers).filter((k) => k.toLowerCase() === 'content-type');
      expect(ctKeys).toEqual(['content-type']);
      expect(init.headers['content-type']).toBe('application/json');
      // Prove the wire value equals what undici would send: a Headers object
      // built from the map has a single, un-merged value.
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    });

    it('does not pass `host` to fetch', async () => {
      await connector.execute(endpoint, request, AUTH);
      const { init } = lastFetch();
      expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('host');
    });

    it('custom auth.headers are part of the signed set', async () => {
      await connector.execute(endpoint, request, { ...AUTH, headers: { 'X-Tenant': 'blue' } });
      const { url, init } = lastFetch();
      expect(init.headers['x-tenant']).toBe('blue');
      expect(parseAuthorization(init.headers.authorization).signedHeaders).toContain('x-tenant');
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });

    it('a hook-supplied payload is what gets signed (signature covers the mutated body)', async () => {
      const mutated = { prompt: 'search products', injected_by_hook: true, threadId: 't-1' };
      await connector.execute(endpoint, { ...request, payload: mutated }, AUTH);
      const { url, init } = lastFetch();
      expect(init.body).toBe(JSON.stringify(mutated));
      expect(init.headers['x-amz-content-sha256']).toBe(sha256Hex(JSON.stringify(mutated)));
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });

    it('a `+` in the endpoint query is sent as %2B — the wire URL is the canonical URL that was signed', async () => {
      await connector.execute('https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke?q=a+b&s=x%20y', request, AUTH);
      const { url, init } = lastFetch();
      expect(url).toBe('https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke?q=a%2Bb&s=x%20y');
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });

    it('surfaces a signing failure as a clear error instead of sending unsigned', async () => {
      await expect(
        connector.execute(endpoint, request, { type: 'aws-sigv4', awsService: 'execute-api', awsAccessKeyId: 'a', awsSecretAccessKey: 'b' })
      ).rejects.toThrow(/^SigV4 signing failed: auth\.awsRegion is required \(profile \S+ \/ region <unset> \/ service execute-api\)$/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no longer warns about a placeholder / runtime signing', async () => {
      await connector.execute(endpoint, request, AUTH);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    describe('trace-context propagation', () => {
      const { trace, context: otelContext, propagation, TraceFlags } = require('@opentelemetry/api');
      const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
      const { W3CTraceContextPropagator } = require('@opentelemetry/core');
      let cm: any;
      beforeAll(() => {
        cm = new AsyncLocalStorageContextManager();
        cm.enable();
        otelContext.setGlobalContextManager(cm);
        propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      });
      afterAll(() => {
        otelContext.disable();
        propagation.disable();
        cm.disable();
      });

      it('traceparent is sent but stays OUT of SignedHeaders (added after signing)', async () => {
        const ctx = trace.setSpanContext(otelContext.active(), {
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
        });
        await otelContext.with(ctx, () => connector.execute(endpoint, request, AUTH));
        const { url, init } = lastFetch();
        expect(init.headers.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
        expect(parseAuthorization(init.headers.authorization).signedHeaders).not.toContain('traceparent');
        // …so the signature still verifies with traceparent present
        await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
      });
    });
  });

  describe('beforeRequest hook ordering (invokeAgent → connector.execute)', () => {
    it('signs AFTER the hook finalised endpoint, payload and headers', async () => {
      const connector = new RESTConnector();
      const registry = {
        getForAgent: jest.fn().mockReturnValue(connector),
        get: jest.fn(),
        getAll: jest.fn().mockReturnValue([connector]),
        has: jest.fn().mockReturnValue(true),
        register: jest.fn(),
      } as any;
      const agent: AgentConfig = {
        key: 'sigv4-agent',
        name: 'SigV4 agent',
        endpoint: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke',
        connectorType: 'rest',
        auth: { ...AUTH },
        hooks: {
          beforeRequest: async ({ endpoint, payload, headers }) => ({
            endpoint: `${endpoint}?version=2`,
            payload: { ...payload, hook: 'mutated' },
            headers: { ...headers, 'X-Hook': 'yes' },
          }),
        },
      } as unknown as AgentConfig;

      await invokeAgent(agent, 'm', testCase, { registry });

      const { url, init } = lastFetch();
      expect(url).toBe('https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke?version=2');
      expect(JSON.parse(init.body!)).toMatchObject({ hook: 'mutated' });
      expect(init.headers['x-hook']).toBe('yes');
      const authz = parseAuthorization(init.headers.authorization);
      expect(authz.signedHeaders).toContain('x-hook');
      expect(init.headers['x-amz-content-sha256']).toBe(sha256Hex(init.body!));
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });
  });

  describe('AGUIStreamingConnector (SSE)', () => {
    it('signs content-type + accept and the SSE client sends exactly those (no duplicates)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/event-stream']]),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response);
      const connector = new AGUIStreamingConnector();
      const endpoint = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/stream';
      await connector.execute(endpoint, { testCase, modelId: 'm' }, AUTH);

      const { url, init } = lastFetch();
      // the SSE client sent the exact string the connector signed (no second JSON.stringify)
      expect(init.headers['x-amz-content-sha256']).toBe(sha256Hex(init.body!));
      const lower = Object.keys(init.headers).map((k) => k.toLowerCase());
      expect(lower.filter((k) => k === 'content-type')).toHaveLength(1);
      expect(lower.filter((k) => k === 'accept')).toHaveLength(1);
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers.accept).toBe('text/event-stream');
      const authz = parseAuthorization(init.headers.authorization);
      expect(authz.signedHeaders).toEqual(expect.arrayContaining(['accept', 'content-type', 'host']));
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });
  });

  describe('LangGraphConnector', () => {
    it('signs the resolved invoke URL, not the base endpoint', async () => {
      const connector = new LangGraphConnector();
      await connector.execute('https://abc123.execute-api.us-west-2.amazonaws.com/prod', { testCase, modelId: 'm', connectorConfig: { graphId: 'agent' } }, AUTH);
      const { url, init } = lastFetch();
      expect(url).toBe('https://abc123.execute-api.us-west-2.amazonaws.com/prod/assistants/agent/invoke');
      expect(Object.keys(init.headers).filter((k) => k.toLowerCase() === 'content-type')).toEqual(['content-type']);
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });
  });

  describe('OpenAICompatibleConnector', () => {
    it('signs the chat-completions request', async () => {
      fetchMock.mockResolvedValue(okJson({ id: 'c1', model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }));
      const connector = new OpenAICompatibleConnector();
      const endpoint = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/v1/chat/completions';
      await connector.execute(endpoint, { testCase: { ...testCase, context: ['ctx'] } as unknown as TestCase, modelId: 'm' }, AUTH);
      const { url, init } = lastFetch();
      expect(Object.keys(init.headers).filter((k) => k.toLowerCase() === 'content-type')).toEqual(['content-type']);
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });
  });

  describe('BaseConnector.healthCheck', () => {
    it('signs the HEAD probe', async () => {
      class Probe extends BaseConnector {
        readonly type = 'rest' as const;
        readonly name = 'probe';
        readonly supportsStreaming = false;
        buildPayload() { return {}; }
        async execute(): Promise<any> { throw new Error('unused'); }
        parseResponse() { return []; }
      }
      fetchMock.mockResolvedValue({ ok: true } as Response);
      await new Probe().healthCheck('https://abc123.execute-api.us-west-2.amazonaws.com/prod/health', AUTH);
      const { url, init } = lastFetch();
      expect(init.method).toBe('HEAD');
      await expect(recomputeAuthorization(url, init)).resolves.toBe(init.headers.authorization);
    });
  });

  describe('non-sigv4 auth is unchanged', () => {
    it('bearer: plain headers, capitalised Content-Type default, no AWS headers', async () => {
      await new RESTConnector().execute('http://localhost:5170/agent', { testCase, modelId: 'm' }, { type: 'bearer', token: 't' });
      const { url, init } = lastFetch();
      expect(url).toBe('http://localhost:5170/agent');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer t' });
    });

    it('a custom lowercase `content-type` now overrides the default instead of producing a duplicate pair', async () => {
      await new RESTConnector().execute(
        'http://localhost:5170/agent?b=2&a=1+1',
        { testCase, modelId: 'm' },
        { type: 'none', headers: { 'content-type': 'application/vnd.agent+json' } }
      );
      const { url, init } = lastFetch();
      // URL untouched for non-sigv4 (no canonicalisation)
      expect(url).toBe('http://localhost:5170/agent?b=2&a=1+1');
      expect(init.headers).toEqual({ 'content-type': 'application/vnd.agent+json' });
      expect(new Headers(init.headers).get('content-type')).toBe('application/vnd.agent+json');
    });
  });
});
