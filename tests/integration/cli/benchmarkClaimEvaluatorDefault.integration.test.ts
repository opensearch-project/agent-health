/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #619 — `agent-health benchmark -f x.eval.js` with NO `-e`: an inline
 * `judge(result, claim)` is judged by the neutral built-in `system-claim`
 * evaluator, not the RCA default; an explicit `-e` is unchanged.
 *
 * Drives the REAL CLI bundle as a child process against the backend the test
 * config points at (file storage in the integration job), with the built-in
 * `demo` agent and the mock judge so no credentials are needed. The mock
 * judge still goes through `/api/judge`'s evaluator resolution and freezes a
 * `scoringSnapshot` naming the evaluator that was applied — that snapshot on
 * the persisted matcherResult is the assertion.
 *
 * Red on the old code: the SDK omitted `evaluatorId`, the server applied
 * `system-rca-default`, and the snapshot read `system-rca-default`.
 */

import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import {
  backendReadyOrSkip,
  ensureCliBundle,
  getEvaluationRun,
  httpJson,
  makeTempDir,
  plain,
  runCli,
  trackBenchmarkByName,
} from '../../helpers/cliProcess';

const BASE_URL = getTestBackendUrl();
const SUITE_TIMEOUT = 150_000;

const FIXTURE = `
const { test, expect } = require('@opensearch-project/agent-health');

test('claim-evaluator-default', {
  description: 'CLI subprocess: judge() with no -e uses the neutral claim evaluator',
  labels: ['category:Smoke', 'feature:sdk-claim-evaluator'],
  timeout: 30_000,
}, async function ({ judge }) {
  const fakeResult = {
    trajectory: [
      { type: 'action', toolName: 'search_catalog', content: '{"q":"running shoes under $100"}' },
      { type: 'response', content: 'Three running shoes: Trail Runner ($79), Road Flyer ($89), Sprint Lite ($95).' },
    ],
  };
  await judge(fakeResult, 'Every retrieved item is a running shoe priced under $100.');
  expect(true, 'reached completion').to.equal(true);
});
`;

async function runBenchmarkAndReadReport(
  fixturePath: string,
  extraArgs: string[],
  tracker: ReturnType<typeof createTestDataTracker>,
): Promise<{ report: any; stdout: string }> {
  const benchmarkName = uniqueTestName('cli-claim-evaluator');
  const cli = runCli(
    ['benchmark', '-f', fixturePath, '-a', 'demo', '--judge-model', 'demo-model', '-n', benchmarkName, ...extraArgs],
    { timeoutMs: 100_000 },
  );
  await trackBenchmarkByName(tracker, benchmarkName, BASE_URL);
  if (cli.status === null) throw new Error(`CLI timed out\n${cli.output}`);
  const stdout = plain(cli.stdout);
  const m = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/.exec(stdout);
  if (!m) throw new Error(`Could not parse benchmark/run from CLI output (exit ${cli.status}):\n${cli.output}`);
  const run = await getEvaluationRun(m[2], BASE_URL);
  if (!run) throw new Error(`evaluation run ${m[2]} not found`);
  const entries = Object.values(run.results ?? {});
  if (entries.length !== 1 || !entries[0].reportId) throw new Error(`expected one report, got ${JSON.stringify(run.results)}`);
  tracker.run(entries[0].reportId);
  const reportRes = await httpJson<any>(`${BASE_URL}/api/storage/runs/${entries[0].reportId}`);
  if (!reportRes.ok) throw new Error(`GET report failed: ${reportRes.status}`);
  return { report: reportRes.body, stdout };
}

describe('CLI: SDK judge() without -e uses the neutral system-claim evaluator (#619)', () => {
  let ready = false;
  let tempDir: string;
  let fixturePath: string;
  const tracker = createTestDataTracker();

  beforeAll(async () => {
    ready = await backendReadyOrSkip('cli-claim-evaluator', BASE_URL);
    if (!ready) return;
    ensureCliBundle();
    tempDir = makeTempDir('cli-claim-evaluator');
    fixturePath = join(tempDir, 'claim.eval.js');
    writeFileSync(fixturePath, FIXTURE, 'utf-8');
  }, SUITE_TIMEOUT);

  afterAll(async () => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    await tracker.cleanup();
  });

  it('no -e → the judge matcher is frozen with scoringSnapshot.evaluatorId = system-claim (never system-rca-default)', async () => {
    if (!ready) return;
    const { report } = await runBenchmarkAndReadReport(fixturePath, [], tracker);
    const judged = (report.matcherResults ?? []).filter((r: any) => r.method === 'llm-judge');
    expect(judged).toHaveLength(1);
    expect(judged[0].scoringSnapshot).toMatchObject({ evaluatorId: 'system-claim', evaluatorName: 'Claim' });
    expect(judged[0].scoringSnapshot.evaluatorId).not.toBe('system-rca-default');
    expect(judged[0].errored).not.toBe(true);
    // The run itself still records no explicit evaluator — the author chose none.
    expect(report.evaluatorId ?? undefined).toBeUndefined();
  }, SUITE_TIMEOUT);

  it('-e system-rca-default → explicit evaluator is forwarded unchanged', async () => {
    if (!ready) return;
    const { report } = await runBenchmarkAndReadReport(fixturePath, ['-e', 'system-rca-default'], tracker);
    const judged = (report.matcherResults ?? []).filter((r: any) => r.method === 'llm-judge');
    expect(judged).toHaveLength(1);
    expect(judged[0].scoringSnapshot).toMatchObject({ evaluatorId: 'system-rca-default' });
    expect(report.evaluatorId).toBe('system-rca-default');
  }, SUITE_TIMEOUT);

  it('system-claim is a listed system evaluator the user can also pick explicitly', async () => {
    if (!ready) return;
    const res = await httpJson<any>(`${BASE_URL}/api/storage/evaluators/system-claim`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'system-claim', name: 'Claim', isSystem: true });
  });
});
