/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for GET /api/storage/runs?ids=…&fields=… — the
 * lightweight batch projection used by the run inspector and runs-list
 * pages to load status badges without shipping full report documents
 * (trajectory + judge output, ~0.3–2 MB each).
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm run test:integration -- --testPathPattern=runsBatchFields
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    // 'connected' → OpenSearch backend; 'ok' → file backend. The projection
    // is route-level, so it must work against both.
    return data.status === 'connected' || data.status === 'ok';
  } catch {
    return false;
  }
};

describe('GET /api/storage/runs?ids=&fields= (batch projection)', () => {
  let backendAvailable = false;
  const createdRunIds: string[] = [];

  const createRun = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const response = await fetch(`${BASE_URL}/api/storage/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCaseId: 'tc-batch-fields-test',
        testCaseVersionId: 'tc-batch-fields-test-v1',
        agentId: 'test-agent',
        modelId: 'test-model',
        iteration: 1,
        status: 'completed',
        passFailStatus: 'passed',
        metricsStatus: 'ready',
        trajectory: [{ type: 'assistant', content: 'a large trajectory step' }],
        rawEvents: [{ type: 'RAW', payload: 'should never appear in batch' }],
        llmJudgeReasoning: 'reasoning text',
        ...overrides,
      }),
    });
    if (!response.ok) throw new Error(`Failed to create run: ${response.statusText}`);
    const run = await response.json();
    createdRunIds.push(run.id);
    return run.id;
  };

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    for (const id of createdRunIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  it('returns only the requested fields (plus id) when fields= is given', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');

    const id = await createRun();
    const res = await fetch(
      `${BASE_URL}/api/storage/runs?ids=${encodeURIComponent(id)}&fields=status,passFailStatus,metricsStatus`,
    );
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.total).toBe(1);
    const run = body.runs[0];

    expect(run.id).toBe(id);
    expect(run.status).toBe('completed');
    expect(run.passFailStatus).toBe('passed');
    expect(run.metricsStatus).toBe('ready');
    // Heavy fields must NOT be shipped
    expect(run.trajectory).toBeUndefined();
    expect(run.rawEvents).toBeUndefined();
    expect(run.llmJudgeReasoning).toBeUndefined();
  });

  it('silently skips requested fields missing on the document', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');

    const id = await createRun();
    const res = await fetch(
      `${BASE_URL}/api/storage/runs?ids=${encodeURIComponent(id)}&fields=status,definitelyNotAField`,
    );
    const body = await res.json();
    const run = body.runs[0];
    expect(run.status).toBe('completed');
    expect('definitelyNotAField' in run).toBe(false);
  });

  it('batch without fields still returns full docs minus rawEvents (existing behavior)', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');

    const id = await createRun();
    const res = await fetch(`${BASE_URL}/api/storage/runs?ids=${encodeURIComponent(id)}`);
    const body = await res.json();
    const run = body.runs[0];
    expect(run.trajectory).toBeDefined();
    expect(run.rawEvents).toBeUndefined();
  });

  it('projects multiple ids in one request', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');

    const idA = await createRun({ passFailStatus: 'passed' });
    const idB = await createRun({ passFailStatus: 'failed' });
    const res = await fetch(
      `${BASE_URL}/api/storage/runs?ids=${encodeURIComponent(idA)},${encodeURIComponent(idB)}&fields=passFailStatus`,
    );
    const body = await res.json();
    expect(body.total).toBe(2);
    const byId = Object.fromEntries(body.runs.map((r: any) => [r.id, r]));
    expect(byId[idA].passFailStatus).toBe('passed');
    expect(byId[idB].passFailStatus).toBe('failed');
    expect(byId[idA].trajectory).toBeUndefined();
  });
});
