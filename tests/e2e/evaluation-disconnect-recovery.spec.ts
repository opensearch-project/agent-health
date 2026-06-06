/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Tests for SSE Disconnect Recovery
 *
 * Verifies that when the SSE stream disconnects mid-evaluation,
 * the server continues processing and the report is still saved.
 * The client can recover by polling GET /api/storage/runs/:reportId.
 *
 * Uses REAL observio agent — no mocks.
 *
 * Prerequisites:
 * - Observio sample agent running
 * - AWS credentials for Bedrock judge
 * - Backend server running with storage configured
 */

import { test, expect } from '@playwright/test';

const JUDGE_MODEL = 'claude-sonnet-4';
const AGENT_KEY = 'observio';
const TEST_TIMEOUT = 360000; // 6 minutes — leaves buffer over the 4-minute internal poll wait
const BACKEND_URL = `http://127.0.0.1:${process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001'}`;

let createdReportIds: string[] = [];

test.describe('SSE Disconnect Recovery', () => {
  test.setTimeout(TEST_TIMEOUT);

  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/health');
    if (!healthRes.ok()) {
      test.skip(true, 'Backend server not available');
    }

    const agentsRes = await request.get('/api/agents');
    if (!agentsRes.ok()) {
      test.skip(true, 'Agents API not available');
    }
    const agentsData = await agentsRes.json();
    const agentsList = agentsData.agents || [];
    const observio = agentsList.find((a: any) => a.key === AGENT_KEY);
    if (!observio) {
      test.skip(true, 'Observio agent not configured');
    }

    // Verify observio endpoint is actually reachable (not just configured)
    try {
      const endpoint = observio.endpoint || 'http://localhost:3001/run-agent';
      const endpointRes = await fetch(endpoint.replace('/run-agent', '/health')).catch(() => null);
      if (!endpointRes || !endpointRes.ok) {
        test.skip(true, 'Observio agent endpoint not reachable');
      }
    } catch {
      test.skip(true, 'Observio agent endpoint not reachable');
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdReportIds) {
      await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    }
  });

  test('server completes evaluation even after client disconnects', async ({ request }) => {
    // Start evaluation with AbortController so we can kill the connection
    const controller = new AbortController();

    const evalPromise = fetch(`${BACKEND_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCase: {
          id: 'e2e-disconnect-test',
          name: 'E2E Disconnect Recovery Test',
          initialPrompt: 'Check the health status of the database cluster and report any issues.',
          context: [{ description: 'alert', value: 'Database connection pool exhausted on db-primary-01' }],
          expectedOutcomes: [
            'Agent should check database connectivity',
            'Agent should report pool utilization',
          ],
        },
        agentKey: AGENT_KEY,
        modelId: JUDGE_MODEL,
      }),
      signal: controller.signal,
    });

    const response = await evalPromise;
    expect(response.ok).toBeTruthy();

    // Read just until we get the 'started' event with reportId
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

    // Abort the connection — simulates network disconnect
    controller.abort();

    // Poll until the server finishes processing
    const pollInterval = 5000;
    const maxWait = 240000; // 4 minutes
    const startTime = Date.now();
    let finalReport: any = null;

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const reportRes = await request.get(`/api/storage/runs/${reportId}`);
      if (reportRes.ok()) {
        const report = await reportRes.json();
        if (report.status === 'completed' || report.status === 'failed') {
          finalReport = report;
          break;
        }
      }
    }

    // Server should have completed the evaluation despite client disconnect
    expect(finalReport).toBeTruthy();
    expect(finalReport.status).toBe('completed');
    // For trace-mode agents, judge may be deferred — only assert if not pending
    if (finalReport.metricsStatus !== 'pending') {
      expect(finalReport.llmJudgeReasoning).toBeTruthy();
      expect(finalReport.passFailStatus).toMatch(/^(passed|failed)$/);
    }
  });

  test('pre-created report is immediately fetchable with running status', async ({ request }) => {
    const controller = new AbortController();

    const response = await fetch(`${BACKEND_URL}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCase: {
          id: 'e2e-running-status-test',
          name: 'E2E Running Status Test',
          initialPrompt: 'List all running services on the host.',
          context: [{ description: 'host', value: 'web-server-02' }],
          expectedOutcomes: ['Agent should list running services'],
        },
        agentKey: AGENT_KEY,
        modelId: JUDGE_MODEL,
      }),
      signal: controller.signal,
    });

    expect(response.ok).toBeTruthy();

    // Read until started event
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

    // Check that the report exists — it may already be 'running' or 'completed'
    // depending on how fast the eval finishes
    const reportRes = await request.get(`/api/storage/runs/${reportId}`);
    expect(reportRes.ok()).toBeTruthy();
    const report = await reportRes.json();
    expect(['running', 'completed', 'failed']).toContain(report.status);

    // Abort and let server finish in background
    controller.abort();

    // Wait for completion for cleanup
    const maxWait = 240000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const res = await request.get(`/api/storage/runs/${reportId}`);
      if (res.ok()) {
        const r = await res.json();
        if (r.status === 'completed' || r.status === 'failed') break;
      }
    }
  });
});
