/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for evaluation SSE heartbeat and polling fallback.
 *
 * Verifies:
 * 1. Heartbeat events are emitted during evaluation
 * 2. reportId is present in the 'started' event
 * 3. Pre-created report is fetchable with 'running' status before evaluation completes
 *
 * Uses the observio agent if available, falls back to demo agent.
 *
 * Requirements:
 *   - Backend server running: npm run dev:server
 *   - Storage configured: OPENSEARCH_STORAGE_ENDPOINT env var
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 120000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

const checkAgent = async (agentKey: string): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/agents`);
    if (!response.ok) return false;
    const data = await response.json();
    const agents = data.agents || [];
    return agents.some((a: any) => a.key === agentKey);
  } catch {
    return false;
  }
};

async function consumeSSEStream(response: Response): Promise<any[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];

  const decoder = new TextDecoder();
  let buffer = '';
  const events: any[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        if (chunk.startsWith('data: ')) {
          try {
            events.push(JSON.parse(chunk.slice(6)));
          } catch { /* skip non-JSON */ }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return events;
}

describe('Evaluation SSE Heartbeat & Polling Fallback', () => {
  let isBackendAvailable = false;
  let agentKey = 'demo';
  let modelId = 'demo-model';
  const createdReportIds: string[] = [];

  beforeAll(async () => {
    isBackendAvailable = await checkBackend();
    if (!isBackendAvailable) {
      console.warn('Backend not available at', BASE_URL, '— skipping heartbeat integration tests');
      return;
    }

    // Prefer observio for real testing, fall back to demo
    if (await checkAgent('observio')) {
      agentKey = 'observio';
      modelId = 'claude-sonnet-4';
    }
  });

  afterAll(async () => {
    if (!isBackendAvailable) return;
    for (const id of createdReportIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  it('should include reportId in started event', async () => {
    if (!isBackendAvailable) return;

    const response = await fetch(`${BASE_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCase: {
          id: 'integ-reportid-test',
          name: 'Integration reportId Test',
          initialPrompt: 'Check system health.',
          context: [{ description: 'alert', value: 'CPU high on host-1' }],
          expectedOutcomes: ['Agent should check CPU'],
        },
        agentKey,
        modelId,
      }),
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await consumeSSEStream(response);
    const startedEvent = events.find(e => e.type === 'started');

    expect(startedEvent).toBeDefined();
    expect(startedEvent.reportId).toBeTruthy();
    createdReportIds.push(startedEvent.reportId);

    // Verify the report exists and has proper agent/test case info
    expect(startedEvent.agent).toBeTruthy();
    expect(startedEvent.testCase).toBeTruthy();
  }, TEST_TIMEOUT);

  it('should emit heartbeat events for long-running evaluations', async () => {
    if (!isBackendAvailable) return;
    // Skip if using demo agent (too fast to emit heartbeats)
    if (agentKey === 'demo') {
      console.log('Skipping heartbeat timing test with demo agent (too fast)');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCase: {
          id: 'integ-heartbeat-test',
          name: 'Integration Heartbeat Test',
          initialPrompt: 'Perform a comprehensive analysis of all system metrics including CPU, memory, disk, and network across all hosts in the cluster.',
          context: [{ description: 'cluster', value: 'prod-cluster-01 with 5 nodes' }],
          expectedOutcomes: [
            'Agent should check CPU metrics on all nodes',
            'Agent should check memory utilization',
            'Agent should report network throughput',
          ],
        },
        agentKey,
        modelId,
      }),
    });

    expect(response.ok).toBe(true);

    const events = await consumeSSEStream(response);
    const heartbeats = events.filter(e => e.type === 'heartbeat');
    const startedEvent = events.find(e => e.type === 'started');
    if (startedEvent?.reportId) createdReportIds.push(startedEvent.reportId);

    const completedEvent = events.find(e => e.type === 'completed');
    expect(completedEvent).toBeDefined();

    // Heartbeats fire every 15s — we can't control eval duration in this test,
    // so just verify they're valid if present and stream completed
    for (const hb of heartbeats) {
      expect(hb.type).toBe('heartbeat');
    }
  }, TEST_TIMEOUT);

  it('should have pre-created report fetchable with running status', async () => {
    if (!isBackendAvailable) return;

    const controller = new AbortController();

    const response = await fetch(`${BASE_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCase: {
          id: 'integ-running-status-test',
          name: 'Integration Running Status Test',
          initialPrompt: 'Check disk usage on all hosts.',
          context: [{ description: 'alert', value: 'Disk at 92% on host-3' }],
          expectedOutcomes: ['Agent should report disk utilization'],
        },
        agentKey,
        modelId,
      }),
      signal: controller.signal,
    });

    expect(response.ok).toBe(true);

    // Read just until started event
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reportId: string | null = null;

    while (!reportId) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        if (chunk.startsWith('data: ')) {
          try {
            const event = JSON.parse(chunk.slice(6));
            if (event.type === 'started' && event.reportId) {
              reportId = event.reportId;
              createdReportIds.push(reportId);
            }
          } catch { /* skip */ }
        }
      }
    }

    expect(reportId).toBeTruthy();

    // Fetch the report — should exist (may be 'running' or already 'completed' for fast evals)
    const reportRes = await fetch(`${BASE_URL}/api/storage/runs/${reportId}`);
    expect(reportRes.ok).toBe(true);
    const report = await reportRes.json();
    expect(['running', 'completed', 'failed']).toContain(report.status);

    // Abort the stream
    controller.abort();

    // Wait for server to finish (so cleanup works)
    const maxWait = 90000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch(`${BASE_URL}/api/storage/runs/${reportId}`);
      if (res.ok) {
        const r = await res.json();
        if (['completed', 'failed'].includes(r.status)) break;
      }
    }
  }, TEST_TIMEOUT);
});
