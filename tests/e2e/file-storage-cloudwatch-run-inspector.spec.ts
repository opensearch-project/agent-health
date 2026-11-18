/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #640 route, rendered: a run executed on a server with FILE storage and the
 * CLOUDWATCH observability backend — its run inspector shows per-run metrics
 * from the spans and the case's Traces tab shows the span tree.
 *
 * This spec boots ITS OWN server (`server/dist/index.js`, cwd = a throw-away
 * project with `agent-health.config.mjs`: a local REST agent + CloudWatch, no
 * `storage`) and talks to it by absolute URL, because the shared e2e backend
 * has no observability source. The AWS SDK inside that server is real and
 * signs its requests to a local CloudWatch Logs API stub
 * (`AWS_ENDPOINT_URL_CLOUDWATCH_LOGS`); the agent is a local HTTP server whose
 * spans land in that stub. Nothing is mocked in the browser: `/api/traces`
 * and `/api/metrics/batch` are answered by the real server from the stub's
 * records.
 *
 * The run is started through the same `code-import` evaluation-runs request
 * `agent-health benchmark -f <file>` sends (the CLI bundle is not built in the
 * e2e job; the CLI itself is covered by
 * tests/integration/cli/benchmarkFileStorageCloudWatch.integration.test.ts).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/test-fixtures';
import {
  createFileStorageCloudWatchProject,
  httpJson,
  DEMO_AGENT_KEY,
  EVAL_FILE_RELATIVE,
  SERVER_BUNDLE,
  type FileStorageCloudWatchProject,
} from '../helpers/fileStorageCloudWatchProject';
import { DEMO_AGENT_SPANS, DEMO_AGENT_TOKENS, DEMO_AGENT_TOOL } from '../helpers/demoRetrievalAgentStub';

const CASE_OK = 'answers from the knowledge base';
const CASE_TOOL_ERROR = 'a failed tool attempt is retried';
const TOTAL_TOKENS = DEMO_AGENT_TOKENS.input + DEMO_AGENT_TOKENS.output; // 4 050 per case
/**
 * Spans the Traces tab shows for ONE case: the inspector unions the case's
 * exact ids with the always-on Strategy-C clause (agent service.name + run
 * window), and the three cases of this run executed within the same seconds —
 * so the sibling cases' traces ride along (the documented concurrency noise of
 * Strategy C, AGENTS.md → Trace correlation; identical on OpenSearch).
 */
const SPANS_IN_WINDOW = 2 * DEMO_AGENT_SPANS.normal + DEMO_AGENT_SPANS.withToolError; // 13
/** When set, screenshots of the rendered inspector land here (proof pack); never in CI. */
const SHOTS_DIR = process.env.AH_E2E_SHOTS_DIR || '';
async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.mouse.move(1200, 600); // let the hover-open sidebar collapse
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

/** Read an SSE response body to its terminal event. */
function sseEvents(text: string): any[] {
  const events: any[] = [];
  for (const block of text.split('\n\n')) {
    let eventName: string | undefined;
    let dataLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine);
      events.push(eventName && !('type' in parsed) ? { type: eventName, ...parsed } : parsed);
    } catch {
      /* ignore */
    }
  }
  return events;
}

