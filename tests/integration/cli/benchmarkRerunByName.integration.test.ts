/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #612 step 3b — `agent-health benchmark -n <existing>` (re-run of a STORED
 * benchmark, no `-f`) executes in the CLI process like every other mode.
 *
 * Before: this mode alone still POSTed to the server's legacy
 * `/api/storage/benchmarks/:id/execute`, which requires OpenSearch storage —
 * on FILE storage the CLI printed `Failed - … OpenSearch not configured` and
 * exited 1 (red on main: every assertion below fails there).
 *
 * Real everything, under `withCliCoverage()`: the real CLI bundle, a real
 * `agent-health serve` child on FILE storage started from a throw-away project,
 * a real REST agent whose spans land in a real trace backend —
 *   • a local CloudWatch Logs stub (the #640 setup; tests/helpers/cloudWatchLogsStub.ts), and
 *   • a REAL OpenSearch cluster (the CI service container / `TEST_OPENSEARCH_ENDPOINT`,
 *     tests/helpers/rawOpenSearchCluster.ts convention; skipped when none is opted in)
 * — and a `.eval.ts` suite whose bodies read `traces` DURING the run.
 *
 * Flow per backend: `benchmark -f evals/retrieval.eval.ts -n <name>` imports
 * the suite (the stored cases carry the relative `sourceFile`), then the run
 * under test: `benchmark -n <name> -a <agent> -o json --export <file>` from the
 * project directory — no file given. Asserts: exit code + summary, the run's
 * source is the stored benchmark (not a file), its SDK bodies ran from the
 * stored `sourceFile`, the per-case reports exist and their traces are found
 * through `/api/traces`, the run is linked into the benchmark, the export is
 * the legacy shape, and the server executed nothing itself.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCliCoverage } from '../../helpers/cliCoverage';
import {
  createFileStorageCloudWatchProject,
  httpJson,
  CLI_BUNDLE,
  DEMO_AGENT_KEY,
  DEMO_AGENT_SERVICE_NAME,
  type FileStorageCloudWatchProject,
} from '../../helpers/fileStorageCloudWatchProject';
import { DEMO_AGENT_SPANS, DEMO_AGENT_TOKENS } from '../../helpers/demoRetrievalAgentStub';
import { resolveRawOpenSearchEndpoint, rawOpenSearchOptInHint } from '../../helpers/rawOpenSearchCluster';
import { uniqueTestName } from '../../helpers/testDataTracker';

const SUITE_TIMEOUT = 240_000;
const TOTAL_TOKENS = DEMO_AGENT_TOKENS.input + DEMO_AGENT_TOKENS.output;

/** The suite under test, as TypeScript (`.eval.ts` is transpiled by the loader; runs from anywhere on disk). */
const EVAL_FILE = 'evals/retrieval.eval.ts';
const EVAL_TS_SOURCE = `import { test, expect } from '@opensearch-project/agent-health';

type Answer = { agentOutput: string };

// Deterministic checks only — no LLM judge. \`traces\` is read from the configured
// observability backend DURING the run, so a passing body proves the traces were found.
test('answers from the knowledge base', { prompt: 'How long do refunds take to post?' }, async ({ agent, traces }) => {
  const result: Answer = await agent.run();
  expect(result.agentOutput).to.include('Billing FAQ');
  expect(traces.totalTokens).to.equal(${TOTAL_TOKENS});
});

test('a failed tool attempt is retried', { prompt: '[tool-error] Which plans include priority support?' }, async ({ agent, traces }) => {
  const result: Answer = await agent.run();
  expect(result.agentOutput).to.include('Billing FAQ');
  expect(traces.totalTokens).to.equal(${TOTAL_TOKENS});
});

test('flags an answer without a citation', { prompt: '[no-answer] Can I pay by invoice?' }, async ({ agent }) => {
  const result: Answer = await agent.run();
  expect(result.agentOutput).to.include('Billing FAQ');
});
`;
const CASE_NAMES = ['answers from the knowledge base', 'a failed tool attempt is retried', 'flags an answer without a citation'];

function runCli(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; out: string }>((resolve) => {
    // Async spawn: the agent + trace stubs live in THIS process; a blocked event loop would never answer.
    const child = spawn(process.execPath, [CLI_BUNDLE, ...args], { cwd, env: withCliCoverage(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ status: signal ? null : code, stdout, stderr, out: plain(stdout + stderr) }); });
  });
}
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

const openSearchEndpoint = resolveRawOpenSearchEndpoint();
if (!openSearchEndpoint) console.warn(rawOpenSearchOptInHint('benchmark -n re-run with OpenSearch traces'));

type Backend = { label: string; traces: 'cloudwatch' | { opensearchEndpoint: string } };
const BACKENDS: Backend[] = [
  { label: 'CloudWatch (local Logs stub)', traces: 'cloudwatch' },
  ...(openSearchEndpoint ? [{ label: `OpenSearch (${openSearchEndpoint})`, traces: { opensearchEndpoint: openSearchEndpoint } } as Backend] : []),
];

