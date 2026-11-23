/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The file-storage eval matrix, shared by the two observability sources
 * (tests/integration/cli/evalMatrix{OpenSearch,CloudWatch}.integration.test.ts):
 * TypeScript evals (`evals/retrieval.eval.ts`) run through the REAL packaged
 * CLI against a server on FILE storage that reads agent traces from ONE
 * observability source, and every answer the server gives the CLI, the run
 * inspector and the Runs table is asserted over real HTTP.
 *
 * Entries (the rows of the matrix):
 *   E1 `benchmark -f x.eval.ts -a <agent> -n <new>` — nothing listening: the CLI
 *      auto-starts the project's server, creates the benchmark, runs 6 cases.
 *   E2 `benchmark -f x.eval.ts -n <existing>` re-run is a second run; a
 *      DIFFERENT file under the same name is refused (#620) unless `--force`.
 *   E4 `run -t <stored .eval.ts case> -a <agent>` — the stored case's body is
 *      re-materialised from its source file and executed.
 *   E5 `report -f json --stdout` and `export --stdout` of the CLI-created run.
 *   (E3 `benchmark -n <existing>` alone is NOT here: on file storage the CLI
 *   still takes the legacy per-benchmark `/execute` route, which needs
 *   OpenSearch storage. It is being reworked separately — #612 step 3b — and
 *   that change carries its own E3 tests on both sources.)
 *
 * Behaviours asserted in every cell: deterministic-only cases; `judge()` with
 * the built-in mock judge; a failing `expect.soft` recorded next to the passing
 * ones; agent 5xx → ERRORED, not FAILED; a failed tool span → metrics still
 * present (#599); correlation by traceId, run id and `session.id`; a stale
 * run-window hint never hides the run (#640).
 *
 * Everything is a real process or a real peer: the CLI bundle (under
 * `withCliCoverage()`), the server the CLI auto-started (adopted by its
 * `/health` identity, killed by that PID only), the REST connector, the SDK
 * body, the trace reader (an unmodified `@aws-sdk/client-cloudwatch-logs` /
 * `@opensearch-project/opensearch`), the agent and the CloudWatch stub as
 * local HTTP servers, OpenSearch as a real node.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { withCliCoverage } from '../../../helpers/cliCoverage';
import {
  createFileStorageEvalProject,
  httpJson,
  CLI_BUNDLE,
  DEMO_AGENT_KEY,
  DEMO_AGENT_SERVICE_NAME,
  EVAL_FILE_RELATIVE,
  MATRIX_CASES,
  MATRIX_CASE_COUNT,
  MATRIX_VERDICT_COUNTS,
  MOCK_JUDGE_MODEL,
  OTHER_CASE_NAME,
  OTHER_EVAL_FILE_RELATIVE,
  type FileStorageEvalProject,
  type ObservabilitySource,
} from '../../../helpers/fileStorageEvalProject';
import { DEMO_AGENT_COST_USD, DEMO_AGENT_LLM_CALLS, DEMO_AGENT_SPANS, DEMO_AGENT_TOKENS, DEMO_AGENT_TOOL } from '../../../helpers/demoRetrievalAgentStub';
import { aggregateRunTelemetry, buildRunTelemetryCorrelation } from '@/lib/runTelemetry';
import { MODEL_PRICING } from '@/server/services/metricsService';
import type { EvaluationReport } from '@/types';

export const SUITE_TIMEOUT = 300_000;
const CLI_TIMEOUT = 150_000;
const HOUR_MS = 60 * 60 * 1000;
const TOTAL_TOKENS = DEMO_AGENT_TOKENS.input + DEMO_AGENT_TOKENS.output;
/** Cases of the eval file whose agent call succeeded (and therefore emitted spans). */
const TRACED_CASES = [MATRIX_CASES.ok, MATRIX_CASES.toolError, MATRIX_CASES.judged, MATRIX_CASES.fails, MATRIX_CASES.soft];
const SPANS_PER_RUN = 4 * DEMO_AGENT_SPANS.normal + DEMO_AGENT_SPANS.withToolError; // 21

export interface CliResult { status: number | null; stdout: string; stderr: string }

export const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** Spawn the staged package's CLI in the project. Async: the agent / CloudWatch peers live in THIS process and must keep answering. */
export function runCli(project: Pick<FileStorageEvalProject, 'cli' | 'dir' | 'env'>, args: string[], timeoutMs = CLI_TIMEOUT): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [project.cli, ...args], { cwd: project.dir, env: withCliCoverage(project.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ status: signal ? null : code, stdout, stderr }); });
  });
}

