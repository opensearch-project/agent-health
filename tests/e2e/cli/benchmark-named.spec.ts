/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI e2e: `agent-health benchmark -n <existing benchmark> -a <rest agent>` and
 * `benchmark -f <cases.json> -n <name> -a <rest agent>` against the running
 * backend, with a real REST agent that adopts W3C `traceparent` and exports
 * OTLP spans into the backend's own `/v1/traces` receiver.
 *
 * These are the two NPX/CLI invocations that used to take the legacy
 * `POST /api/storage/benchmarks/:id/execute` route. That runner put every
 * test case of a run under ONE OTel trace and persisted the connector run id
 * as `traceId`, so `useTraces` REST agents came back 0/N "evaluator could not
 * run" (trace_timeout). Both now execute through the evaluation-runs API.
 *
 * Asserted end-to-end (child process + storage API):
 *   - exit code 0 and the deprecation notice in the CLI output;
 *   - exactly one evaluation run created via the evaluation-runs API
 *     (`trigger: 'cli'`), completed, N results;
 *   - the agent was invoked once per case, each under a DISTINCT trace id;
 *   - N/N reports have `metricsStatus: 'ready'` (never `'error'`), `runId`
 *     equal to the agent's conversation id and a `traceId` that is either a
 *     real W3C trace id or absent — never the connector id.
 *
 * The backend's eval telemetry (OTEL_EVAL_ENABLED) may be on or off: with it
 * on, the agent adopts the eval span's trace (Strategy A) and report.traceId
 * equals it; with it off the agent mints its own trace ids and correlation is
 * by run id (Strategy B). Both must resolve.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from '../fixtures/test-fixtures';
import { uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';

const backendPort = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001';
const BASE_URL = `http://127.0.0.1:${backendPort}`;
const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');
const W3C_TRACE_ID = /^[0-9a-f]{32}$/i;

interface CliResult { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], timeoutMs = 150_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Explicit port → the CLI reuses the harness' server even in CI mode.
        AH_PORT: backendPort,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function api<T = any>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${pathname} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function registerAgent(agent: TraceparentRestAgent): Promise<string> {
  const created = await api<{ agent: { key: string } }>('/api/agents/custom', {
    method: 'POST',
    body: JSON.stringify({
      name: uniqueTestName('cli-e2e-rest-agent'),
      endpoint: agent.url,
      connectorType: 'rest',
      useTraces: true,
    }),
  });
  return created.agent.key;
}

function caseJson(i: number) {
  return {
    name: uniqueTestName(`cli-e2e-case-${i}`),
    category: 'RCA',
    difficulty: 'Easy',
    initialPrompt: `search products ${i} ${uniqueTestName('q')}`,
    expectedOutcomes: ['returns a product'],
    context: [],
  };
}

/** Shared assertions on the run the CLI produced. */
async function assertRunResolved(opts: {
  benchmarkId: string;
  agent: TraceparentRestAgent;
  caseCount: number;
  testData: { evaluationRun(id: string): void; run(id: string): void };
}) {
  const { evaluationRuns } = await api<{ evaluationRuns: any[] }>(
    `/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(opts.benchmarkId)}&size=10`
  );
  // Created through the evaluation-runs API — never the legacy /execute route.
  expect(evaluationRuns).toHaveLength(1);
  const run = evaluationRuns[0];
  opts.testData.evaluationRun(run.id);
  expect(run.trigger).toBe('cli');
  expect(run.status).toBe('completed');
  const results = Object.values(run.results || {}) as any[];
  expect(results).toHaveLength(opts.caseCount);
  for (const r of results) opts.testData.run(r.reportId);

  // One agent invocation per case, each in its own trace.
  expect(opts.agent.invocations).toHaveLength(opts.caseCount);
  expect(new Set(opts.agent.invocations.map(i => i.traceId)).size).toBe(opts.caseCount);

  const reports = await Promise.all(results.map(async (r) => {
    const body = await api<any>(`/api/storage/runs/${encodeURIComponent(r.reportId)}`);
    return body.run ?? body;
  }));
  const traceIds = new Set<string>();
  for (const report of reports) {
    expect(report.metricsStatus).toBe('ready');
    expect(report.traceError).toBeFalsy();
    expect(['passed', 'failed']).toContain(report.passFailStatus);
    const invocation = opts.agent.invocations.find(i => i.conversationId === report.runId);
    expect(invocation, `report.runId ${report.runId} should be one of the agent's conversation ids`).toBeDefined();
    if (report.traceId !== undefined && report.traceId !== null) {
      expect(report.traceId).toMatch(W3C_TRACE_ID);
      expect(report.traceId).not.toBe(report.runId);
      traceIds.add(report.traceId);
      if (invocation!.traceparent) expect(report.traceId).toBe(invocation!.traceId);
    }
  }
  if (traceIds.size > 0) expect(traceIds.size).toBe(opts.caseCount);
  return { run, reports };
}

test.describe('CLI: benchmark against a traceparent-adopting REST agent', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let agent: TraceparentRestAgent;

  test.beforeEach(async () => {
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
  });
  test.afterEach(async () => {
    await agent.close();
  });

  test('`benchmark -n <existing> -a <agent> -c N` runs via the evaluation-runs API with one trace per case and N/N resolved reports', async ({ testData }) => {
    const agentKey = await registerAgent(agent);
    testData.customAgent(agentKey);

    const CASES = 2;
    const testCaseIds: string[] = [];
    for (let i = 1; i <= CASES; i++) {
      const body = await api<any>('/api/storage/test-cases', { method: 'POST', body: JSON.stringify(caseJson(i)) });
      const id = (body.testCase ?? body).id;
      testData.testCase(id);
      testCaseIds.push(id);
    }
    const benchName = uniqueTestName('cli-e2e-named');
    const benchBody = await api<any>('/api/storage/benchmarks', {
      method: 'POST',
      body: JSON.stringify({ name: benchName, description: 'cli e2e', testCaseIds }),
    });
    const benchmarkId = (benchBody.benchmark ?? benchBody).id;
    testData.benchmark(benchmarkId);

    const result = await runCli(['benchmark', '-n', benchName, '-a', agentKey, '-c', String(CASES)]);
    const out = strip(result.stdout + result.stderr);

    expect(result.code, out).toBe(0);
    // The harness always names the backend port explicitly (AH_PORT), so the
    // CLI must reuse the already-running server even under CI=true — where the
    // implicit-port guard ("Server already running … In CI mode … this is an
    // error") would otherwise refuse (this exact failure was CI-red on the
    // first version of this spec). See cli/utils/serverLifecycle.ts.
    expect(out).toContain('Connected to existing server on port');
    if (process.env.CI) expect(out).toContain(`Using existing server on :${backendPort} (explicit port)`);
    expect(out).toContain('running through the evaluation-runs API');
    expect(out).toContain(`Benchmark: ${benchName} (${benchmarkId})`);
    expect(out).toContain('Benchmark Summary');
    expect(out).not.toContain('errored — evaluator could not run');

    const { run } = await assertRunResolved({ benchmarkId, agent, caseCount: CASES, testData });
    // The summary table names the evaluation run, and the results link points at it.
    expect(out).toContain(run.id);
    expect(out).toContain(`/evaluations/benchmarks/${benchmarkId}/runs/${run.id}`);
  });

  test('`benchmark -f <cases.json> -n <name> -a <agent>` imports, creates the benchmark and runs it via the evaluation-runs API', async ({ testData }) => {
    const agentKey = await registerAgent(agent);
    testData.customAgent(agentKey);

    const CASES = 2;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cli-e2e-'));
    const file = path.join(tmpDir, 'cases.json');
    const cases = Array.from({ length: CASES }, (_, i) => caseJson(i + 1));
    fs.writeFileSync(file, JSON.stringify(cases, null, 2));
    const benchName = uniqueTestName('cli-e2e-file');

    let result: CliResult;
    try {
      result = await runCli(['benchmark', '-f', file, '-n', benchName, '-a', agentKey]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    const out = strip(result.stdout + result.stderr);

    // Track everything the import created, whatever happens next.
    const { benchmarks } = await api<{ benchmarks: any[] }>('/api/storage/benchmarks');
    const bench = benchmarks.find(b => b.name === benchName);
    expect(bench, `benchmark "${benchName}" should have been created by the import`).toBeDefined();
    testData.benchmark(bench.id);
    for (const id of bench.testCaseIds || []) testData.testCase(id);

    expect(result.code, out).toBe(0);
    expect(out).toContain('Connected to existing server on port');
    if (process.env.CI) expect(out).toContain(`Using existing server on :${backendPort} (explicit port)`);
    expect(out).toContain('Running in file mode');
    expect(out).toContain('running through the evaluation-runs API');
    expect(out).toContain(`Imported ${CASES} test cases`);
    expect(out).not.toContain('errored — evaluator could not run');
    expect(bench.testCaseIds).toHaveLength(CASES);

    await assertRunResolved({ benchmarkId: bench.id, agent, caseCount: CASES, testData });
  });
});
