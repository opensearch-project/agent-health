/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local executor building blocks (#612): the run document the CLI mints
 * mirrors what `POST /api/storage/evaluation-runs` creates; server probing and
 * evaluator lookup over a REAL `http` server. The end-to-end path (real CLI
 * subprocess, real server) is tests/integration/cli/cliExecutesRuns.
 */

import { createServer, type Server } from 'http';
import { buildRunDocument, probeServer, httpEvaluatorLookup, spoolDirFor } from '@/cli/utils/localExecutor';
import type { ResolvedSources } from '@/services/sourceResolver';

jest.mock('@/server/services/agentProvenance', () => ({
  resolveAgentProvenance: jest.fn(async () => ({ agentFingerprint: 'fp-full', agentFingerprintShort: 'fp-short' })),
  reportProvenanceFrom: jest.fn(() => ({})),
}));

let server: Server;
let url: string;
let healthy = true;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: healthy ? 'ok' : 'down' }));
    }
    if (req.url === '/api/storage/evaluators/ev-1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'ev-1', name: 'Stored', kind: 'llm' }));
    }
    if (req.url === '/api/storage/evaluators/ev-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":"x"}');
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Evaluator not found"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('buildRunDocument', () => {
  const resolved: ResolvedSources = {
    testCases: [{ id: 'tc-1', name: 'one', version: 3 } as any, { id: 'tc-2', name: 'two' } as any],
    sources: [{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }],
    deduplicatedCount: 0, evaluateFnMap: new Map(), hooksByFile: new Map(), testHookScopes: new Map(),
  };
  const agents = [{ key: 'a1', name: 'A1', connectorType: 'rest', endpoint: 'http://x', connectorConfig: { model: 'agent-declared-model' } }] as any[];

  it('mirrors the UI route: cli trigger, running, snapshots with versions, the agent\'s own model, provenance from the caller\'s config', async () => {
    const run = await buildRunDocument({ name: 'CLI Run', sources: resolved.sources, agentKey: 'a1', modelId: 'legacy', judgeModelId: 'demo-model', evaluatorId: 'ev-1', concurrency: 2, benchmarkId: 'b-1' }, resolved, agents);
    expect(run.id).toMatch(/^eval-run-\d+-[a-z0-9]+$/);
    expect(run).toMatchObject({
      name: 'CLI Run', trigger: 'cli', status: 'running', agentKey: 'a1', modelId: 'agent-declared-model', judgeModelId: 'demo-model',
      evaluatorId: 'ev-1', concurrency: 2, benchmarkId: 'b-1', results: {},
      testCaseSnapshots: [{ id: 'tc-1', version: 3, name: 'one' }, { id: 'tc-2', version: 1, name: 'two' }],
      sources: resolved.sources, agentFingerprint: 'fp-full', agentFingerprintShort: 'fp-short',
    });
    expect(Date.parse(run.createdAt)).not.toBeNaN();
  });

  it('falls back to the legacy modelId when the agent declares none, and to empty when neither is known', async () => {
    const plain = [{ key: 'a1', name: 'A1', connectorType: 'rest', endpoint: 'http://x' }] as any[];
    expect((await buildRunDocument({ name: 'r', sources: [], agentKey: 'a1', modelId: 'legacy' }, resolved, plain)).modelId).toBe('legacy');
    expect((await buildRunDocument({ name: 'r', sources: [], agentKey: 'a1' }, resolved, plain)).modelId).toBe('');
    expect((await buildRunDocument({ name: 'r', sources: [], agentKey: 'a1' }, resolved, plain)).judgeModelId).toBeUndefined();
  });
});

describe('probeServer / httpEvaluatorLookup / spoolDirFor', () => {
  it('probeServer answers the URL when /health is 2xx, undefined when it is not or nothing listens', async () => {
    healthy = true;
    expect(await probeServer(`${url}/`)).toBe(`${url}/`);
    healthy = false;
    expect(await probeServer(url)).toBeUndefined();
    expect(await probeServer('http://127.0.0.1:1')).toBeUndefined();
  });

  it('httpEvaluatorLookup: stored evaluator → object, 404 → null, other → throws', async () => {
    const lookup = httpEvaluatorLookup(url);
    expect(await lookup('ev-1')).toMatchObject({ id: 'ev-1', name: 'Stored' });
    expect(await lookup('ev-missing')).toBeNull();
    await expect(lookup('ev-500')).rejects.toThrow('Failed to load evaluator ev-500: HTTP 500');
  });

  it('spools under <cwd>/.agent-health/spool', () => {
    expect(spoolDirFor('/proj')).toBe('/proj/.agent-health/spool');
  });
});