/** The Strategy-C window the run inspector derives from a report (components/RunDetailsContent.tsx, fetchTracesForReport). */
export function inspectorWindow(report: Pick<EvaluationReport, 'timestamp' | 'performanceMetrics' | 'sessionId'>) {
  const SLACK_MS = 60_000;
  const FALLBACK_LOOKBACK_MS = 30 * 60_000;
  const endedAt = Date.parse(report.timestamp || '') || Date.now();
  const durationMs = report.performanceMetrics?.durationMs ?? 0;
  const lookbackMs = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
  return { serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: endedAt - lookbackMs, endedAt: endedAt + SLACK_MS, ...(report.sessionId ? { sessionId: report.sessionId } : {}) };
}

const RUN_URL = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/;

/** The case set the CLI's source guard reads: top-level `testCaseIds` ∪ the current version's (cli/utils/benchmarkSourceGuard.ts). */
function currentBenchmarkTestCaseIds(benchmark: { testCaseIds?: string[]; versions?: Array<{ version: number; testCaseIds?: string[] }>; currentVersion?: number }): string[] {
  const ids = new Set<string>(benchmark.testCaseIds ?? []);
  const current = (benchmark.versions ?? []).find((v) => v.version === benchmark.currentVersion);
  for (const id of current?.testCaseIds ?? []) ids.add(id);
  return [...ids];
}

