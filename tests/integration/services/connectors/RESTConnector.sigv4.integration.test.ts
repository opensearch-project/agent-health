/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end SigV4 validation for the REST connector against a REAL local
 * HTTP server. The server plays the AWS side: it parses the incoming
 * `Authorization: AWS4-HMAC-SHA256 …` header, rebuilds the canonical request
 * from the bytes it actually received (method, URL, signed headers, body),
 * re-signs it with the same static test credentials and compares. A request
 * only passes when the signature the connector produced matches what an
 * independent verifier computes for what went over the wire.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import { invokeAgent } from '@/services/evaluation';
import type { ConnectorAuth } from '@/services/connectors/types';
import type { AgentConfig, TestCase } from '@/types';

const CREDS = {
  accessKeyId: 'AKIDINTEGRATIONTEST',
  secretAccessKey: 'integration-test-secret-key-not-real',
  sessionToken: 'integration-test-session-token',
};
const REGION = 'us-west-2';
const SERVICE = 'execute-api';

const AUTH: ConnectorAuth = {
  type: 'aws-sigv4',
  awsRegion: REGION,
  awsService: SERVICE,
  awsAccessKeyId: CREDS.accessKeyId,
  awsSecretAccessKey: CREDS.secretAccessKey,
  awsSessionToken: CREDS.sessionToken,
};

const AUTHZ_RE =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/;

interface Received {
  method: string;
  url: string;
  rawHeaders: string[];
  headers: http.IncomingHttpHeaders;
  body: string;
  verdict: 'ok' | 'SignatureDoesNotMatch' | 'MissingAuthenticationToken' | 'MalformedAuthorization';
}

const received: Received[] = [];
let server: http.Server;
let baseUrl: string;

/** The "AWS side": recompute the signature for exactly what arrived. */
async function verify(req: http.IncomingMessage, body: string): Promise<Received['verdict']> {
  const authorization = req.headers.authorization;
  if (!authorization) return 'MissingAuthenticationToken';
  const m = authorization.match(AUTHZ_RE);
  if (!m) return 'MalformedAuthorization';
  const [, accessKeyId, , region, service, signedHeaderList] = m;
  if (accessKeyId !== CREDS.accessKeyId) return 'SignatureDoesNotMatch';

  const signedHeaders: Record<string, string> = {};
  for (const name of signedHeaderList.split(';')) {
    const value = req.headers[name];
    if (value === undefined) return 'SignatureDoesNotMatch';
    signedHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const amzDate = req.headers['x-amz-date'];
  if (typeof amzDate !== 'string') return 'SignatureDoesNotMatch';
  const signingDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );

  const url = new URL(req.url!, baseUrl);
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams.entries()) {
    const cur = query[k];
    query[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  const verifier = new SignatureV4({ credentials: CREDS, region, service, sha256: Sha256 });
  const expected = await verifier.sign(
    {
      method: req.method!,
      protocol: url.protocol,
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      query,
      headers: signedHeaders,
      body,
    },
    { signingDate }
  );
  return expected.headers.authorization === authorization ? 'ok' : 'SignatureDoesNotMatch';
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const verdict = await verify(req, body);
      received.push({ method: req.method!, url: req.url!, rawHeaders: req.rawHeaders, headers: req.headers, body, verdict });
      if (verdict !== 'ok') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: verdict }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'signature verified', echo: JSON.parse(body || 'null') }));
    });
  });
  // Ephemeral port: never collides with another worker's server range.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
});

