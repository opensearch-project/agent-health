/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: scripts/backfill-improvement-strategies.ts against the REAL
 * backend (AH_PORT). Seeds a report the way the agentic trace judge persisted
 * them while it forced `improvementStrategies: []` (raw judge text still
 * carrying the array), runs the script scoped to a seeded evaluation run, and
 * asserts the persisted document — not just the script's own summary — now
 * carries the strategies on all three surfaces. A second pass must be a no-op.
 *
 * Also asserts the read path the run report uses (`GET /api/storage/runs/:id`)
 * returns the recovered strategies, and that dry-run leaves the doc untouched.
 */

import { execFile } from 'child_process';
import { join } from 'path';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const SCRIPT = join(__dirname, '../../../../../scripts/backfill-improvement-strategies.ts');
const TSX_CLI = require.resolve('tsx/cli');

const STRATEGIES = [
  { category: 'Payload Economy', issue: 'Too chatty', recommendation: 'Return compact records', priority: 'medium' },
  { category: 'Provenance', issue: 'Bare ids', recommendation: 'Inline the doc id per fact', priority: 'low' },
];
const RAW = '```json\n' + JSON.stringify({
  pass_fail_status: 'passed', reasoning: 'ok', improvement_strategies: STRATEGIES,
}) + '\n```';

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    return (await r.json()).status === 'ok';
  } catch {
    return false;
  }
};

function runScript(args: string[]): Promise<{ code: number; summary: any; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [TSX_CLI, SCRIPT, '--base', BASE_URL, '--json', ...args], { timeout: 120_000 }, (err, stdout, stderr) => {
      let summary: any = null;
      try { summary = JSON.parse(String(stdout)); } catch { /* leave null */ }
      resolve({ code: err ? (err as any).code ?? 1 : 0, summary, stderr: String(stderr) });
    });
  });
}

const getReport = async (id: string) => (await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`)).json();

describe('backfill-improvement-strategies (integration)', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;
  let testCaseId: string;
  let uncapturedId: string;
  let storedId: string;
  let evalRunId: string;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) return;

    const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('backfill-strategies-tc'), category: 'Test', difficulty: 'Easy',
        initialPrompt: 'p', expectedOutcomes: ['o'],
      }),
    });
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    tracker.testCase(testCaseId);

    const seedReport = async (stored: any[]) => {
      const res = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCaseId, agentKey: 'demo', agentName: 'Demo Agent', modelId: 'demo-model', modelName: 'demo-model',
          status: 'completed', passFailStatus: 'passed', metricsStatus: 'ready',
          judgeModelId: 'agent-trace-judge',
          trajectory: [{ type: 'assistant', content: 'answer' }],
          metrics: { accuracy: 90 },
          improvementStrategies: stored,
          llmJudgeResponse: {
            modelId: 'agent-trace-judge', timestamp: new Date().toISOString(),
            promptTokens: 1, completionTokens: 1, latencyMs: 1,
            rawResponse: RAW, improvementStrategies: stored,
          },
          matcherResults: [
            { description: 'true to equal true', pass: true, method: 'code-assertion' },
            { description: 'judge: 2 expected outcomes', pass: true, method: 'llm-judge', improvementStrategies: stored },
          ],
        }),
      });
      const rep = await res.json();
      const id = rep.id || rep.run?.id || rep.report?.id;
      tracker.run(id);
      return id as string;
    };
    uncapturedId = await seedReport([]);
    storedId = await seedReport([STRATEGIES[1]]);

    evalRunId = `eval-run-${uniqueTestName('backfill-strategies')}`;
    const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${evalRunId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: evalRunId, name: uniqueTestName('backfill-strategies-run'), status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'agent-trace-judge',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }], trigger: 'api', testCaseSnapshots: [],
        results: {
          [testCaseId]: { reportId: uncapturedId, status: 'completed' },
          [`${testCaseId}-b`]: { reportId: storedId, status: 'completed' },
        },
        createdAt: new Date().toISOString(),
      }),
    });
    if (!runRes.ok) throw new Error(`seed eval run failed: ${runRes.status}`);
    tracker.evaluationRun(evalRunId);
  }, 60_000);

  afterAll(async () => {
    if (backendAvailable) await tracker.cleanup();
  }, 60_000);

  it('dry run reports the uncaptured report as a candidate and writes nothing', async () => {
    if (!backendAvailable) return;
    const { code, summary, stderr } = await runScript(['--run', evalRunId]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(summary.mode).toBe('dry-run');
    expect(summary.scanned).toBe(2);
    expect(summary.candidates).toBe(1);
    expect(summary.sampleIds).toEqual([uncapturedId]);
    expect(summary.byJudge).toEqual({ 'agent-trace-judge': 1 });

    const doc = await getReport(uncapturedId);
    expect(doc.improvementStrategies).toEqual([]);
  }, 120_000);

  it('--apply persists strategies on all three surfaces; the pre-populated report is untouched; second pass is a no-op', async () => {
    if (!backendAvailable) return;
    const first = await runScript(['--run', evalRunId, '--apply']);
    expect(first.code).toBe(0);
    expect(first.summary.applied).toBe(1);
    expect(first.summary.failed).toBe(0);

    const doc = await getReport(uncapturedId);
    expect(doc.improvementStrategies).toEqual(STRATEGIES);
    expect(doc.llmJudgeResponse.improvementStrategies).toEqual(STRATEGIES);
    expect(doc.llmJudgeResponse.rawResponse).toBe(RAW); // raw text preserved
    expect(doc.matcherResults).toEqual([
      { description: 'true to equal true', pass: true, method: 'code-assertion' },
      { description: 'judge: 2 expected outcomes', pass: true, method: 'llm-judge', improvementStrategies: STRATEGIES },
    ]);
    // Nothing else on the doc moved.
    expect(doc.passFailStatus).toBe('passed');
    expect(doc.metrics).toEqual({ accuracy: 90 });
    expect(doc.trajectory).toEqual([{ type: 'assistant', content: 'answer' }]);

    const untouched = await getReport(storedId);
    expect(untouched.improvementStrategies).toEqual([STRATEGIES[1]]);

    const second = await runScript(['--run', evalRunId, '--apply']);
    expect(second.summary.candidates).toBe(0);
    expect(second.summary.applied).toBe(0);
  }, 180_000);
});