async function loadRun(baseUrl: string, runId: string) {
  const doc = await httpJson(`${baseUrl}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
  const run = doc.body.evaluationRun ?? doc.body;
  const reports = new Map<string, any>();
  for (const [tcId, result] of Object.entries((run.results || {}) as Record<string, any>)) {
    const name = (run.testCaseSnapshots || []).find((s: any) => s.id === tcId)?.name;
    if (!result.reportId) { reports.set(name, null); continue; }
    const rep = await httpJson(`${baseUrl}/api/storage/runs/${encodeURIComponent(result.reportId)}`);
    reports.set(name, rep.body.report ?? rep.body.run ?? rep.body);
  }
  return { run, reports };
}

async function runsOfBenchmark(baseUrl: string, benchmarkId: string): Promise<any[]> {
  const res = await httpJson(`${baseUrl}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}&limit=50`);
  const runs: any[] = res.body.evaluationRuns ?? res.body.runs ?? [];
  return runs.filter((r) => r.benchmarkId === benchmarkId);
}

export interface MatrixSuiteOptions {
  source: ObservabilitySource;
  openSearchEndpoint?: string;
}

export function describeEvalMatrix(label: string, options: MatrixSuiteOptions): void {
  const { source } = options;

  describe(label, () => {
    let project: FileStorageEvalProject;
    let benchmarkName: string;
    let cli: CliResult;
    let benchmarkId: string;
    let evalRunId: string;
    let evaluationRun: any;
    /** Persisted report per case name, as `GET /api/storage/runs/:id` returns it (null for an unreported case). */
    let reports: Map<string, any>;
    /** The REAL browser storage client, loaded after AH_PORT points at this suite's server. */
    let asyncRunStorage: typeof import('@/services/storage/asyncRunStorage').asyncRunStorage;
    const savedAhPort = process.env.AH_PORT;

    const traced = (key: keyof typeof MATRIX_CASES) => {
      const r = reports.get(MATRIX_CASES[key].name);
      if (!r) throw new Error(`no report for case ${MATRIX_CASES[key].name}`);
      return r;
    };

    beforeAll(async () => {
      if (!existsSync(CLI_BUNDLE)) throw new Error(`${CLI_BUNDLE} missing — run npm run build:all first`);
      project = await createFileStorageEvalProject({ source, prefix: `ah-cli-matrix-${source}`, openSearchEndpoint: options.openSearchEndpoint });
      benchmarkName = `Retrieval evals (${source}) ${Date.now()}`;

      // E1 — nothing listens on AH_PORT: the CLI auto-starts the project's server and leaves it running (no CI, no --stop-server).
      cli = await runCli(project, ['benchmark', '-f', `./${EVAL_FILE_RELATIVE}`, '-a', DEMO_AGENT_KEY, '-n', benchmarkName, '--judge-model', MOCK_JUDGE_MODEL]);
      if (cli.status === null) throw new Error(`CLI timed out.\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
      const m = RUN_URL.exec(plain(cli.stdout));
      if (!m) throw new Error(`Could not parse benchmark/run ids from CLI output (exit ${cli.status}):\n${cli.stdout}\n${cli.stderr}`);
      [, benchmarkId, evalRunId] = m;
      await project.adoptServer();

      ({ run: evaluationRun, reports } = await loadRun(project.baseUrl, evalRunId));

      process.env.AH_PORT = String(project.port); // lib/config computes the storage API URL from AH_PORT at import time
      jest.isolateModules(() => {
        asyncRunStorage = require('@/services/storage/asyncRunStorage').asyncRunStorage;
      });
    }, SUITE_TIMEOUT);

    afterAll(async () => {
      if (savedAhPort === undefined) delete process.env.AH_PORT;
      else process.env.AH_PORT = savedAhPort;
      await project?.cleanup();
    }, 60_000);

    // ─── the server the CLI auto-started ─────────────────────────────────────

    it(`E1: the CLI auto-started a server for the project on FILE storage with the ${source} observability source`, async () => {
      expect(plain(cli.stderr) + plain(cli.stdout)).toMatch(new RegExp(`Started server on port ${project.port}`));
      const health = await httpJson(`${project.baseUrl}/health`);
      expect(health.body.instance).toMatchObject({ pid: project.serverPid, cwd: project.dir });
      const storage = await httpJson(`${project.baseUrl}/api/storage/health`);
      expect(storage.body).toMatchObject({ status: 'ok', backend: 'file' });
      const traces = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1, runIds: ['no-such-run'] } });
      expect(traces.status).toBe(200);
      expect(traces.body.backend).toBe(source);
      if (source === 'cloudwatch') {
        // The stub received CloudWatch Logs API calls carrying a SigV4 signature — the unmodified AWS SDK is on the wire.
        const calls = project.cloudWatch!.calls;
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => ['FilterLogEvents', 'StartQuery', 'GetQueryResults', 'DescribeLogGroups', 'StopQuery'].includes(c.target))).toBe(true);
        expect(calls.every((c) => c.authScheme === 'AWS4-HMAC-SHA256')).toBe(true);
      } else {
        // The agent's spans are in the throw-away Data Prepper index the server reads as its traces pattern.
        const count = await project.spanIndex!.client.count({ index: project.spanIndex!.index });
        expect(count.body.count).toBe(SPANS_PER_RUN);
        expect(traces.body.spans).toEqual([]);
      }
    }, 30_000);

    // ─── what the CLI user saw ───────────────────────────────────────────────

    it('E1: the CLI summary counts PASSED / FAILED / ERRORED separately and exits 1 for the errored case (#600)', () => {
      const out = plain(cli.stdout);
      expect(out).toMatch(new RegExp(`Passed:\\s+${MATRIX_VERDICT_COUNTS.passed}\\b`));
      expect(out).toMatch(new RegExp(`Failed:\\s+${MATRIX_VERDICT_COUNTS.failed}\\b`));
      expect(out).toMatch(new RegExp(`Errored:\\s+${MATRIX_VERDICT_COUNTS.errored}\\b`));
      expect(out).toMatch(new RegExp(`Total:\\s+${MATRIX_CASE_COUNT}\\b`));
      expect(out).toContain(`/evaluations/benchmarks/${benchmarkId}/runs/${evalRunId}`);
      expect(cli.status).toBe(1);
      expect(evaluationRun).toMatchObject({ status: 'completed', benchmarkId, trigger: 'cli' });
      expect(project.agent.invocations).toHaveLength(MATRIX_CASE_COUNT);
      expect(project.agent.invocations.filter((i) => i.httpStatus === 500)).toHaveLength(1);
    });

    it('E1: deterministic cases are judged in code from the agent reply AND the spans read during the run — no LLM', () => {
      expect(traced('ok')).toMatchObject({ passFailStatus: 'passed', metricsStatus: 'completed', evaluationType: 'deterministic', judgeProvider: 'none' });
      const tokenCheck = (traced('ok').matcherResults as any[]).find((m) => /to equal 4050/.test(m.description));
      expect(tokenCheck).toMatchObject({ pass: true });
      expect((traced('ok').matcherResults as any[]).find((m) => /search_documents/.test(m.description))).toMatchObject({ pass: true });
      expect(traced('fails')).toMatchObject({ passFailStatus: 'failed' });
      const failing = (traced('fails').matcherResults as any[]).find((m) => m.pass === false);
      expect(failing.errorMessage).toMatch(/Billing FAQ/);
    });

    it('E1: judge() with the built-in mock judge → PASSED, judgeProvider "demo", the verdict recorded as a matcher', () => {
      const r = traced('judged');
      expect(r).toMatchObject({ passFailStatus: 'passed', judgeProvider: 'demo' });
      const judgeRows = (r.matcherResults as any[]).filter((m) => /^judge:/.test(m.description));
      expect(judgeRows).toHaveLength(1);
      expect(judgeRows[0]).toMatchObject({ pass: true });
      expect(judgeRows[0].description).toContain('cites the Billing FAQ article');
    });

    it('E1: a failing expect.soft fails the case and is recorded next to the soft pass and the hard check that followed (#621)', () => {
      const r = traced('soft');
      expect(r.passFailStatus).toBe('failed');
      const rows = (r.matcherResults as any[]).map((m) => ({ description: m.description, pass: m.pass }));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ pass: false });
      expect(rows[0].description).toMatch(/purchase order/);
      expect(rows[1]).toMatchObject({ pass: true });
      expect(rows[1].description).toMatch(/Billing FAQ/);
      expect(rows[2]).toMatchObject({ pass: true });
      expect(rows[2].description).toMatch(/completed within/i);
    });

    it('E1: an agent 5xx is ERRORED (failureStage agent, no verdict, no spans) — never a FAILED verdict (#598)', () => {
      const r = traced('outage');
      expect(r.failureStage).toBe('agent');
      expect(r.passFailStatus ?? null).toBeNull();
      expect(r.agentError).toMatchObject({ kind: 'http_500' });
      expect(r.spans ?? []).toHaveLength(0);
      const tcId = (evaluationRun.testCaseSnapshots || []).find((s: any) => s.name === MATRIX_CASES.outage.name)?.id;
      expect(evaluationRun.results[tcId].passFailStatus ?? null).toBeNull();
    });

    // ─── the file-storage read-back path ─────────────────────────────────────

    it('E1: every traced report has the FILE adapter shape — `timestamp`, no `createdAt` — plus the correlation ids and its spans', () => {
      for (const c of TRACED_CASES) {
        const r = reports.get(c.name);
        const inv = project.agent.invocations.find((i) => i.runId === r.runId)!;
        expect([c.name, inv]).not.toEqual([c.name, undefined]);
        expect(Date.parse(r.timestamp)).toBeGreaterThan(inv.startedAt - 5_000);
        expect(r.createdAt).toBeUndefined(); // the shape toTestCaseRun must map (#640)
        expect(r).toMatchObject({ runId: inv.runId, sessionId: inv.sessionId, traceId: inv.traceId, agentKey: DEMO_AGENT_KEY, connectorProtocol: 'rest' });
        expect(r.spans).toHaveLength(inv.spanCount);
        expect(r.performanceMetrics).toMatchObject({ totalTokens: TOTAL_TOKENS });
        expect(r.performanceMetrics.totalCostUsd).toBeCloseTo(DEMO_AGENT_COST_USD, 9);
      }
      expect(traced('toolError').spans).toHaveLength(DEMO_AGENT_SPANS.withToolError);
      expect(traced('ok').spans).toHaveLength(DEMO_AGENT_SPANS.normal);
    });

    it('E1: the REAL browser storage client reads the file-backed report back WITH its timestamp (red before #641: createdAt only → undefined)', async () => {
      const stored = traced('ok');
      const back = await asyncRunStorage.getReportById(stored.id);
      expect(back).not.toBeNull();
      expect(back!.timestamp).toBe(stored.timestamp);
      expect(back!.runId).toBe(stored.runId);
      expect(back!.sessionId).toBe(stored.sessionId);
      expect(back!.performanceMetrics?.durationMs).toBe(stored.performanceMetrics.durationMs);
      expect(inspectorWindow(back!).endedAt).toBe(Date.parse(stored.timestamp) + 60_000);
    }, 30_000);

    // ─── the Traces tab (POST /api/traces) ───────────────────────────────────

    it('E1: the exact request the run inspector sends returns the run\'s spans; traceId alone and session.id alone each return exactly its spans', async () => {
      for (const c of [MATRIX_CASES.ok, MATRIX_CASES.toolError]) {
        const r = reports.get(c.name);
        const res = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, runIds: [r.runId], agents: [inspectorWindow(r)] } });
        expect(res.status).toBe(200);
        expect(res.body.backend).toBe(source);
        expect(res.body.warning).toBeUndefined();
        const own = res.body.spans.filter((s: any) => s.traceId === r.traceId);
        expect(own.map((s: any) => s.spanId).sort()).toEqual(r.spans.map((s: any) => s.spanId).sort());
        expect(own.every((s: any) => s.attributes['session.id'] === r.sessionId)).toBe(true);
        // The always-on Strategy-C clause (service.name + run window) is UNIONED with the exact ids, so sibling
        // cases of the same agent that ran in the same seconds ride along (AGENTS.md → Trace correlation).
        expect(res.body.total).toBeGreaterThanOrEqual(r.spans.length);
        expect(res.body.spans.every((s: any) => project.agent.invocations.some((i) => i.traceId === s.traceId))).toBe(true);
      }
      const r = traced('ok');
      const byTrace = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, traceId: r.traceId } });
      expect(byTrace.body.total).toBe(DEMO_AGENT_SPANS.normal);
      const bySession = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, sessionId: r.sessionId } });
      expect(bySession.body.total).toBe(DEMO_AGENT_SPANS.normal);
      expect(bySession.body.spans.map((s: any) => s.name).sort()).toEqual(['POST /invoke', 'chat demo-provider.demo-model-v1', 'chat demo-provider.demo-model-v1', `execute_tool ${DEMO_AGENT_TOOL}`]);
      const toolError = traced('toolError');
      const errored = (await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, traceId: toolError.traceId } })).body.spans.filter((s: any) => s.status === 'ERROR');
      expect(errored).toHaveLength(1);
    }, 60_000);

    it('E1: a run-window hint that does NOT cover the run (the stale window of #640) never narrows the exact ids — runIds, traceId and agents[].sessionId each find the run on their own', async () => {
      const r = traced('ok');
      const now = Date.now();
      const staleWindow = { serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: now - 3 * HOUR_MS, endedAt: now - 2 * HOUR_MS };
      const requests: Array<[string, Record<string, unknown>]> = [
        ['runIds (Strategy B)', { runIds: [r.runId], agents: [staleWindow] }],
        ['traceId (Strategy A)', { traceId: r.traceId, agents: [staleWindow] }],
        ['agents[].sessionId (Strategy D, the inspector\'s shape)', { runIds: [r.runId], agents: [{ ...staleWindow, sessionId: r.sessionId }] }],
      ];
      for (const [label, body] of requests) {
        const callsBefore = project.cloudWatch?.calls.length ?? 0;
        const res = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, ...body } });
        expect(res.status).toBe(200);
        expect([label, res.body.total]).toEqual([label, DEMO_AGENT_SPANS.normal]); // CloudWatch, red before #641: 0 — the scan was narrowed to the hint
        expect(res.body.spans.every((s: any) => s.traceId === r.traceId)).toBe(true);
        expect(res.body.warning).toBeUndefined();
        if (source === 'cloudwatch') {
          // The stub saw an Insights query over (at least) the configured lookback, not the 1-hour hint.
          const insights = project.cloudWatch!.calls.slice(callsBefore).filter((c) => c.target === 'StartQuery');
          expect(insights.length).toBeGreaterThanOrEqual(1);
          const { startTime, endTime } = insights[0].input as { startTime: number; endTime: number };
          expect([label, endTime - startTime >= 7 * 86_400 - 60]).toEqual([label, true]);
        }
      }
      // A window-only request (no exact id) IS narrowed to its window; the run's own window finds every traced case by service name.
      const outside = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, agents: [staleWindow] } });
      expect(outside.body.total).toBe(0);
      const inside = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, agents: [{ serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: now - HOUR_MS, endedAt: now }] } });
      expect(inside.body.total).toBe(SPANS_PER_RUN);
    }, 60_000);

    // ─── per-run metrics (GET /api/metrics/:runId, POST /api/metrics/batch) ──

    it(`E1: per-run metrics come from the ${source} spans: tokens, cost, LLM calls, tool calls`, async () => {
      const r = traced('ok');
      const res = await httpJson(`${project.baseUrl}/api/metrics/${encodeURIComponent(r.runId)}?sessionId=${encodeURIComponent(r.sessionId)}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        runId: r.runId, traceId: r.traceId,
        inputTokens: DEMO_AGENT_TOKENS.input, outputTokens: DEMO_AGENT_TOKENS.output, totalTokens: TOTAL_TOKENS,
        llmCalls: DEMO_AGENT_LLM_CALLS, toolCalls: 1, toolsUsed: [DEMO_AGENT_TOOL], status: 'success', hasSpans: true,
      });
      const rates = MODEL_PRICING.default;
      expect(res.body.costUsd).toBeCloseTo((DEMO_AGENT_TOKENS.input / 1e6) * rates.input + (DEMO_AGENT_TOKENS.output / 1e6) * rates.output, 9);
      expect(res.body.error).toBeUndefined();
      expect(res.body.agentErrorSpans).toBeUndefined();
    }, 30_000);

    it('E1: a failed tool span in a found trace is NOT a failed run: status stays success, the errored span is counted (red before #599)', async () => {
      const r = traced('toolError');
      const res = await httpJson(`${project.baseUrl}/api/metrics/${encodeURIComponent(r.runId)}?sessionId=${encodeURIComponent(r.sessionId)}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ runId: r.runId, totalTokens: TOTAL_TOKENS, llmCalls: DEMO_AGENT_LLM_CALLS, status: 'success', hasSpans: true, agentErrorSpans: 1 });
      expect(res.body.error).toBeUndefined();
    }, 30_000);

    it('E1: the benchmark Runs table roll-up (batch metrics with the UI\'s own correlation payload) reads every traced case; the errored case is the only one without spans', async () => {
      const reportsById: Record<string, any> = {};
      for (const r of reports.values()) if (r) reportsById[r.id] = r;
      const corr = buildRunTelemetryCorrelation([evaluationRun], reportsById);
      expect(corr.keys.length).toBeGreaterThanOrEqual(TRACED_CASES.length);
      const res = await httpJson(`${project.baseUrl}/api/metrics/batch`, {
        method: 'POST',
        body: { runIds: corr.keys, sessionIds: corr.sessionIdByKey, traceIds: corr.traceIdByKey, agents: corr.agentsByKey },
      });
      expect(res.status).toBe(200);
      const byKey: Record<string, any> = {};
      for (const m of res.body.metrics) byKey[m.runId] = m;
      for (const c of TRACED_CASES) {
        const key = reports.get(c.name).runId;
        expect([c.name, byKey[key]?.error]).toEqual([c.name, undefined]);
        expect(byKey[key]).toMatchObject({ totalTokens: TOTAL_TOKENS, status: 'success', hasSpans: true });
      }
      expect(res.body.aggregate.totalInputTokens + res.body.aggregate.totalOutputTokens).toBe(TRACED_CASES.length * TOTAL_TOKENS);
      const telemetry = aggregateRunTelemetry(evaluationRun, reportsById, byKey);
      expect(telemetry).toMatchObject({ totalTokens: TRACED_CASES.length * TOTAL_TOKENS, llmCalls: TRACED_CASES.length * DEMO_AGENT_LLM_CALLS, toolCalls: TRACED_CASES.length, spansCases: TRACED_CASES.length, totalCases: MATRIX_CASE_COUNT, unavailable: false, hasSpans: true });
    }, 30_000);

    // ─── E4: run one stored .eval.ts case ────────────────────────────────────

    it('E4: `run -t <stored .eval.ts case> -a <agent>` re-materialises the body from its source file, reads the traces and persists an ad-hoc run', async () => {
      const before = project.agent.invocations.length;
      const res = await runCli(project, ['run', '-t', MATRIX_CASES.toolError.name, '-a', DEMO_AGENT_KEY, '--judge-model', MOCK_JUDGE_MODEL]);
      const out = plain(res.stdout) + plain(res.stderr);
      expect(res.status).toBe(0);
      expect(out).toMatch(/PASSED/);
      expect(project.agent.invocations).toHaveLength(before + 1);
      const inv = project.agent.invocations[before];
      expect(inv.prompt).toContain('[tool-error]');
      expect(inv.spanCount).toBe(DEMO_AGENT_SPANS.withToolError);
      // The ad-hoc run (no benchmark) carries the report; the body ran (the traces check is a recorded matcher).
      const search = await httpJson(`${project.baseUrl}/api/storage/runs/search`, { method: 'POST', body: { runId: inv.runId } });
      const report = (search.body.runs ?? search.body.reports ?? []).find((r: any) => r.runId === inv.runId) ?? (await findReportByRunId(project.baseUrl, inv.runId));
      expect(report).toBeTruthy();
      expect(report).toMatchObject({ passFailStatus: 'passed', runId: inv.runId, sessionId: inv.sessionId, traceId: inv.traceId, agentKey: DEMO_AGENT_KEY });
      expect(report.spans).toHaveLength(DEMO_AGENT_SPANS.withToolError);
      expect((report.matcherResults as any[]).find((m) => /to equal 4050/.test(m.description))).toMatchObject({ pass: true });
      const metrics = await httpJson(`${project.baseUrl}/api/metrics/${encodeURIComponent(inv.runId)}?sessionId=${encodeURIComponent(inv.sessionId)}`);
      expect(metrics.body).toMatchObject({ totalTokens: TOTAL_TOKENS, status: 'success', agentErrorSpans: 1 });
      const adhoc = (await httpJson(`${project.baseUrl}/api/storage/evaluation-runs?limit=50`)).body;
      const list: any[] = adhoc.evaluationRuns ?? adhoc.runs ?? [];
      const own = list.find((r) => Object.values(r.results ?? {}).some((x: any) => x.reportId === report.id));
      expect(own).toBeTruthy();
      expect(own.benchmarkId ?? null).toBeNull();
      expect(own.trigger).toBe('cli');
    }, CLI_TIMEOUT + 30_000);

    // ─── E5: report / export of the CLI-created run ──────────────────────────

    it('E5: `report -b <name> -f json --stdout` streams only JSON: the benchmark, the CLI run and every per-case report with its verdict and trace metrics', async () => {
      const res = await runCli(project, ['report', '-b', benchmarkName, '-f', 'json', '--stdout'], 60_000);
      expect(res.status).toBe(0);
      let parsed: any;
      expect(() => { parsed = JSON.parse(res.stdout); }).not.toThrow(); // stdout is the report, diagnostics are on stderr
      expect(parsed.benchmark).toMatchObject({ id: benchmarkId, name: benchmarkName, testCaseCount: MATRIX_CASE_COUNT });
      expect(parsed.runs.map((r: any) => r.id)).toContain(evalRunId);
      const exported: any[] = Object.values(parsed.reports);
      expect(exported.map((r) => r.id).sort()).toEqual([...reports.values()].filter(Boolean).map((r) => r.id).sort());
      for (const c of TRACED_CASES) {
        const r = exported.find((x) => x.id === reports.get(c.name).id);
        expect([c.name, r.passFailStatus, r.performanceMetrics?.totalTokens]).toEqual([c.name, c.verdict, TOTAL_TOKENS]);
      }
      const outage = exported.find((x) => x.id === traced('outage').id);
      expect(outage).toMatchObject({ failureStage: 'agent' });
      expect(outage.passFailStatus ?? null).toBeNull();
      expect(parsed.comparisonRows.map((x: any) => x.testCaseId).sort()).toEqual(Object.keys(evaluationRun.results).sort());
    }, 90_000);

    it('E5: `export -b <name> --stdout` prints the import-compatible JSON array of the 6 TypeScript cases, nothing else', async () => {
      const res = await runCli(project, ['export', '-b', benchmarkName, '--stdout'], 60_000);
      expect(res.status).toBe(0);
      const cases = JSON.parse(res.stdout) as any[];
      expect(Array.isArray(cases)).toBe(true);
      expect(cases.map((c) => c.name).sort()).toEqual(Object.values(MATRIX_CASES).map((c) => c.name).sort());
      for (const c of cases) {
        expect(typeof c.initialPrompt).toBe('string');
        expect(Array.isArray(c.expectedOutcomes)).toBe(true);
      }
      expect(cases.find((c) => c.name === MATRIX_CASES.ok.name).initialPrompt).toBe('How long do refunds take to post?');
      expect(cases.find((c) => c.name === MATRIX_CASES.outage.name).initialPrompt).toContain('[agent-500]');
    }, 90_000);

    // ─── E2: the same benchmark name again (after E4/E5, which read the pristine benchmark) ──

    it('E2: `-f <same file> -n <existing>` is a second run of the benchmark on the already-running server (no refusal)', async () => {
      const again = await runCli(project, ['benchmark', '-f', `./${EVAL_FILE_RELATIVE}`, '-a', DEMO_AGENT_KEY, '-n', benchmarkName, '--judge-model', MOCK_JUDGE_MODEL]);
      const out = plain(again.stdout) + plain(again.stderr);
      expect(out).toMatch(/Connected to existing server/);
      expect(out).not.toMatch(/not the source of/i);
      expect(out).toMatch(new RegExp(`Passed:\\s+${MATRIX_VERDICT_COUNTS.passed}\\b`));
      expect(out).toMatch(new RegExp(`Failed:\\s+${MATRIX_VERDICT_COUNTS.failed}\\b`));
      expect(out).toMatch(new RegExp(`Errored:\\s+${MATRIX_VERDICT_COUNTS.errored}\\b`));
      expect(again.status).toBe(1);
      const m = RUN_URL.exec(plain(again.stdout));
      expect(m?.[1]).toBe(benchmarkId);
      expect(m?.[2]).not.toBe(evalRunId);
      const runs = await runsOfBenchmark(project.baseUrl, benchmarkId);
      expect(runs.map((r) => r.id).sort()).toEqual([evalRunId, m![2]].sort());
      const bm = await httpJson(`${project.baseUrl}/api/storage/benchmarks/${benchmarkId}`);
      expect((bm.body.benchmark ?? bm.body).testCaseIds).toHaveLength(MATRIX_CASE_COUNT);
      // The second run re-executed all six cases with the same verdict split, and its spans are in the source too.
      const { run: secondRun, reports: second } = await loadRun(project.baseUrl, m![2]);
      expect(Object.keys(secondRun.results)).toHaveLength(MATRIX_CASE_COUNT);
      for (const c of Object.values(MATRIX_CASES)) {
        const r = second.get(c.name);
        expect([c.name, c.verdict === 'errored' ? (r.failureStage === 'agent' ? 'errored' : r.passFailStatus) : r.passFailStatus]).toEqual([c.name, c.verdict]);
      }
      expect(second.get(MATRIX_CASES.ok.name).spans).toHaveLength(DEMO_AGENT_SPANS.normal);
      expect(project.sink.size()).toBe(2 * SPANS_PER_RUN + DEMO_AGENT_SPANS.withToolError); // two full runs + the E4 run
    }, CLI_TIMEOUT + 30_000);

    it('E2: `-f <other file> -n <existing>` is refused — exit 1, both files named, no run, benchmark untouched (#620)', async () => {
      const invocationsBefore = project.agent.invocations.length;
      const refused = await runCli(project, ['benchmark', '-f', `./${OTHER_EVAL_FILE_RELATIVE}`, '-a', DEMO_AGENT_KEY, '-n', benchmarkName, '--judge-model', MOCK_JUDGE_MODEL]);
      const out = plain(refused.stdout) + plain(refused.stderr);
      expect(refused.status).toBe(1);
      expect(out).toContain('other.eval.ts');
      expect(out).toContain('retrieval.eval.ts');
      expect(out).toMatch(/--force/);
      expect(RUN_URL.test(out)).toBe(false);
      expect(await runsOfBenchmark(project.baseUrl, benchmarkId)).toHaveLength(2);
      const bm = await httpJson(`${project.baseUrl}/api/storage/benchmarks/${benchmarkId}`);
      expect((bm.body.benchmark ?? bm.body).testCaseIds).toHaveLength(MATRIX_CASE_COUNT);
      expect(project.agent.invocations).toHaveLength(invocationsBefore); // the agent was never called
    }, CLI_TIMEOUT + 30_000);

    it('E2: `--force` adds the other file\'s case to the benchmark, says so, and the run completes (exit 0: one passing case)', async () => {
      const forced = await runCli(project, ['benchmark', '-f', `./${OTHER_EVAL_FILE_RELATIVE}`, '-a', DEMO_AGENT_KEY, '-n', benchmarkName, '--judge-model', MOCK_JUDGE_MODEL, '--force']);
      const out = plain(forced.stdout) + plain(forced.stderr);
      expect(forced.status).toBe(0);
      expect(out).toMatch(/Added 1 test case/);
      expect(out).toContain(OTHER_CASE_NAME);
      expect(out).toMatch(/Passed:\s+1\b/);
      const runs = await runsOfBenchmark(project.baseUrl, benchmarkId);
      expect(runs).toHaveLength(3);
      const bm = await httpJson(`${project.baseUrl}/api/storage/benchmarks/${benchmarkId}`);
      // The benchmark's current version holds both files' cases (what the source guard reads: currentBenchmarkTestCaseIds).
      expect(currentBenchmarkTestCaseIds(bm.body.benchmark ?? bm.body)).toHaveLength(MATRIX_CASE_COUNT + 1);
      expect((bm.body.benchmark ?? bm.body).description).toMatch(/other\.eval\.ts added with --force/);
      const m = RUN_URL.exec(plain(forced.stdout))!;
      const { reports: forcedReports } = await loadRun(project.baseUrl, m[2]);
      expect(forcedReports.get(OTHER_CASE_NAME)).toMatchObject({ passFailStatus: 'passed' });
      expect(forcedReports.get(OTHER_CASE_NAME).spans).toHaveLength(DEMO_AGENT_SPANS.normal);
    }, CLI_TIMEOUT + 30_000);

  });
}

async function findReportByRunId(baseUrl: string, runId: string): Promise<any | null> {
  // Fallback: walk the recent ad-hoc runs' reports.
  const list = (await httpJson(`${baseUrl}/api/storage/evaluation-runs?limit=50`)).body;
  for (const run of (list.evaluationRuns ?? list.runs ?? []) as any[]) {
    for (const result of Object.values(run.results ?? {}) as any[]) {
      if (!result.reportId) continue;
      const rep = await httpJson(`${baseUrl}/api/storage/runs/${encodeURIComponent(result.reportId)}`);
      const report = rep.body.report ?? rep.body.run ?? rep.body;
      if (report?.runId === runId) return report;
    }
  }
  return null;
}
