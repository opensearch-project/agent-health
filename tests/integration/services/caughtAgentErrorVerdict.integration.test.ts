/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: a code-SDK body that CATCHES the agent's non-2xx reply and
 * turns it into a failing `expect()` is a FAILED case — from BOTH runners.
 *
 * Owner-hit bug (intake 2026-10-28): the same `.eval.js` body
 *
 *     let error = '';
 *     try { await agent.run(); } catch (e) { error = String(e); }
 *     expect(error).to.equal('');
 *
 * against a REST agent answering HTTP 500 was
 *   • a FAILED case (counted in the pass rate, assertion shown) from the CLI
 *     (`executeEvaluationRun`, services/evaluationRunner.ts), but
 *   • an AGENT ERROR (`failureStage: 'agent'`, `metricsStatus: 'error'`,
 *     `passFailStatus: null`, excluded from the pass rate) from the benchmark
 *     runner behind `POST /api/storage/benchmarks/:id/execute`
 *     (`executeRun`, services/benchmarkRunner.ts) — whose inline copy of the
 *     classification lacked the "a recorded gate failure is FAILED" guard.
 *
 * Everything on the hot path is REAL: the `.eval.js` file goes through
 * `resolveTestCaseSources` (real loader + chai recorder), `agent.run()` goes
 * through the real connector registry → real `RESTConnector` → a real local
 * HTTP server answering 500, and both runners' matcher sessions run for real.
 * Only the persistence boundaries are doubles: FileStorageModule in a temp dir
 * for test cases / evaluation-run reports, and an in-memory stand-in for the
 * raw OpenSearch `Client` that `executeRun` persists benchmark reports with
 * (the `/execute` route hard-requires OpenSearch, so under file storage this
 * is the only way to drive that exact function).
 *
 * Three scenarios, each asserted on BOTH runners so they cannot drift again:
 *   1. caught 500 + failing expect      → failed   (the bug)
 *   2. uncaught 500 (no gate ran)       → agent_failed (#496 semantics kept)
 *   3. caught 500 + passing expect      → passed   (the body decided)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: { startPolling: jest.fn() },
}));
// The stub REST agent is looked up like a UI-added custom agent. The lookup is
// a registry boundary, not the behaviour under test; everything downstream
// of it (connector, HTTP call, matcher session, classification) is real.
const stubAgent = { key: 'stub-rest-500', name: 'A REST agent (stub 500)', endpoint: '', connectorType: 'rest', useTraces: false, headers: {} };
jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: () => [stubAgent],
}));
jest.mock('@/lib/config/index', () => ({
  ...jest.requireActual('@/lib/config/index'),
  loadConfigSync: () => ({ agents: [], models: {} }),
}));

import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { resolveTestCaseSources } from '@/services/sourceResolver';
import { executeRun, createCancellationToken } from '@/services/benchmarkRunner';
import { executeEvaluationRun } from '@/services/evaluationRunner';
import type { Benchmark, BenchmarkRun, EvaluationRun, TestCaseSource } from '@/types';

const EVAL_FILE = `
const { test, expect } = require('@opensearch-project/agent-health');

// 1. The body catches the connector error and asserts on it → FAILED.
test('caught-500-asserted', { prompt: 'What is the status of order 42?' }, async ({ agent }) => {
  let error = '';
  try { await agent.run(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  expect(error, 'request succeeded (HTTP 2xx)').to.equal('');
});

// 2. Nothing catches it: agent.run() rejects straight out of the body → AGENT ERROR.
test('uncaught-500', { prompt: 'What is the status of order 42?' }, async ({ agent }) => {
  await agent.run();
  expect(true).to.equal(true);
});

// 3. The body catches it and decides the run is acceptable → PASSED.
test('caught-500-tolerated', { prompt: 'What is the status of order 42?' }, async ({ agent }) => {
  let status = 0;
  try { await agent.run(); } catch (e) { status = /\\b500\\b/.test(String(e)) ? 500 : -1; }
  expect(status).to.equal(500);
});
`;

/** Minimal in-memory stand-in for the raw OpenSearch client `executeRun` persists with. */
function inMemoryOpenSearchClient() {
  const docs = new Map<string, any>();
  return {
    docs,
    index: jest.fn(async ({ id, body }: { id: string; body: any }) => { docs.set(id, { ...body, id }); return { body: { result: 'created' } }; }),
    update: jest.fn(async ({ id, body }: { id: string; body: any }) => { docs.set(id, { ...(docs.get(id) ?? {}), ...(body?.doc ?? {}), id }); return { body: { result: 'updated' } }; }),
    updateByQuery: jest.fn(async () => ({ body: { updated: 0 } })),
    get: jest.fn(async ({ id }: { id: string }) => ({ body: { found: docs.has(id), _source: docs.get(id) } })),
    search: jest.fn(async () => ({ body: { hits: { hits: [], total: { value: 0 } } } })),
  };
}