test.describe('file storage + CloudWatch: run inspector metrics strip and Traces tab (#640 route)', () => {
  // One worker, one server, one run: both tests read the same project.
  test.describe.configure({ mode: 'serial' });
  let project: FileStorageCloudWatchProject;
  let benchmarkId: string;
  let evalRunId: string;
  const reportByCase = new Map<string, any>();
  const tcIdByCase = new Map<string, string>();

  test.beforeAll(async ({ playwright }) => {
    test.skip(!existsSync(SERVER_BUNDLE), `${SERVER_BUNDLE} missing — run npm run build:server`);
    project = await createFileStorageCloudWatchProject({ prefix: 'ah-e2e-file-cw' });
    await project.startServer('server-bundle');

    const api = await playwright.request.newContext({ baseURL: project.baseUrl });
    const bm = await api.post('/api/storage/benchmarks', { data: { name: 'File storage + CloudWatch (e2e)', description: 'spans read from CloudWatch', testCaseIds: [] } });
    expect(bm.ok(), await bm.text()).toBeTruthy();
    benchmarkId = (await bm.json()).id;

    // The request `agent-health benchmark -f ./evals/retrieval.eval.js -a demo-retrieval -n …` sends.
    const run = await api.post('/api/storage/evaluation-runs', {
      data: {
        name: 'CLI Run - demo-retrieval (e2e)',
        sources: [{ type: 'code-import', filenames: [join(project.dir, EVAL_FILE_RELATIVE)], testCaseIds: [] }],
        agentKey: DEMO_AGENT_KEY,
        concurrency: 1,
        benchmarkId,
        trigger: 'cli',
      },
      timeout: 120_000,
    });
    expect(run.ok(), await run.text()).toBeTruthy();
    const events = sseEvents(await run.text());
    const started = events.find((e) => e.runId && e.testCases);
    expect(started, JSON.stringify(events.map((e) => e.type ?? e.status))).toBeTruthy();
    evalRunId = started.runId;
    for (const tc of started.testCases ?? []) tcIdByCase.set(tc.name, tc.id);
    await api.dispose();

    const doc = await httpJson(`${project.baseUrl}/api/storage/evaluation-runs/${evalRunId}`);
    const evaluationRun = doc.body.evaluationRun ?? doc.body;
    expect(evaluationRun.status).toBe('completed');
    for (const [tcId, result] of Object.entries<any>(evaluationRun.results ?? {})) {
      const name = [...tcIdByCase.entries()].find(([, id]) => id === tcId)?.[0];
      const rep = await httpJson(`${project.baseUrl}/api/storage/runs/${result.reportId}`);
      if (name) reportByCase.set(name, rep.body.report ?? rep.body.run ?? rep.body);
    }
    // File-adapter shape, the one #640 is about.
    expect(reportByCase.get(CASE_OK).createdAt).toBeUndefined();
    expect(typeof reportByCase.get(CASE_OK).timestamp).toBe('string');
  });

  test.afterAll(async () => {
    await project?.cleanup(); // kills only the server PID it spawned; the project dir (file storage) goes with it
  });

  test('metrics strip reads every case from CloudWatch, and the Traces tab renders the span tree', async ({ page }) => {
    const ok = reportByCase.get(CASE_OK);
    const traceRequests: any[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/traces') && req.method() === 'POST') traceRequests.push(JSON.parse(req.postData() || '{}'));
    });

    await page.goto(`${project.baseUrl}/evaluations/benchmarks/${benchmarkId}/runs/${evalRunId}/inspect?reportId=${ok.id}`);

    // Run-level telemetry: tokens / cost / LLM calls / tool calls / spans N/N — never "Metrics unavailable".
    const strip = page.getByTestId('run-telemetry-strip');
    await expect(strip).toHaveAttribute('data-state', 'value', { timeout: 30_000 });
    await expect(page.getByTestId('strip-tokens')).toContainText('12.2K'); // 3 × 4 050
    await expect(page.getByTestId('strip-tokens')).toHaveAttribute('title', `${(3 * TOTAL_TOKENS).toLocaleString()} tokens`);
    await expect(page.getByTestId('strip-spans')).toContainText('spans: 3/3 cases');
    await expect(page.getByTestId('strip-spans')).not.toHaveAttribute('title', 'Metrics unavailable');

    // The case's Traces tab: spans from CloudWatch, by the run's exact ids.
    await page.getByRole('tab', { name: /^Traces/ }).click();
    await expect(page.getByRole('tab', { name: /^Traces/ })).toContainText(String(SPANS_IN_WINDOW), { timeout: 30_000 });
    await expect(page.getByText('No traces available')).toHaveCount(0);
    await expect(page.getByText('No traces found')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fullscreen' })).toBeVisible();
    // The default Timeline view draws on a canvas; the Trace Tree view renders span names as text.
    await page.getByRole('button', { name: 'Trace Tree' }).click();
    await expect(page.getByText('POST /invoke')).toHaveCount(3); // one root per trace in the window
    await expect(page.getByText(`execute_tool ${DEMO_AGENT_TOOL}`)).toHaveCount(4); // 1 + 1 + (failed attempt + retry)
    await expect(page.getByText(/^chat demo-provider\.demo-model-v1$/)).toHaveCount(6);
    await shot(page, 'after-traces-tab-file-storage-cloudwatch');

    // The request the inspector sent carries the exact ids and a window built around the RUN (file storage: from `timestamp`).
    expect(traceRequests.length).toBeGreaterThanOrEqual(1);
    const req = traceRequests[0];
    expect(req.runIds).toEqual([ok.runId]);
    expect(req.agents?.[0]?.sessionId).toBe(ok.sessionId);
    expect(req.agents?.[0]?.endedAt).toBe(Date.parse(ok.timestamp) + 60_000);
  });

  test('a case whose tool call failed once still shows its spans and is not an errored run', async ({ page }) => {
    const toolError = reportByCase.get(CASE_TOOL_ERROR);
    await page.goto(`${project.baseUrl}/evaluations/benchmarks/${benchmarkId}/runs/${evalRunId}/inspect?reportId=${toolError.id}`);
    await expect(page.getByTestId('inspector-status-badge')).toHaveText('PASSED', { timeout: 30_000 });
    await expect(page.getByTestId('run-failure-card')).toHaveCount(0);
    await page.getByRole('tab', { name: /^Traces/ }).click();
    await expect(page.getByRole('tab', { name: /^Traces/ })).toContainText(String(SPANS_IN_WINDOW), { timeout: 30_000 });
    await expect(page.getByText('No traces found')).toHaveCount(0);
  });
});
