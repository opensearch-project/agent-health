/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI integration: `agent-health benchmark -f caught-500.eval.js -a <rest agent>`
 * where the agent answers HTTP 500 and the body CATCHES it and asserts.
 *
 * The real CLI binary is spawned against the running backend (AH_PORT); the
 * agent is a real local HTTP server answering 500, registered on the backend
 * as a REST custom agent. The persisted report must be a FAILED case carrying
 * the assertion — `passFailStatus: 'failed'`, no `failureStage`, counted in
 * the pass rate — and the sibling body that does NOT catch the error must
 * still be an agent error (#496). The same two bodies run through the
 * benchmark runner in
 * tests/integration/services/caughtAgentErrorVerdict.integration.test.ts;
 * both runners now classify via services/evaluation/classifyCaseOutcome.ts.
 *
 * Prerequisites: backend running at AH_PORT (self-skips otherwise); CLI
 * bundle built (`npm run build:cli`, rebuilt here if missing).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request as httpRequest } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';

const TEST_TIMEOUT = 90_000;
const BASE_URL = getTestBackendUrl();
const REPO_ROOT = process.cwd();
const CLI_BUNDLE = join(REPO_ROOT, 'cli/dist/index.js');

// Plain node:http (agent: false) — see benchmarkCodeSdk.integration.test.ts for
// why fetch/undici is avoided right after a CLI subprocess used the loopback.
function httpJson<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, agent: false,
      headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : ({} as T) }); }
        catch { resolve({ status: res.statusCode || 0, body: text as any }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runCli(args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('node', args, { cwd: REPO_ROOT, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ status: signal ? null : code, stdout, stderr }); });
  });
}

const FIXTURE = `
const { test, expect } = require('@opensearch-project/agent-health');

test('caught-500-asserted', { prompt: 'What is the status of order 42?' }, async ({ agent }) => {
  let error = '';
  try { await agent.run(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  expect(error, 'request succeeded (HTTP 2xx)').to.equal('');
});

test('uncaught-500', { prompt: 'What is the status of order 42?' }, async ({ agent }) => {
  await agent.run();
});
`;

describe('CLI — caught agent 500 + failing expect is a FAILED case', () => {
  let backendAvailable = false;
  let agentServer: http.Server;
  let tempDir: string;
  const reports = new Map<string, any>();
  let evaluationRun: any;
  const tracker = createTestDataTracker();

  beforeAll(async () => {
    try {
      backendAvailable = (await httpJson(`GET`, `${BASE_URL}/api/storage/health`)).body?.status === 'ok';
    } catch { backendAvailable = false; }
    if (!backendAvailable) {
      console.warn(`[cli-caught-500] Backend not reachable at ${BASE_URL} — skipping. Start with: npm run dev:server`);
      return;
    }
    if (!existsSync(CLI_BUNDLE)) {
      const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) throw new Error(`CLI build failed: ${build.stderr}`);
    }

    agentServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Search is temporarily unavailable. Please retry.' }));
      });
    });
    await new Promise<void>(r => agentServer.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/ask`;

    // Register the stub as a REST custom agent on the backend (tracked → deleted).
    const reg = await httpJson<any>('POST', `${BASE_URL}/api/agents/custom`, { name: uniqueTestName('stub-500-rest'), endpoint, connectorType: 'rest' });
    if (reg.status === 409) {
      // code-first backend: custom agents are managed in agent-health.config.ts — nothing to run against.
      backendAvailable = false;
      console.warn('[cli-caught-500] Backend is code-first (409 on custom agents) — skipping.');
      return;
    }
    expect(reg.status).toBe(201);
    const agentKey: string = reg.body.agent.key;
    tracker.customAgent(agentKey);

    tempDir = mkdtempSync(join(tmpdir(), 'cli-caught-500-'));
    const fixturePath = join(tempDir, 'caught-500.eval.js');
    writeFileSync(fixturePath, FIXTURE, 'utf-8');

    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k.startsWith('AWS_'))) cleanEnv[k] = v;
    }
    cleanEnv.AH_PORT = new URL(BASE_URL).port || '4001';
    cleanEnv.AH_SUPPRESS_EXPERIMENTAL = '1';
    cleanEnv.AH_QUIET_DEPRECATIONS = '1';
    const benchmarkName = uniqueTestName('cli-caught-500');
    // Async spawn, NOT spawnSync: the stub agent lives in THIS process, and a
    // blocked event loop would never answer the backend's HTTP call.
    const cli = await runCli([CLI_BUNDLE, 'benchmark', '-f', fixturePath, '-a', agentKey, '-n', benchmarkName], cleanEnv, TEST_TIMEOUT - 15_000);
    if (cli.status === null) throw new Error(`CLI timed out.\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);

    const stdout = (cli.stdout || '').replace(/\u001b\[[0-9;]*m/g, '');
    const m = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/.exec(stdout);
    if (!m) throw new Error(`Could not parse benchmark/run from CLI output:\n${stdout}\n${cli.stderr}`);
    const [, benchmarkId, runId] = m;
    tracker.benchmark(benchmarkId);
    tracker.evaluationRun(runId);
    const bench = await httpJson<any>('GET', `${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
    tracker.testCases(bench.body?.testCaseIds);

    evaluationRun = (await httpJson<any>('GET', `${BASE_URL}/api/storage/evaluation-runs/${runId}`)).body;
    evaluationRun = evaluationRun.evaluationRun ?? evaluationRun;
    for (const [tcId, result] of Object.entries((evaluationRun.results || {}) as Record<string, any>)) {
      tracker.run(result.reportId);
      const name = (evaluationRun.testCaseSnapshots || []).find((s: any) => s.id === tcId)?.name;
      if (!name || !result.reportId) continue;
      const rep = (await httpJson<any>('GET', `${BASE_URL}/api/storage/runs/${result.reportId}`)).body;
      reports.set(name, rep.report ?? rep.run ?? rep);
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await tracker.cleanup();
    if (agentServer) await new Promise<void>(r => agentServer.close(() => r()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('caught 500 + failing expect → FAILED with the assertion (counted in the pass rate)', () => {
    if (!backendAvailable) return;
    const report = reports.get('caught-500-asserted');
    expect(report).toBeDefined();
    expect(report.passFailStatus).toBe('failed');
    expect(report.failureStage).toBeUndefined();
    expect(report.metricsStatus).toBe('completed');
    const gate = (report.matcherResults || []).find((m: any) => m.method === 'code-assertion' && !m.notReached);
    expect(gate).toMatchObject({ pass: false });
    expect(gate.errorMessage).toMatch(/request succeeded \(HTTP 2xx\)/);
    expect(gate.actual).toMatch(/REST request failed: 500/);
    const tcId = (evaluationRun.testCaseSnapshots || []).find((s: any) => s.name === 'caught-500-asserted')?.id;
    expect(evaluationRun.results[tcId]).toMatchObject({ status: 'failed', passFailStatus: 'failed' });
  });

  it('uncaught 500 → AGENT ERROR (excluded from the pass rate, #496 kept)', () => {
    if (!backendAvailable) return;
    const report = reports.get('uncaught-500');
    expect(report).toBeDefined();
    expect(report.failureStage).toBe('agent');
    expect(report.metricsStatus).toBe('error');
    expect(report.passFailStatus ?? null).toBeNull();
    expect(report.agentError).toMatchObject({ kind: 'http_500' });
  });
});
