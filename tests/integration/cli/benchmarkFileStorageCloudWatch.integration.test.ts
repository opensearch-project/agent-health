/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The CLI route #640 broke and nothing covered: `agent-health benchmark` →
 * a server on FILE storage (no `storage` block) reading agent traces from the
 * CLOUDWATCH observability backend.
 *
 * Everything in the chain is real: the packaged CLI bundle (spawned under
 * `withCliCoverage()`), the server as its own `agent-health serve` child
 * process with the project as cwd (config discovery, `.env`, the file storage
 * adapter under `<project>/.agent-health/`), the REST connector, the SDK eval
 * body, the CloudWatch reader and an unmodified `@aws-sdk/client-cloudwatch-logs`
 * signing requests to `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS`. The two network
 * peers are local HTTP servers: a REST retrieval agent that emits spans the way
 * an instrumented agent does, and a CloudWatch Logs API stub that honours time
 * bounds like the real service (tests/helpers/).
 *
 * Then the suite asks the server what the run inspector, the benchmark Runs
 * table and the CLI user see, and pins:
 *   - #640/#641 client: a file-backed report reads back through the REAL browser
 *     storage client WITH its timestamp (the file adapter writes no createdAt);
 *   - #640/#641 server: exact ids (traceId / runId / session id) find the run's
 *     spans even when the Strategy-C window hint does not cover the run;
 *   - #599: an errored tool span is NOT a failed run / "Metrics unavailable";
 *   - the CLI summary and exit code reflect the per-case verdicts.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { withCliCoverage } from '../../helpers/cliCoverage';
import {
  createFileStorageCloudWatchProject,
  httpJson,
  CLI_BUNDLE,
  DEMO_AGENT_KEY,
  DEMO_AGENT_SERVICE_NAME,
  EVAL_FILE_RELATIVE,
  type FileStorageCloudWatchProject,
} from '../../helpers/fileStorageCloudWatchProject';
import { DEMO_AGENT_COST_USD, DEMO_AGENT_LLM_CALLS, DEMO_AGENT_SPANS, DEMO_AGENT_TOKENS, DEMO_AGENT_TOOL } from '../../helpers/demoRetrievalAgentStub';
import { aggregateRunTelemetry, buildRunTelemetryCorrelation } from '@/lib/runTelemetry';
import type { EvaluationReport } from '@/types';

const SUITE_TIMEOUT = 240_000;
const HOUR_MS = 60 * 60 * 1000;
const TOTAL_TOKENS = DEMO_AGENT_TOKENS.input + DEMO_AGENT_TOKENS.output;

// The three cases of the eval file, by name (tests/helpers/fileStorageCloudWatchProject.ts).
const CASE_OK = 'answers from the knowledge base';
const CASE_TOOL_ERROR = 'a failed tool attempt is retried';
const CASE_FAILS = 'flags an answer without a citation';

/** The Strategy-C window the run inspector derives from a report (components/RunDetailsContent.tsx, fetchTracesForReport). */
function inspectorWindow(report: Pick<EvaluationReport, 'timestamp' | 'performanceMetrics' | 'sessionId'>) {
  const SLACK_MS = 60_000;
  const FALLBACK_LOOKBACK_MS = 30 * 60_000;
  const endedAt = Date.parse(report.timestamp || '') || Date.now();
  const durationMs = report.performanceMetrics?.durationMs ?? 0;
  const lookbackMs = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
  return { serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: endedAt - lookbackMs, endedAt: endedAt + SLACK_MS, ...(report.sessionId ? { sessionId: report.sessionId } : {}) };
}

