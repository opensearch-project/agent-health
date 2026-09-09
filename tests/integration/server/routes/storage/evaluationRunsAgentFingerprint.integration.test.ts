/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for agent-configuration provenance on runs and reports
 * (lib/agentFingerprint.ts). Hits a REAL backend (AH_PORT) — the point is
 * to prove the stamp survives the actual create → execute → persist path
 * on both storage adapters, not that a mock echoed it back.
 *
 * Asserts:
 *   - POST /api/storage/evaluation-runs → the run doc carries
 *     agentFingerprint (sha256 hex) + agentFingerprintShort (12 hex);
 *   - every per-test-case REPORT carries the same fingerprint (case-level
 *     comparisons work);
 *   - GET /api/agents/:key/fingerprint returns exactly what a run created
 *     right now is stamped with (external tooling can pre-record it);
 *   - two runs of the same agent under the same config → SAME fingerprint
 *     (the stability half of "different config → different fingerprint",
 *     which unit tests pin since editing agent-health.config.ts on a live
 *     server isn't something an integration test should do);
 *   - the runs list projection includes the fields.
 *
 * Uses the built-in `demo` (mock connector) agent so no LLM/credentials are
 * needed. The demo agent has no system prompt, so `agentPromptHash` is
 * legitimately absent — asserted as such.
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=evaluationRunsAgentFingerprint.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const SHA256_HEX = /^[a-f0-9]{64}$/;
const TEST_TIMEOUT = 60_000;

const tracker = createTestDataTracker();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await r.json();
    return data.status === 'ok' || data.status === 'connected';
  } catch {
    return false;
  }
};

async function createTestCase(name: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, category: 'Test', difficulty: 'Easy', initialPrompt: `Prompt for ${name}`,
      context: [], expectedTrajectory: [], expectedOutcomes: ['ok'], labels: ['@integration-test'],
    }),
  });
  if (!r.ok) throw new Error(`create test case failed: ${r.status} ${await r.text()}`);
  const tc = await r.json();
  tracker.testCase(tc.id);
  return tc.id;
}

/** POST an evaluation run and drain its SSE stream to a terminal event. */
async function runToCompletion(body: Record<string, unknown>): Promise<{ runId: string; run: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let runId: string | null = null;
  let finalRun: any = null;
  try {
    const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`start run failed: ${response.status} ${await response.text()}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const eventLine = block.split('\n').find(l => l.startsWith('event: '));
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        let data: any;
        try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (data?.runId && !runId) { runId = data.runId; tracker.evaluationRun(runId!); }
        const ev = eventLine?.slice(7);
        if (ev === 'completed' || ev === 'error') { finalRun = data; break outer; }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!runId) throw new Error('run never reported a runId');
  const run = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).json();
  for (const result of Object.values((run.results || {}) as Record<string, any>)) {
    if (result?.reportId) tracker.run(result.reportId);
  }
  return { runId, run: run ?? finalRun };
}

describe('Agent-configuration provenance on runs + reports (integration)', () => {
  let backendAvailable = false;

  beforeAll(async () => { backendAvailable = await checkBackend(); });
  afterAll(async () => { await tracker.cleanup(); });

  it('GET /api/agents/:key/fingerprint returns a sha256 fingerprint (+ 404 for an unknown agent)', async () => {
    if (!backendAvailable) return;
    const r = await fetch(`${BASE_URL}/api/agents/demo/fingerprint`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.agentKey).toBe('demo');
    expect(body.agentFingerprint).toMatch(SHA256_HEX);
    expect(body.agentFingerprintShort).toBe(body.agentFingerprint.slice(0, 12));
    expect(body.computedAt).toEqual(expect.any(String));

    const missing = await fetch(`${BASE_URL}/api/agents/${encodeURIComponent(uniqueTestName('ghost'))}/fingerprint`);
    expect(missing.status).toBe(404);
  });

  it('create run → run.agentFingerprint AND every report.agentFingerprint are set and equal the current agent fingerprint', async () => {
    if (!backendAvailable) return;
    const tcId = await createTestCase(uniqueTestName('fp-case'));
    const current = await (await fetch(`${BASE_URL}/api/agents/demo/fingerprint`)).json();

    const { run } = await runToCompletion({
      name: uniqueTestName('fp-run'), sources: [{ type: 'test-case-ids', ids: [tcId] }],
      agentKey: 'demo', modelId: 'demo-model', trigger: 'api',
    });

    expect(run.agentFingerprint).toMatch(SHA256_HEX);
    expect(run.agentFingerprintShort).toBe(run.agentFingerprint.slice(0, 12));
    expect(run.agentFingerprint).toBe(current.agentFingerprint);
    // The built-in demo agent has no system prompt → no prompt hash.
    expect(run.agentPromptHash).toBeUndefined();

    const reportIds = Object.values(run.results as Record<string, any>).map(r => r.reportId).filter(Boolean);
    expect(reportIds.length).toBeGreaterThan(0);
    for (const reportId of reportIds) {
      const rep = await (await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`)).json();
      const doc = rep.run ?? rep;
      expect(doc.agentFingerprint).toBe(run.agentFingerprint);
      expect(doc.agentFingerprintShort).toBe(run.agentFingerprintShort);
    }
  }, TEST_TIMEOUT);

  it('two runs of the same agent under the same config carry the SAME fingerprint; the list projection includes it', async () => {
    if (!backendAvailable) return;
    const tcId = await createTestCase(uniqueTestName('fp-stable-case'));
    const a = await runToCompletion({ name: uniqueTestName('fp-a'), sources: [{ type: 'test-case-ids', ids: [tcId] }], agentKey: 'demo', modelId: 'demo-model', trigger: 'api' });
    const b = await runToCompletion({ name: uniqueTestName('fp-b'), sources: [{ type: 'test-case-ids', ids: [tcId] }], agentKey: 'demo', modelId: 'demo-model', trigger: 'api' });
    expect(a.run.agentFingerprint).toMatch(SHA256_HEX);
    expect(b.run.agentFingerprint).toBe(a.run.agentFingerprint);

    const list = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs?agentKey=demo&size=200`)).json();
    const rowA = list.evaluationRuns.find((r: any) => r.id === a.runId);
    expect(rowA).toBeDefined();
    expect(rowA.agentFingerprint).toBe(a.run.agentFingerprint);
    expect(rowA.agentFingerprintShort).toBe(a.run.agentFingerprintShort);
  }, TEST_TIMEOUT * 2);

  it('a run-level agentEndpoint override yields a DIFFERENT fingerprint than the plain agent (what the connector talks to changed)', async () => {
    if (!backendAvailable) return;
    const plain = await (await fetch(`${BASE_URL}/api/agents/demo/fingerprint`)).json();
    const overridden = await (await fetch(`${BASE_URL}/api/agents/demo/fingerprint?agentEndpoint=${encodeURIComponent('mock://demo-elsewhere')}`)).json();
    expect(overridden.agentFingerprint).toMatch(SHA256_HEX);
    expect(overridden.agentFingerprint).not.toBe(plain.agentFingerprint);
  });
});