const testCase = {
  id: 'tc-sigv4-integration',
  name: 'sigv4 integration',
  initialPrompt: 'search products',
  context: 'catalog',
  expectedOutcomes: ['ok'],
  currentVersion: 1,
  labels: [],
  versions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as TestCase;

describe('REST connector + aws-sigv4 against a verifying HTTP server', () => {
  it('sends a request whose SigV4 signature the server recomputes and accepts', async () => {
    const connector = new RESTConnector();
    const result = await connector.execute(`${baseUrl}/prod/invoke?stage=test&x=1&x=2`, { testCase, modelId: 'm' }, AUTH);

    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.verdict).toBe('ok');
    expect(r.method).toBe('POST');

    // Authorization header shape
    const m = r.headers.authorization!.match(AUTHZ_RE)!;
    expect(m).not.toBeNull();
    expect(m[1]).toBe(CREDS.accessKeyId);
    expect(m[2]).toBe(r.headers['x-amz-date']!.toString().slice(0, 8));
    expect(m[3]).toBe(REGION);
    expect(m[4]).toBe(SERVICE);
    expect(m[5].split(';')).toEqual(
      expect.arrayContaining(['content-type', 'host', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'])
    );
    expect(r.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(r.headers['x-amz-security-token']).toBe(CREDS.sessionToken);

    // Wire-level header hygiene: content-type appears exactly once and host is
    // what the client set from the URL (not a duplicate we passed).
    const rawNames = r.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
    expect(rawNames.filter((n) => n === 'content-type')).toHaveLength(1);
    expect(rawNames.filter((n) => n === 'host')).toHaveLength(1);
    expect(r.headers['content-type']).toBe('application/json');

    // The body that was signed is the body that arrived
    expect(JSON.parse(r.body)).toMatchObject({ prompt: 'search products', context: 'catalog', model: 'm' });

    // And the connector parsed the (accepted) response
    expect(result.trajectory.some((s) => s.type === 'response' && s.content === 'signature verified')).toBe(true);
    expect(result.metadata?.status).toBe(200);
  });

  it('a beforeRequest hook that rewrites endpoint, payload and headers is signed AFTER the rewrite', async () => {
    const connector = new RESTConnector();
    const registry = {
      getForAgent: jest.fn().mockReturnValue(connector),
      get: jest.fn(),
      getAll: jest.fn().mockReturnValue([connector]),
      has: jest.fn().mockReturnValue(true),
      register: jest.fn(),
    } as any;
    const agent = {
      key: 'sigv4-hooked',
      name: 'SigV4 hooked agent',
      endpoint: `${baseUrl}/prod/invoke`,
      connectorType: 'rest',
      auth: { ...AUTH },
      hooks: {
        beforeRequest: async ({ endpoint, payload, headers }: any) => ({
          endpoint: `${endpoint}?version=2`,
          payload: { ...payload, session: 'hook-session', extra: { nested: [1, 2, 3] } },
          headers: { ...headers, 'X-Hook-Header': 'present' },
        }),
      },
    } as unknown as AgentConfig;

    const result = await invokeAgent(agent, 'm', testCase, { registry });

    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.verdict).toBe('ok');
    expect(r.url).toBe('/prod/invoke?version=2');
    expect(JSON.parse(r.body)).toMatchObject({ prompt: 'search products', session: 'hook-session', extra: { nested: [1, 2, 3] } });
    expect(r.headers['x-hook-header']).toBe('present');
    expect(r.headers.authorization!.match(AUTHZ_RE)![5].split(';')).toContain('x-hook-header');
    expect(result.trajectory.some((s) => s.type === 'response' && s.content === 'signature verified')).toBe(true);
  });

  it('negative control: the verifier rejects a request signed with the wrong secret (403 surfaces to the caller)', async () => {
    const connector = new RESTConnector();
    await expect(
      connector.execute(`${baseUrl}/prod/invoke`, { testCase, modelId: 'm' }, { ...AUTH, awsSecretAccessKey: 'wrong-secret' })
    ).rejects.toThrow(/REST request failed: 403 - .*SignatureDoesNotMatch/);
    expect(received[0].verdict).toBe('SignatureDoesNotMatch');
  });

  it('negative control: no aws-sigv4 auth → no Authorization header → server rejects', async () => {
    const connector = new RESTConnector();
    await expect(
      connector.execute(`${baseUrl}/prod/invoke`, { testCase, modelId: 'm' }, { type: 'none' })
    ).rejects.toThrow(/REST request failed: 403 - .*MissingAuthenticationToken/);
  });
});