describe('code-SDK verdict: caught agent error + failing expect is FAILED on both runners', () => {
  let agentServer: http.Server;
  let tmpDir: string;
  let fixtureFile: string;
  let storage: FileStorageModule;
  let resolved: Awaited<ReturnType<typeof resolveTestCaseSources>>;
  const byName = (name: string) => resolved.testCases.find(t => t.name === name)!;
  const agentHits: string[] = [];

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    agentServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        agentHits.push(req.url ?? '');
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Search is temporarily unavailable. Please retry.' }));
      });
    });
    await new Promise<void>(r => agentServer.listen(0, '127.0.0.1', r));
    stubAgent.endpoint = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/ask`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caught-agent-error-'));
    storage = new FileStorageModule(tmpDir);
    fixtureFile = path.join(tmpDir, 'caught-agent-error.eval.js');
    fs.writeFileSync(fixtureFile, EVAL_FILE);
    const sources: TestCaseSource[] = [{ type: 'code-import', filenames: [fixtureFile], testCaseIds: [] }];
    resolved = await resolveTestCaseSources(sources, storage);
  });

  afterAll(async () => {
    await new Promise<void>(r => agentServer.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('resolves the three code test cases with their bodies', () => {
    expect(resolved.testCases.map(t => t.name).sort()).toEqual(['caught-500-asserted', 'caught-500-tolerated', 'uncaught-500']);
    expect(resolved.evaluateFnMap.size).toBe(3);
  });

  describe('benchmark runner (what POST /api/storage/benchmarks/:id/execute calls)', () => {
    const client = inMemoryOpenSearchClient();
    let run: BenchmarkRun;
    const reportFor = (name: string) => {
      const tc = byName(name);
      const doc = [...client.docs.values()].find(d => d.testCaseId === tc.id);
      if (!doc) throw new Error(`no persisted report for ${name}; saw ${JSON.stringify([...client.docs.values()].map(d => d.testCaseId))}`);
      return doc;
    };

    beforeAll(async () => {
      const now = new Date().toISOString();
      const benchmark = {
        id: 'bench-caught-agent-error', name: 'caught agent error', description: '', testCaseIds: resolved.testCases.map(t => t.id),
        runs: [], createdAt: now, updatedAt: now,
      } as unknown as Benchmark;
      run = {
        id: 'run-caught-agent-error', name: 'stub 500', createdAt: now, status: 'running',
        agentKey: stubAgent.key, modelId: 'demo-model', results: {},
      } as unknown as BenchmarkRun;
      const before = agentHits.length;
      await executeRun(benchmark, run, () => {}, {
        client: client as any, storageModule: storage, evaluateFnMap: resolved.evaluateFnMap,
        cancellationToken: createCancellationToken(),
      });
      // Every body really called the REST agent (3 cases → 3 HTTP 500s).
      expect(agentHits.length - before).toBe(3);
    }, 30_000);

    it('caught 500 + failing expect → FAILED with the assertion, not an agent error', () => {
      const report = reportFor('caught-500-asserted');
      expect(report.passFailStatus).toBe('failed');
      expect(report.failureStage).toBeUndefined();
      expect(report.metricsStatus).toBe('completed');
      expect(report.traceError).toBeUndefined();
      expect(report.agentError).toBeUndefined();
      const gate = report.matcherResults.find((m: any) => m.method === 'code-assertion' && !m.notReached);
      expect(gate.pass).toBe(false);
      expect(gate.errorMessage).toMatch(/request succeeded \(HTTP 2xx\)/);
      expect(gate.actual).toMatch(/REST request failed: 500/);
      // The run entry points at the persisted report (benchmark-run results carry
      // execution status only; the verdict is read from the report).
      expect(run.results[byName('caught-500-asserted').id]).toMatchObject({ status: 'completed', reportId: report.id });
    });

    it('uncaught 500 (no gate ran) → AGENT ERROR, #496 semantics kept', () => {
      const report = reportFor('uncaught-500');
      expect(report.failureStage).toBe('agent');
      expect(report.metricsStatus).toBe('error');
      expect(report.passFailStatus).toBeNull();
      expect(report.agentError).toMatchObject({ kind: 'http_500', httpStatus: 500 });
      expect(report.traceError).toMatch(/^Agent request failed \(kind=agent_failed\)/);
      expect(report.matcherResults.filter((m: any) => !m.notReached)).toHaveLength(0);
    });

    it('caught 500 + passing expect → PASSED (the body decided)', () => {
      const report = reportFor('caught-500-tolerated');
      expect(report.passFailStatus).toBe('passed');
      expect(report.failureStage).toBeUndefined();
      expect(report.metricsStatus).toBe('completed');
    });
  });

  describe('evaluation runner (CLI / POST /api/storage/evaluation-runs) — identical classification', () => {
    const saved: any[] = [];
    const reportFor = (name: string) => {
      const tc = byName(name);
      const doc = [...saved].reverse().find(r => r.testCaseId === tc.id && r.evaluationType === 'deterministic');
      if (!doc) throw new Error(`no final report for ${name}`);
      return doc;
    };

    beforeAll(async () => {
      const origCreate = storage.runs.create.bind(storage.runs);
      const origUpdate = storage.runs.update.bind(storage.runs);
      jest.spyOn(storage.runs, 'create').mockImplementation(async (r: any) => { const out = await origCreate(r); saved.push(out); return out; });
      jest.spyOn(storage.runs, 'update').mockImplementation(async (id: string, r: any) => { const out = await origUpdate(id, r); saved.push(out); return out; });
      const run = {
        id: 'eval-run-caught-agent-error', agentKey: stubAgent.key, modelId: 'demo-model', status: 'running', results: {},
        createdAt: new Date().toISOString(),
      } as unknown as EvaluationRun;
      await executeEvaluationRun(run, resolved.testCases, {
        storageModule: storage, evaluateFnMap: resolved.evaluateFnMap, onProgress: jest.fn(),
      });
    }, 30_000);

    it.each([
      ['caught-500-asserted', { passFailStatus: 'failed', metricsStatus: 'completed', failureStage: undefined }],
      ['uncaught-500', { passFailStatus: null, metricsStatus: 'error', failureStage: 'agent' }],
      ['caught-500-tolerated', { passFailStatus: 'passed', metricsStatus: 'completed', failureStage: undefined }],
    ])('%s classifies the same as the benchmark runner', (name, expected) => {
      const report = reportFor(name);
      expect({ passFailStatus: report.passFailStatus ?? null, metricsStatus: report.metricsStatus, failureStage: report.failureStage }).toEqual(expected);
    });
  });
});