describe.each(BACKENDS)('benchmark -n <existing> re-runs the STORED benchmark in the CLI process on FILE storage — traces in $label (#612 step 3b)', ({ traces }) => {
  let project: FileStorageCloudWatchProject;
  let importInvocations = 0;
  const benchmarkName = uniqueTestName('rerun-by-name');
  let benchmarkId = '';
  let importRunId = '';
  let rerun: Awaited<ReturnType<typeof runCli>>;
  let runDoc: any;
  let exportPath: string;

  beforeAll(async () => {
    if (!existsSync(CLI_BUNDLE)) throw new Error(`${CLI_BUNDLE} missing — npm run build:cli`);
    project = await createFileStorageCloudWatchProject({ prefix: 'ah-rerun-by-name', traces, evalSource: EVAL_TS_SOURCE, evalFile: EVAL_FILE });
    await project.startServer('cli');

    // 1. Import the suite under a benchmark name (unified code-import path, already local).
    const imported = await runCli(['benchmark', '-f', EVAL_FILE, '-a', DEMO_AGENT_KEY, '-n', benchmarkName], project.dir, project.env, 120_000);
    expect(imported.status).toBe(0);
    expect(imported.out).toMatch(/Evaluation run completed \(3\/3 test cases\)/);
    const list = await httpJson<any>(`${project.baseUrl}/api/storage/benchmarks?size=100`);
    const bench = (list.body.benchmarks ?? []).find((b: any) => b.name === benchmarkName);
    expect(bench).toBeTruthy();
    benchmarkId = bench.id;
    importRunId = /eval-run-[0-9]+-[a-z0-9]+/.exec(imported.out)![0];
    expect(project.agent.invocations).toHaveLength(3);
    importInvocations = project.agent.invocations.length;

    // 2. THE RUN UNDER TEST: re-run by name, no file, from the project dir.
    exportPath = join(project.dir, 'rerun-export.json');
    rerun = await runCli(['benchmark', '-n', benchmarkName, '-a', DEMO_AGENT_KEY, '-o', 'json', '--export', exportPath], project.dir, project.env, 120_000);
    // Red on main: `Demo Retrieval Agent: Failed - … OpenSearch not configured. Cannot execute benchmarks in sample-only mode.`
    expect(rerun.out).not.toMatch(/OpenSearch not configured/);
    const runIds = [...new Set([...rerun.out.matchAll(/eval-run-[0-9]+-[a-z0-9]+/g)].map((m) => m[0]))].filter((id) => id !== importRunId);
    expect(runIds).toHaveLength(1);
    const res = await httpJson<any>(`${project.baseUrl}/api/storage/evaluation-runs/${runIds[0]}`);
    runDoc = res.body.evaluationRun ?? res.body;
  }, SUITE_TIMEOUT);

  afterAll(async () => {
    await project?.cleanup();
  }, 60_000);

  it('completes in the CLI process: exit 0 (a FAILED verdict is data), 2/3 passed in the summary, the run executed by executor.kind=cli', () => {
    expect(rerun.status).toBe(0);
    expect(rerun.out).not.toMatch(/OpenSearch not configured/);
    expect(rerun.out).toMatch(/Demo Retrieval Agent: 2\/3 passed \(67% pass rate\)/);
    expect(runDoc).toMatchObject({ status: 'completed', trigger: 'cli', benchmarkId, executor: { kind: 'cli' } });
    expect(runDoc.stats).toMatchObject({ passed: 2, failed: 1, errored: 0, total: 3 });
  });

  it('uses the STORED test cases as its source (type benchmark, not a file) and re-materialises their SDK bodies from the stored sourceFile', async () => {
    expect(runDoc.sources).toEqual([{ type: 'benchmark', benchmarkId }]);
    const bench = (await httpJson<any>(`${project.baseUrl}/api/storage/benchmarks/${benchmarkId}`)).body;
    expect(runDoc.testCaseSnapshots.map((s: any) => s.id).sort()).toEqual([...bench.testCaseIds].sort());
    // Every case still has exactly one stored document — the re-run imported nothing.
    const cases = await httpJson<any>(`${project.baseUrl}/api/storage/test-cases?includeSample=false`);
    for (const name of CASE_NAMES) {
      const stored = (cases.body.testCases ?? []).filter((tc: any) => tc.name === name);
      expect(stored).toHaveLength(1);
      expect(stored[0].sourceFile).toBe(EVAL_FILE);
    }
    // The bodies ran: the chai matchers of each case are on its report.
    for (const [caseId, entry] of Object.entries<any>(runDoc.results)) {
      const report = (await httpJson<any>(`${project.baseUrl}/api/storage/runs/${entry.reportId}`)).body;
      const rep = report.run ?? report;
      expect(rep.testCaseId).toBe(caseId);
      expect(Array.isArray(rep.matcherResults)).toBe(true);
      expect(rep.matcherResults.some((m: any) => /Billing FAQ/.test(m.description))).toBe(true);
    }
  });

  it('its traces were found during the run (the `traces.totalTokens` matcher passed) and are found again through /api/traces for each report', async () => {
    const byName = new Map<string, any>();
    for (const entry of Object.values<any>(runDoc.results)) {
      const report = (await httpJson<any>(`${project.baseUrl}/api/storage/runs/${entry.reportId}`)).body;
      const rep = report.run ?? report;
      byName.set(runDoc.testCaseSnapshots.find((s: any) => s.id === rep.testCaseId).name, rep);
    }
    for (const name of CASE_NAMES.slice(0, 2)) {
      const rep = byName.get(name);
      const tokens = rep.matcherResults.filter((m: any) => String(m.description).includes(String(TOTAL_TOKENS)));
      expect(tokens.map((m: any) => m.description)).toHaveLength(1);
      expect(tokens[0].pass).toBe(true);
    }
    expect(byName.get(CASE_NAMES[2]).passFailStatus).toBe('failed');
    expect(byName.get(CASE_NAMES[2]).matcherResults.some((m: any) => m.pass === false)).toBe(true);
    // Each report's run id correlates to the agent's spans in the trace backend.
    const rerunInvocations = project.agent.invocations.slice(importInvocations);
    expect(rerunInvocations).toHaveLength(3);
    for (const inv of rerunInvocations) {
      const res = await httpJson<any>(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 100, runIds: [inv.runId] } });
      expect(res.status).toBe(200);
      const expected = inv.prompt.includes('[tool-error]') ? DEMO_AGENT_SPANS.withToolError : DEMO_AGENT_SPANS.normal;
      expect(res.body.spans).toHaveLength(expected);
      expect(res.body.spans.every((s: any) => s.traceId === inv.traceId)).toBe(true);
      expect(res.body.spans.some((s: any) => (s.attributes?.['service.name'] ?? s.attributes?.serviceName ?? s.serviceName) === DEMO_AGENT_SERVICE_NAME)).toBe(true);
    }
    const reportRunIds = [...byName.values()].map((r) => r.runId).sort();
    expect(reportRunIds).toEqual(rerunInvocations.map((i) => i.runId).sort());
  });

  it('is linked into the benchmark next to the import run; the --export file keeps the legacy shape; -o json prints the per-agent summary', async () => {
    const bench = (await httpJson<any>(`${project.baseUrl}/api/storage/benchmarks/${benchmarkId}`)).body;
    expect(bench.runs.map((r: any) => r.id).sort()).toEqual([importRunId, runDoc.id].sort());
    const exported = JSON.parse(readFileSync(exportPath, 'utf-8'));
    expect(Object.keys(exported).sort()).toEqual(['benchmark', 'exportedAt', 'runs']);
    expect(exported.benchmark).toEqual({ id: benchmarkId, name: benchmarkName, testCaseCount: 3 });
    expect(exported.runs).toHaveLength(1);
    expect(Object.keys(exported.runs[0]).sort()).toEqual(['agent', 'errored', 'executionErrors', 'failed', 'notRun', 'passRate', 'passRateJudged', 'passed', 'pending', 'reports', 'results', 'runId', 'status', 'total']);
    expect(exported.runs[0]).toMatchObject({ agent: { key: DEMO_AGENT_KEY }, runId: runDoc.id, status: 'completed', passed: 2, failed: 1, errored: 0, total: 3 });
    expect(exported.runs[0].passRate).toBeCloseTo(66.67, 1); // passed / planned total, the legacy formula (unrounded in the export)
    expect(exported.runs[0].reports).toHaveLength(3);
    // -o json: the same per-agent summary on stdout.
    expect(rerun.stdout).toContain(`"runId": "${runDoc.id}"`);
    expect(rerun.stdout).toMatch(/"passed": 2,\s*"failed": 1,/);
  });

  it('the server executed nothing: no runner activity in its log, the legacy /execute route was never used', async () => {
    const health = await httpJson<any>(`${project.baseUrl}/health`);
    expect(health.body.instance.pid).toBe(project.serverPid);
    const inFlight = await httpJson<any>(`${project.baseUrl}/api/runs/in-flight`);
    expect(inFlight.body.count).toBe(0);
    // Every run the benchmark holds was leased to a CLI executor.
    for (const id of [importRunId, runDoc.id]) {
      const doc = (await httpJson<any>(`${project.baseUrl}/api/storage/evaluation-runs/${id}`)).body;
      expect((doc.evaluationRun ?? doc).executor.kind).toBe('cli');
    }
  });
});
