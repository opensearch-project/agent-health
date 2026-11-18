/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real CLI subprocess + real backend + a local REST stub agent — regression
 * guard for #617: a negated chai assertion (`expect(x).to.not.match(re)`)
 * was persisted with a `description` that read as the OPPOSITE check
 * ("… to match /re/") while its `errorMessage` said "not to match", so the
 * report contradicted itself and the Judge tab / case TL;DR stated the
 * inverse of what the test asserted.
 *
 * The fixture is the issue's own shape: the agent answers "none — top 3: …"
 * and the test asserts the answer does NOT start with "none — " (fails),
 * plus a passing negated check and a positive one on the same answer.
 *
 * Prerequisites: backend at AH_PORT (self-skips otherwise; file storage is
 * fine — everything created is tracked and deleted), `npm run build:cli`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request as httpRequest } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { withCliCoverage } from '../../helpers/cliCoverage';
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
    const child = spawn('node', args, { cwd: REPO_ROOT, env: withCliCoverage(env) });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ status: signal ? null : code, stdout, stderr }); });
  });
}

const AGENT_ANSWER = 'none — top 3: a; b; c';

const FIXTURE = `
const { test, expect } = require('@opensearch-project/agent-health');

// Issue #617's shape: the answer starts with "none — ", the test asserts it must NOT.
test('negated-match-fails', { prompt: 'which items match?' }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput, 'no expected item in the top 3').to.not.match(/^none — /);
});

// Passing negated checks of several forms, plus a positive one, on the same answer.
test('negated-checks-pass', { prompt: 'which items match?' }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.not.match(/^error/);
  expect(result.agentOutput).to.not.include('zzz');
  expect(result.agentOutput).to.not.be.empty;
  expect(result.trajectory).to.not.haveCalledTool('delete_index');
  expect(result.agentOutput).to.include('top 3');
});
`;

describe('CLI — negated assertions keep the negation in the persisted description (#617)', () => {
  let backendAvailable = false;
  let agentServer: http.Server;
  let tempDir: string;
  const reports = new Map<string, any>();
  const tracker = createTestDataTracker();

  beforeAll(async () => {
    try {
      backendAvailable = (await httpJson<any>('GET', `${BASE_URL}/api/storage/health`)).body?.status === 'ok';
    } catch { backendAvailable = false; }
    if (!backendAvailable) {
      console.warn(`[cli-negation] Backend not reachable at ${BASE_URL} — skipping. Start with: npm run dev:server`);
      return;
    }
    if (!existsSync(CLI_BUNDLE)) {
      const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) throw new Error(`CLI build failed: ${build.stderr}`);
    }

    agentServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ response: AGENT_ANSWER }));
      });
    });
    await new Promise<void>(r => agentServer.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/ask`;

    const reg = await httpJson<any>('POST', `${BASE_URL}/api/agents/custom`, { name: uniqueTestName('stub-negation-rest'), endpoint, connectorType: 'rest' });
    if (reg.status === 409) {
      backendAvailable = false;
      console.warn('[cli-negation] Backend is code-first (409 on custom agents) — skipping.');
      return;
    }
    expect(reg.status).toBe(201);
    const agentKey: string = reg.body.agent.key;
    tracker.customAgent(agentKey);

    tempDir = mkdtempSync(join(tmpdir(), 'cli-negation-'));
    const fixturePath = join(tempDir, 'negation.eval.js');
    writeFileSync(fixturePath, FIXTURE, 'utf-8');

    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k.startsWith('AWS_'))) cleanEnv[k] = v;
    }
    cleanEnv.AH_PORT = new URL(BASE_URL).port || '4001';
    cleanEnv.AH_SUPPRESS_EXPERIMENTAL = '1';
    cleanEnv.AH_QUIET_DEPRECATIONS = '1';
    const benchmarkName = uniqueTestName('cli-negation');
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

    let evaluationRun = (await httpJson<any>('GET', `${BASE_URL}/api/storage/evaluation-runs/${runId}`)).body;
    evaluationRun = evaluationRun.evaluationRun ?? evaluationRun;
    for (const [tcId, result] of Object.entries((evaluationRun.results || {}) as Record<string, any>)) {
      tracker.run(result.reportId);
      const name = (evaluationRun.testCaseSnapshots || []).find((s: any) => s.id === tcId)?.name;
      if (!name || !result.reportId) continue;
      const rep = (await httpJson<any>('GET', `${BASE_URL}/api/storage/runs/${result.reportId}`)).body;
      reports.set(name, rep.report ?? rep.run ?? rep);
    }
    for (const [name, rep] of reports) {
      console.log(`[cli-negation] ${name}: ${rep.passFailStatus} ${JSON.stringify((rep.matcherResults || []).map((r: any) => ({ d: r.description, pass: r.pass })))}`);
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await tracker.cleanup();
    if (agentServer) await new Promise<void>(r => agentServer.close(() => r()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  const bodyChecks = (name: string) =>
    (reports.get(name)?.matcherResults || []).filter((r: any) => r.method === 'code-assertion' && !r.notReached);

  it("the issue's case: description says 'not to match', agrees with errorMessage, case FAILED", () => {
    if (!backendAvailable) return;
    const report = reports.get('negated-match-fails');
    expect(report).toBeDefined();
    expect(report.passFailStatus).toBe('failed');
    const [row] = bodyChecks('negated-match-fails');
    expect(row).toMatchObject({ pass: false });
    expect(row.description).toBe(`'${AGENT_ANSWER}' not to match /^none — /`);
    expect(row.errorMessage).toBe(`no expected item in the top 3: expected '${AGENT_ANSWER}' not to match /^none — /`);
  });

  it('every passing `.not` form is described with its negation; the positive check is unchanged', () => {
    if (!backendAvailable) return;
    expect(reports.get('negated-checks-pass')?.passFailStatus).toBe('passed');
    const rows = bodyChecks('negated-checks-pass');
    expect(rows.map((r: any) => r.pass)).toEqual([true, true, true, true, true]);
    expect(rows.map((r: any) => r.description)).toEqual([
      `'${AGENT_ANSWER}' not to match /^error/`,
      `'${AGENT_ANSWER}' to not include 'zzz'`,
      `'${AGENT_ANSWER}' not to be empty`,
      "trajectory to NOT have called tool 'delete_index'",
      `'${AGENT_ANSWER}' to include 'top 3'`,
    ]);
  });
});
