/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `agent-health run`, `export`, `report` and `list` — the read/inspect side of
 * the CLI, driven as REAL processes against a running backend.
 *
 * One benchmark (3 classic cases) is created through the CLI's own unified
 * benchmark mode with the built-in `demo` agent + mock `demo-model` judge;
 * every command below is then asserted on what the user sees (exit code,
 * table / JSON / markdown output, files written) and on the documents the
 * server holds. No credentials or network beyond localhost.
 */

import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestBackendUrl } from '../testConfig';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import {
  ensureCliBundle,
  backendReadyOrSkip,
  runCli,
  plain,
  makeTempDir,
  writeCasesFile,
  trackBenchmarkByName,
  trackTestCasesByName,
  listEvaluationRunsOf,
  httpJson,
  jsonTail,
  type CliResult,
} from '../../helpers/cliProcess';

const TEST_TIMEOUT = 180_000;
const BASE_URL = getTestBackendUrl();
const JUDGE = ['--judge-model', 'demo-model'];


describe('CLI run / export / report / list (real CLI processes)', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let tmp: string;
  let benchmarkName: string;
  let benchmarkId: string;
  let caseNames: string[];
  let caseIds: Map<string, string>;
  let runIds: string[] = [];

  beforeAll(async () => {
    ready = await backendReadyOrSkip('cli-inspect', BASE_URL);
    if (!ready) return;
    ensureCliBundle();
    tmp = makeTempDir('ah-cli-inspect');
    caseNames = [...writeCasesFile(tmp, 'a.json', 2, 'cli-inspect-a'), ...writeCasesFile(tmp, 'b.json', 1, 'cli-inspect-b')];
    benchmarkName = uniqueTestName('cli-inspect-bm');
    const seed = runCli(['benchmark', '-f', join(tmp, 'a.json'), '-f', join(tmp, 'b.json'), '-a', 'demo', '-n', benchmarkName, ...JUDGE], { timeoutMs: 150_000 });
    const bm = await trackBenchmarkByName(tracker, benchmarkName);
    if (seed.status !== 0 || !bm) throw new Error(`seed benchmark failed (exit ${seed.status}):\n${seed.output}`);
    benchmarkId = bm.id;
    caseIds = await trackTestCasesByName(tracker, caseNames);
    runIds = (await listEvaluationRunsOf(benchmarkId)).map(r => r.id);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await tracker.cleanup();
  }, 120_000);

  it('requires a running backend (skip otherwise)', () => {
    if (!ready) return;
    expect(benchmarkId).toBeTruthy();
    expect(caseIds.size).toBe(3);
  });

  describe('run', () => {
    async function trackReportsOfCase(testCaseId: string): Promise<void> {
      const res = await httpJson<{ runs?: Array<{ id: string }> }>(`${BASE_URL}/api/storage/runs/search`, { method: 'POST', body: { testCaseId } });
      for (const r of res.body.runs ?? []) tracker.run(r.id);
    }

    it('run -t <name> -a demo prints a PASSED row with accuracy, steps and the report id', async () => {
      if (!ready) return;
      const name = caseNames[0];
      const res = runCli(['run', '-t', name, '-a', 'demo', ...JUDGE]);
      await trackReportsOfCase(caseIds.get(name)!);
      const out = plain(res.output);
      expect(res.status).toBe(0);
      expect(out).toContain(`Test Case: ${name} (${caseIds.get(name)})`);
      expect(out).toMatch(/Demo Agent: PASSED/);
      expect(out).toMatch(/│ Agent\s+│ Status\s+│ Accuracy\s+│ Steps\s+│ Report ID/);
      expect(out).toMatch(/│ Demo Agent\s+│ PASSED\s+│ \d+%\s+│ \d+\s+│ report-/);
    }, TEST_TIMEOUT);

    it('run -t <id> -o json emits the agent/report structure; -o markdown renders the row as a table', async () => {
      if (!ready) return;
      const name = caseNames[1];
      const id = caseIds.get(name)!;
      const res = runCli(['run', '-t', id, '-a', 'demo', '-o', 'json', ...JUDGE]);
      await trackReportsOfCase(id);
      expect(res.status).toBe(0);
      const parsed = jsonTail(res.stdout) as Array<{ agent: { key: string }; report: { id: string; status: string; passFailStatus: string; trajectorySteps: number } }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0].agent.key).toBe('demo');
      expect(parsed[0].report.status).toBe('completed');
      expect(parsed[0].report.passFailStatus).toBe('passed');
      expect(parsed[0].report.trajectorySteps).toBeGreaterThan(0);
      // The report exists server-side under that id.
      const stored = await httpJson(`${BASE_URL}/api/storage/runs/${encodeURIComponent(parsed[0].report.id)}`);
      expect(stored.ok).toBe(true);

      // -v only changes the spinner text while running; the final markdown
      // table is the stable, assertable surface.
      const md = runCli(['run', '-t', id, '-a', 'demo', '-v', '-o', 'markdown', ...JUDGE]);
      await trackReportsOfCase(id);
      expect(md.status).toBe(0);
      expect(plain(md.stdout)).toMatch(/^\| Agent \| Status \| Accuracy \| Steps \| Report ID \|/m);
      expect(plain(md.stdout)).toMatch(/^\| Demo Agent \| PASSED \| \d+% \| \d+ \| report-/m);
    }, TEST_TIMEOUT);

    it('run -t <unknown> exits 1 and points at `list test-cases`', () => {
      if (!ready) return;
      const res = runCli(['run', '-t', uniqueTestName('cli-inspect-missing-case'), '-a', 'demo']);
      const out = plain(res.output);
      expect(res.status).toBe(1);
      expect(out).toMatch(/Test case not found/);
      expect(out).toMatch(/list test-cases/);
    }, TEST_TIMEOUT);

    it('run -a <unknown agent> exits 1 naming the agent', () => {
      if (!ready) return;
      const res = runCli(['run', '-t', caseNames[0], '-a', 'no-such-agent-key', ...JUDGE]);
      expect(res.status).toBe(1);
      expect(plain(res.output)).toMatch(/no-such-agent-key/);
    }, TEST_TIMEOUT);
  });

  describe('export', () => {
    it('export -b <name> -o <file> writes import-compatible JSON for every test case', () => {
      if (!ready) return;
      const outFile = join(tmp, 'export.json');
      const res = runCli(['export', '-b', benchmarkName, '-o', outFile]);
      const out = plain(res.output);
      expect(res.status).toBe(0);
      expect(out).toContain(`Exported 3 test case(s) to ${outFile}`);
      expect(out).toContain(`Benchmark: ${benchmarkName} (${benchmarkId})`);
      const exported = JSON.parse(readFileSync(outFile, 'utf-8')) as Array<{ name: string; initialPrompt: string; expectedOutcomes: string[] }>;
      expect(exported.map(c => c.name).sort()).toEqual([...caseNames].sort());
      expect(exported.every(c => c.initialPrompt && c.expectedOutcomes.length > 0)).toBe(true);
    }, TEST_TIMEOUT);

    it('export -b <id> --stdout prints only the JSON array on stdout', () => {
      if (!ready) return;
      const res = runCli(['export', '-b', benchmarkId, '--stdout']);
      expect(res.status).toBe(0);
      const parsed = jsonTail(res.stdout) as Array<{ name: string }>;
      expect(parsed).toHaveLength(3);
      expect(parsed.map(c => c.name).sort()).toEqual([...caseNames].sort());
    }, TEST_TIMEOUT);

    it('export -b <unknown> exits 1 with "Benchmark not found"', () => {
      if (!ready) return;
      const res = runCli(['export', '-b', uniqueTestName('cli-inspect-no-bm')]);
      expect(res.status).toBe(1);
      expect(plain(res.output)).toMatch(/Benchmark not found/);
    }, TEST_TIMEOUT);
  });

  describe('report', () => {
    it('report -b <name> -f json --stdout streams the JSON report with the run', () => {
      if (!ready) return;
      const res = runCli(['report', '-b', benchmarkName, '-f', 'json', '--stdout']);
      expect(res.status).toBe(0);
      const report = jsonTail(res.stdout) as { benchmark: { id: string; name: string; testCaseCount: number }; runs: unknown[] };
      expect(report.benchmark).toMatchObject({ id: benchmarkId, name: benchmarkName, testCaseCount: 3 });
      expect(Array.isArray(report.runs)).toBe(true);
    }, TEST_TIMEOUT);

    it('report -b <id> -f html -o <file> -r <runId> writes an HTML document', () => {
      if (!ready) return;
      const outFile = join(tmp, 'report.html');
      const args = ['report', '-b', benchmarkId, '-f', 'html', '-o', outFile];
      if (runIds.length > 0) args.push('-r', runIds.join(','));
      const res = runCli(args);
      const out = plain(res.output);
      expect(res.status).toBe(0);
      expect(out).toContain(`Found benchmark: ${benchmarkName} (${benchmarkId})`);
      expect(out).toContain(`Report saved to: ${outFile}`);
      expect(existsSync(outFile)).toBe(true);
      const html = readFileSync(outFile, 'utf-8');
      expect(html).toMatch(/<html/i);
      expect(html).toContain(benchmarkName);
    }, TEST_TIMEOUT);

    it('report -b <unknown> exits 1 and suggests `list benchmarks`', () => {
      if (!ready) return;
      const res = runCli(['report', '-b', uniqueTestName('cli-inspect-no-bm')]);
      const out = plain(res.output);
      expect(res.status).toBe(1);
      expect(out).toMatch(/Benchmark not found/);
      expect(out).toMatch(/list benchmarks/);
    }, TEST_TIMEOUT);
  });

  describe('list', () => {
    const asJson = (res: CliResult) => jsonTail(res.stdout) as { data: unknown[]; meta?: unknown } | unknown[];

    it('list test-cases: table shows the seeded names; json and markdown carry the same rows', () => {
      if (!ready) return;
      const table = runCli(['list', 'test-cases']);
      expect(table.status).toBe(0);
      const tableOut = plain(table.stdout);
      expect(tableOut).toMatch(/Available Test Cases|Test Cases/);
      for (const n of caseNames) expect(tableOut).toContain(n.slice(0, 20));

      const json = runCli(['list', 'test-cases', '-o', 'json']);
      expect(json.status).toBe(0);
      const parsed = asJson(json) as { data: Array<{ name: string; id: string }> };
      const names = new Set(parsed.data.map(tc => tc.name));
      for (const n of caseNames) expect(names.has(n)).toBe(true);

      const md = runCli(['list', 'test-cases', '-o', 'markdown']);
      expect(md.status).toBe(0);
      expect(plain(md.stdout)).toMatch(/^\| ID \| Name \|/m);
      expect(md.stdout).toContain(caseIds.get(caseNames[0])!);
    }, TEST_TIMEOUT);

    it('list benchmarks: the seeded benchmark appears with its test-case count', () => {
      if (!ready) return;
      const table = runCli(['list', 'benchmarks']);
      expect(table.status).toBe(0);
      expect(plain(table.stdout)).toContain(benchmarkName.slice(0, 20));

      const json = runCli(['list', 'benchmarks', '-o', 'json']);
      expect(json.status).toBe(0);
      const parsed = asJson(json) as { data: Array<{ id: string; name: string; testCaseIds: string[] }> };
      const mine = parsed.data.find(b => b.id === benchmarkId);
      expect(mine).toBeDefined();
      expect(mine!.testCaseIds).toHaveLength(3);
    }, TEST_TIMEOUT);

    it('list agents / models / evaluators / connectors / images render in table and json', () => {
      if (!ready) return;
      const agents = runCli(['list', 'agents']);
      expect(agents.status).toBe(0);
      expect(plain(agents.stdout)).toMatch(/│ demo\s+│ Demo Agent/);
      const agentsJson = asJson(runCli(['list', 'agents', '-o', 'json'])) as Array<{ key: string }>;
      expect(agentsJson.some(a => a.key === 'demo')).toBe(true);

      const models = runCli(['list', 'models']);
      expect(models.status).toBe(0);
      expect(plain(models.stdout)).toMatch(/│ demo-model\s+│ Demo Model\s+│ demo/);
      const modelsJson = asJson(runCli(['list', 'models', '-o', 'json'])) as Array<{ key: string }> | { data: Array<{ key: string }> };
      const modelRows = Array.isArray(modelsJson) ? modelsJson : modelsJson.data;
      expect(modelRows.some(m => m.key === 'demo-model')).toBe(true);

      const evaluators = runCli(['list', 'evaluators']);
      expect(evaluators.status).toBe(0);
      expect(plain(evaluators.stdout)).toMatch(/system-rca-default/);
      const evaluatorsJson = runCli(['list', 'evaluators', '-o', 'json']);
      expect(evaluatorsJson.status).toBe(0);
      expect(JSON.stringify(asJson(evaluatorsJson))).toContain('system-rca-default');

      const connectors = runCli(['list', 'connectors', '-o', 'markdown']);
      expect(connectors.status).toBe(0);
      expect(plain(connectors.stdout)).toMatch(/\| mock \|/);

      const images = runCli(['list', 'images']);
      expect(images.status).toBe(0);
      expect(plain(images.stdout)).toMatch(/Benchmark Images|No benchmark images/);
      const imagesJson = runCli(['list', 'images', '-o', 'json']);
      expect(imagesJson.status).toBe(0);
      expect(() => asJson(imagesJson)).not.toThrow();
    }, TEST_TIMEOUT);

    it('list <unknown resource> exits 1 and lists the valid resources', () => {
      if (!ready) return;
      const res = runCli(['list', 'widgets']);
      const out = plain(res.output);
      expect(res.status).toBe(1);
      expect(out).toMatch(/Unknown resource type: widgets/);
      expect(out).toMatch(/agents, test-cases, benchmarks, images, evaluators, connectors, models/);
    }, TEST_TIMEOUT);
  });
});