function runCli(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    // Async spawn: the agent + CloudWatch stubs live in THIS process; a blocked event loop would never answer the server.
    const child = spawn(process.execPath, [CLI_BUNDLE, ...args], { cwd, env: withCliCoverage(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ status: signal ? null : code, stdout, stderr }); });
  });
}

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('CLI benchmark → file storage + CloudWatch observability (the #640 route)', () => {
  let project: FileStorageCloudWatchProject;
  let cli: { status: number | null; stdout: string; stderr: string };
  let benchmarkId: string;
  let evalRunId: string;
  let evaluationRun: any;
  /** Persisted report per case name, as `GET /api/storage/runs/:id` returns it. */
  const reports = new Map<string, any>();
  /** The REAL browser storage client, loaded after AH_PORT points at this suite's server. */
  let asyncRunStorage: typeof import('@/services/storage/asyncRunStorage').asyncRunStorage;
  const savedAhPort = process.env.AH_PORT;

  beforeAll(async () => {
    if (!existsSync(CLI_BUNDLE)) throw new Error(`${CLI_BUNDLE} missing — run npm run build:all first`);
    project = await createFileStorageCloudWatchProject({ prefix: 'ah-cli-file-cw' });
    await project.startServer('cli');

    cli = await runCli(['benchmark', '-f', `./${EVAL_FILE_RELATIVE}`, '-a', DEMO_AGENT_KEY, '-n', 'File storage + CloudWatch smoke'], project.dir, project.env, SUITE_TIMEOUT - 60_000);
    if (cli.status === null) throw new Error(`CLI timed out.\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
    const m = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/.exec(plain(cli.stdout));
    if (!m) throw new Error(`Could not parse benchmark/run ids from CLI output:\n${cli.stdout}\n${cli.stderr}`);
    [, benchmarkId, evalRunId] = m;

    const runDoc = await httpJson(`${project.baseUrl}/api/storage/evaluation-runs/${evalRunId}`);
    evaluationRun = runDoc.body.evaluationRun ?? runDoc.body;
    for (const [tcId, result] of Object.entries((evaluationRun.results || {}) as Record<string, any>)) {
      const name = (evaluationRun.testCaseSnapshots || []).find((s: any) => s.id === tcId)?.name;
      const rep = await httpJson(`${project.baseUrl}/api/storage/runs/${result.reportId}`);
      reports.set(name, rep.body.report ?? rep.body.run ?? rep.body);
    }

    process.env.AH_PORT = String(project.port); // lib/config computes the storage API URL from AH_PORT at import time
    jest.isolateModules(() => {
      asyncRunStorage = require('@/services/storage/asyncRunStorage').asyncRunStorage;
    });
  }, SUITE_TIMEOUT);

  afterAll(async () => {
    if (savedAhPort === undefined) delete process.env.AH_PORT;
    else process.env.AH_PORT = savedAhPort;
    await project?.cleanup();
  });

  // ─── the server the CLI talked to ─────────────────────────────────────────

  it('the server runs on FILE storage with the CloudWatch backend (the setup of #640)', async () => {
    const storage = await httpJson(`${project.baseUrl}/api/storage/health`);
    expect(storage.body).toMatchObject({ status: 'ok', backend: 'file' });
    const traces = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1, runIds: ['no-such-run'] } });
    expect(traces.status).toBe(200);
    expect(traces.body.backend).toBe('cloudwatch');
    // Every AWS call went to the local stub (signed by the real SDK), none anywhere else.
    expect(project.cloudWatch.calls.length).toBeGreaterThan(0);
    expect(project.cloudWatch.calls.every((c) => ['FilterLogEvents', 'StartQuery', 'GetQueryResults', 'DescribeLogGroups', 'StopQuery'].includes(c.target))).toBe(true);
  });

  // ─── what the CLI user saw ────────────────────────────────────────────────

  it('CLI summary counts the verdicts; a FAILED case is a result, not a CLI error (exit 0 — exit 1 is for errored / not-run cases, #600)', () => {
    const out = plain(cli.stdout);
    // Spinner/lifecycle lines go to stderr by design (stdout stays parseable).
    expect(plain(cli.stderr)).toContain('Evaluation run completed (3/3 test cases)');
    expect(out).toMatch(/Passed:\s+2/);
    expect(out).toMatch(/Failed:\s+1/);
    expect(out).toMatch(/Total:\s+3/);
    expect(out).toContain(`/evaluations/benchmarks/${benchmarkId}/runs/${evalRunId}`);
    expect(cli.status).toBe(0);
    expect(evaluationRun.status).toBe('completed');
    expect(project.agent.invocations).toHaveLength(3);
  });

  it('the three cases were judged in code from the agent reply AND the CloudWatch spans read during the run', () => {
    expect(reports.get(CASE_OK)).toMatchObject({ passFailStatus: 'passed', metricsStatus: 'completed', evaluationType: 'deterministic' });
    expect(reports.get(CASE_TOOL_ERROR)).toMatchObject({ passFailStatus: 'passed' });
    expect(reports.get(CASE_FAILS)).toMatchObject({ passFailStatus: 'failed' });
    // The `traces` fixture was served by the CloudWatch backend during the run (useTraces: true).
    const tokenCheck = (reports.get(CASE_OK).matcherResults as any[]).find((m) => /to equal 4050/.test(m.description));
    expect(tokenCheck).toMatchObject({ pass: true });
    const toolCheck = (reports.get(CASE_OK).matcherResults as any[]).find((m) => /search_documents/.test(m.description));
    expect(toolCheck).toMatchObject({ pass: true });
    // No LLM judge was involved (deterministic-only bodies; no credentials needed).
    expect(reports.get(CASE_OK).judgeProvider).toBe('none');
  });

  // ─── the file-storage read-back path ──────────────────────────────────────

  it('a report persisted by the run has the FILE adapter shape: `timestamp`, no `createdAt`, plus the correlation ids and the spans', () => {
    for (const name of [CASE_OK, CASE_TOOL_ERROR, CASE_FAILS]) {
      const r = reports.get(name);
      const inv = project.agent.invocations.find((i) => i.runId === r.runId)!;
      expect(inv).toBeDefined();
      expect(Date.parse(r.timestamp)).toBeGreaterThan(inv.startedAt - 5_000);
      expect(r.createdAt).toBeUndefined(); // the shape toTestCaseRun must map (#640)
      expect(r).toMatchObject({ runId: inv.runId, sessionId: inv.sessionId, traceId: inv.traceId, agentKey: DEMO_AGENT_KEY, connectorProtocol: 'rest' });
      expect(r.spans).toHaveLength(inv.spanCount);
      // Per-run tokens/cost stamped on the report from the spans (always-record).
      expect(r.performanceMetrics).toMatchObject({ totalTokens: TOTAL_TOKENS });
      expect(r.performanceMetrics.totalCostUsd).toBeCloseTo(DEMO_AGENT_COST_USD, 9);
    }
    expect(reports.get(CASE_TOOL_ERROR).spans).toHaveLength(DEMO_AGENT_SPANS.withToolError);
    expect(reports.get(CASE_OK).spans).toHaveLength(DEMO_AGENT_SPANS.normal);
  });

  it('the REAL browser storage client reads the file-backed report back WITH its timestamp (red before #641: createdAt only → undefined)', async () => {
    const stored = reports.get(CASE_OK);
    const back = await asyncRunStorage.getReportById(stored.id);
    expect(back).not.toBeNull();
    expect(back!.timestamp).toBe(stored.timestamp);
    expect(back!.runId).toBe(stored.runId);
    expect(back!.sessionId).toBe(stored.sessionId);
    expect(back!.performanceMetrics?.durationMs).toBe(stored.performanceMetrics.durationMs);
    // …and the window the inspector derives from it is the run's, not "now ± a minute".
    const win = inspectorWindow(back!);
    expect(win.endedAt).toBe(Date.parse(stored.timestamp) + 60_000);
  });

  // ─── the Traces tab (POST /api/traces) ────────────────────────────────────

  it('the exact request the run inspector sends returns the run\'s spans', async () => {
    for (const name of [CASE_OK, CASE_TOOL_ERROR]) {
      const r = reports.get(name);
      const res = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, runIds: [r.runId], agents: [inspectorWindow(r)] } });
      expect(res.status).toBe(200);
      expect(res.body.backend).toBe('cloudwatch');
      expect(res.body.warning).toBeUndefined();
      const own = res.body.spans.filter((s: any) => s.traceId === r.traceId);
      expect(own.map((s: any) => s.spanId).sort()).toEqual(r.spans.map((s: any) => s.spanId).sort());
      expect(own.every((s: any) => s.attributes['session.id'] === r.sessionId)).toBe(true);
      // The always-on Strategy-C clause (service.name + run window) is UNIONED
      // with the exact ids, so the sibling cases of the same agent that ran in
      // the same seconds ride along — the documented concurrency noise of
      // Strategy C (AGENTS.md → Trace correlation), identical on OpenSearch.
      expect(res.body.total).toBeGreaterThanOrEqual(r.spans.length);
      expect(res.body.spans.every((s: any) => s.attributes['service.name'] === DEMO_AGENT_SERVICE_NAME || s.resource?.attributes?.['service.name'] === DEMO_AGENT_SERVICE_NAME || project.agent.invocations.some((i) => i.traceId === s.traceId))).toBe(true);
    }
    // Strategy A alone (the report's traceId) and Strategy D alone (session id) each find the same run.
    const r = reports.get(CASE_OK);
    const byTrace = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, traceId: r.traceId } });
    expect(byTrace.body.total).toBe(DEMO_AGENT_SPANS.normal);
    const bySession = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, sessionId: r.sessionId } });
    expect(bySession.body.total).toBe(DEMO_AGENT_SPANS.normal);
    expect(bySession.body.spans.map((s: any) => s.name).sort()).toEqual(['POST /invoke', `chat demo-provider.demo-model-v1`, `chat demo-provider.demo-model-v1`, `execute_tool ${DEMO_AGENT_TOOL}`]);
  });

  it('a run-window hint that does NOT cover the run (the stale window of #640) never narrows the exact ids: spans are still found (red before #641)', async () => {
    const r = reports.get(CASE_OK);
    const now = Date.now();
    // The window a client with the wrong run time builds — here one that lies entirely before the run.
    const staleHint = { serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: now - 3 * HOUR_MS, endedAt: now - 2 * HOUR_MS, sessionId: r.sessionId };
    const callsBefore = project.cloudWatch.calls.length;
    const res = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, runIds: [r.runId], traceId: r.traceId, sessionId: r.sessionId, agents: [staleHint] } });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(DEMO_AGENT_SPANS.normal); // red on main: 0 — the scan was narrowed to the hint
    expect(res.body.warning).toBeUndefined();
    // The CloudWatch stub saw an Insights query over (at least) the configured lookback, not the 1-hour hint.
    const insights = project.cloudWatch.calls.slice(callsBefore).filter((c) => c.target === 'StartQuery');
    expect(insights.length).toBeGreaterThanOrEqual(1);
    const { startTime, endTime } = insights[0].input as { startTime: number; endTime: number };
    expect(endTime - startTime).toBeGreaterThanOrEqual(7 * 86_400 - 60);
  });

  it('a window-only request (no exact id) IS still narrowed to its window — a bare service name does not scan the lookback', async () => {
    const now = Date.now();
    const res = await httpJson(`${project.baseUrl}/api/traces`, {
      method: 'POST',
      body: { size: 1000, agents: [{ serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: now - 3 * HOUR_MS, endedAt: now - 2 * HOUR_MS }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    // …while the run's own window (with no ids at all) finds every span of the three runs by service name.
    const inWindow = await httpJson(`${project.baseUrl}/api/traces`, {
      method: 'POST',
      body: { size: 1000, agents: [{ serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: now - 10 * 60_000, endedAt: now }] },
    });
    expect(inWindow.body.total).toBe(2 * DEMO_AGENT_SPANS.normal + DEMO_AGENT_SPANS.withToolError);
  });

  // ─── per-run metrics (GET /api/metrics/:runId, POST /api/metrics/batch) ───

  it('per-run metrics come from the CloudWatch spans: tokens, cost, LLM calls, tool calls', async () => {
    const r = reports.get(CASE_OK);
    const res = await httpJson(`${project.baseUrl}/api/metrics/${encodeURIComponent(r.runId)}?sessionId=${encodeURIComponent(r.sessionId)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runId: r.runId,
      traceId: r.traceId,
      inputTokens: DEMO_AGENT_TOKENS.input,
      outputTokens: DEMO_AGENT_TOKENS.output,
      totalTokens: TOTAL_TOKENS,
      llmCalls: DEMO_AGENT_LLM_CALLS,
      toolCalls: 1,
      toolsUsed: [DEMO_AGENT_TOOL],
      status: 'success',
      hasSpans: true,
    });
    expect(res.body.costUsd).toBeGreaterThan(0);
    expect(res.body.error).toBeUndefined();
    expect(res.body.agentErrorSpans).toBeUndefined();
  });

  it('a failed tool span in a found trace is NOT a failed run: status stays success, the errored span is counted (red before #599)', async () => {
    const r = reports.get(CASE_TOOL_ERROR);
    const res = await httpJson(`${project.baseUrl}/api/metrics/${encodeURIComponent(r.runId)}?sessionId=${encodeURIComponent(r.sessionId)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runId: r.runId, totalTokens: TOTAL_TOKENS, llmCalls: DEMO_AGENT_LLM_CALLS, status: 'success', hasSpans: true, agentErrorSpans: 1 });
    expect(res.body.error).toBeUndefined();
  });

  it('the benchmark Runs table roll-up (batch metrics with the UI\'s own correlation payload) reads every case, never "unavailable"', async () => {
    const reportsById: Record<string, any> = {};
    for (const r of reports.values()) reportsById[r.id] = r;
    const corr = buildRunTelemetryCorrelation([evaluationRun], reportsById);
    expect(corr.keys).toHaveLength(3);
    const res = await httpJson(`${project.baseUrl}/api/metrics/batch`, {
      method: 'POST',
      body: { runIds: corr.keys, sessionIds: corr.sessionIdByKey, traceIds: corr.traceIdByKey, agents: corr.agentsByKey },
    });
    expect(res.status).toBe(200);
    const byKey: Record<string, any> = {};
    for (const m of res.body.metrics) byKey[m.runId] = m;
    for (const key of corr.keys) {
      expect(byKey[key].error).toBeUndefined();
      expect(byKey[key]).toMatchObject({ totalTokens: TOTAL_TOKENS, status: 'success', hasSpans: true });
    }
    expect(res.body.aggregate.totalInputTokens + res.body.aggregate.totalOutputTokens).toBe(3 * TOTAL_TOKENS);
    expect(res.body.aggregate.totalRuns).toBe(3);
    const telemetry = aggregateRunTelemetry(evaluationRun, reportsById, byKey);
    expect(telemetry).toMatchObject({ totalTokens: 3 * TOTAL_TOKENS, llmCalls: 3 * DEMO_AGENT_LLM_CALLS, toolCalls: 3, spansCases: 3, totalCases: 3, errorCases: 0, unavailable: false, hasSpans: true });
    expect(telemetry!.costUsd).toBeGreaterThan(0);
  });
});
