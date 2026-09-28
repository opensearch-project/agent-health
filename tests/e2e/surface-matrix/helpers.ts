/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared seeding for the UI half of the customer-surface regression matrix.
 * Everything goes through public APIs (the same ones the UI itself calls);
 * the fixture REST agent answers instantly and the demo judge grades without
 * an LLM, so a full real run finishes in ~1s.
 */

import type { Page } from '@playwright/test';
import type { TestDataTracker } from '../../helpers/testDataTracker';
import { uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, DEMO_MODEL, api, caseInput, createBenchmark, createTestCase, postSse, registerRestAgent, reportIdsOf,
  waitForReportsResolved, waitForTerminalRun,
} from '../../helpers/surfaceMatrix';

export { BASE_URL, DEMO_MODEL };

export interface SeededAgent {
  agent: TraceparentRestAgent;
  key: string;
  name: string;
}

/** Start the fixture agent and register it like a customer would (Settings → custom agent). */
export async function seedAgent(testData: TestDataTracker, opts: { useTraces?: boolean; delayMs?: number } = {}): Promise<SeededAgent> {
  const agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces`, delayMs: opts.delayMs });
  const name = uniqueTestName('ui-rest-agent');
  const created = await api<{ agent: { key: string } }>('POST', '/api/agents/custom', {
    name, endpoint: agent.url, connectorType: 'rest', useTraces: opts.useTraces ?? true,
  });
  testData.customAgent(created.agent.key);
  return { agent, key: created.agent.key, name };
}

export async function seedCases(testData: TestDataTracker, label: string, count: number): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  for (let i = 1; i <= count; i++) {
    const tc = await createTestCase(caseInput(label, i));
    testData.testCase(tc.id);
    out.push(tc);
  }
  return out;
}

export async function seedBenchmark(testData: TestDataTracker, label: string, caseIds: string[]): Promise<{ id: string; name: string }> {
  const bm = await createBenchmark(uniqueTestName(label), caseIds);
  testData.benchmark(bm.id);
  return bm;
}

/** A REAL completed run through the unified API (what "Add Run" does), with every report judged. */
export async function seedCompletedRun(
  testData: TestDataTracker,
  opts: { agentKey: string; benchmarkId?: string; caseIds?: string[]; name?: string }
): Promise<{ run: any; reportIds: string[] }> {
  const sources = opts.benchmarkId
    ? [{ type: 'benchmark', benchmarkId: opts.benchmarkId }]
    : [{ type: 'test-case-ids', ids: opts.caseIds ?? [] }];
  const res = await postSse('/api/storage/evaluation-runs', {
    name: opts.name ?? uniqueTestName('ui-seed-run'),
    sources,
    agentKey: opts.agentKey,
    modelId: DEMO_MODEL,
    judgeModelId: DEMO_MODEL,
    ...(opts.benchmarkId ? { benchmarkId: opts.benchmarkId } : {}),
    trigger: 'api',
  });
  const started = res.events.find((e) => e.event === 'started')?.data;
  if (!started) throw new Error(`run did not start: ${res.text.slice(0, 500)}`);
  testData.evaluationRun(started.runId);
  const run = await waitForTerminalRun(started.runId);
  const reportIds = reportIdsOf(run);
  for (const id of reportIds) testData.run(id);
  await waitForReportsResolved(reportIds);
  return { run, reportIds };
}

/** Pick an option in a Radix `Select` by its visible label. */
export async function selectRadixOption(page: Page, trigger: ReturnType<Page['locator']>, label: string): Promise<void> {
  await trigger.click();
  const listbox = page.locator('[role="listbox"]');
  await listbox.waitFor({ state: 'visible', timeout: 10_000 });
  await listbox.getByRole('option', { name: label, exact: true }).click();
}
