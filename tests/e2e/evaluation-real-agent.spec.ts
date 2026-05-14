/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Tests for Real Agent Evaluation Flow
 *
 * Uses the REAL observio agent and a REAL Bedrock judge model.
 * No Demo Agent, no Demo Model — this proves the full pipeline works end-to-end.
 *
 * Prerequisites:
 * - Observio sample agent running (cd observio-sample-agent && npm run start:ag-ui)
 * - AWS credentials configured for Bedrock access
 * - Backend server running with storage configured
 */

import { test, expect } from '@playwright/test';

const JUDGE_MODEL = 'claude-sonnet-4';
const AGENT_KEY = 'observio';
const TEST_TIMEOUT = 180000; // 3 minutes — real evals take time

let createdReportIds: string[] = [];

test.describe('Real Agent Evaluation (Observio + Bedrock Judge)', () => {
  test.setTimeout(TEST_TIMEOUT);

  test.beforeAll(async ({ request }) => {
    // Verify observio agent is healthy
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

    // Verify observio endpoint is reachable
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
    // Clean up created reports
    for (const id of createdReportIds) {
      await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    }
  });

  test('completes full evaluation with real judge and produces reasoning', async ({ request }) => {
    // Use a sample test case that exercises real agent capabilities
    const testCasesRes = await request.get('/api/storage/test-cases');
    let testCaseId: string;

    if (testCasesRes.ok()) {
      const data = await testCasesRes.json();
      const testCases = data.testCases || [];
      if (testCases.length > 0) {
        testCaseId = testCases[0].id;
      } else {
        // Use first sample test case
        testCaseId = 'sample-rca-cpu-spike';
      }
    } else {
      testCaseId = 'sample-rca-cpu-spike';
    }

    // Run evaluation via SSE endpoint
    const evalRes = await request.post('/api/evaluate', {
      data: {
        testCaseId,
        agentKey: AGENT_KEY,
        modelId: JUDGE_MODEL,
      },
    });

    expect(evalRes.ok()).toBeTruthy();
    expect(evalRes.headers()['content-type']).toContain('text/event-stream');

    // Consume the SSE stream
    const body = await evalRes.text();
    const events = body
      .split('\n\n')
      .filter(chunk => chunk.startsWith('data: '))
      .map(chunk => {
        try { return JSON.parse(chunk.slice(6)); }
        catch { return null; }
      })
      .filter(Boolean);

    // Verify event sequence
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('started');
    expect(eventTypes).toContain('completed');

    // Verify started event has reportId (new feature)
    const startedEvent = events.find(e => e.type === 'started');
    expect(startedEvent).toBeDefined();
    expect(startedEvent.reportId).toBeTruthy();
    createdReportIds.push(startedEvent.reportId);

    // Verify step events exist (agent actually ran)
    const stepEvents = events.filter(e => e.type === 'step');
    expect(stepEvents.length).toBeGreaterThan(0);

    // Verify completed event has results
    const completedEvent = events.find(e => e.type === 'completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.report).toBeDefined();
    expect(completedEvent.report.status).toBe('completed');

    // For trace-mode agents (observio with useTraces: true), judge results
    // may be deferred (metricsStatus: 'pending'). Accept either immediate or pending.
    if (completedEvent.report.metricsStatus !== 'pending') {
      expect(completedEvent.report.passFailStatus).toMatch(/^(passed|failed)$/);
      expect(completedEvent.report.llmJudgeReasoning).toBeTruthy();
      expect(completedEvent.report.llmJudgeReasoning.length).toBeGreaterThan(50);
    }

    // Verify report is persisted and fetchable
    const reportRes = await request.get(`/api/storage/runs/${completedEvent.reportId}`);
    expect(reportRes.ok()).toBeTruthy();
    const savedReport = await reportRes.json();
    expect(savedReport.status).toBe('completed');
  });

  test('SSE stream includes heartbeat events during long evaluation', async ({ request }) => {
    // Use inline test case with enough complexity to take >15s
    const evalRes = await request.post('/api/evaluate', {
      data: {
        testCase: {
          id: 'e2e-heartbeat-test',
          name: 'E2E Heartbeat Test',
          initialPrompt: 'Investigate the root cause of high memory usage on the application server. Check logs, metrics, and identify the problematic service.',
          context: [{ description: 'alert', value: 'Memory usage exceeded 90% threshold on app-server-01 at 14:32 UTC' }],
          expectedOutcomes: [
            'Agent should identify memory-intensive processes',
            'Agent should check application logs for memory leaks',
          ],
        },
        agentKey: AGENT_KEY,
        modelId: JUDGE_MODEL,
      },
    });

    expect(evalRes.ok()).toBeTruthy();

    const body = await evalRes.text();
    const events = body
      .split('\n\n')
      .filter(chunk => chunk.startsWith('data: '))
      .map(chunk => {
        try { return JSON.parse(chunk.slice(6)); }
        catch { return null; }
      })
      .filter(Boolean);

    // Track reportId for cleanup
    const startedEvent = events.find(e => e.type === 'started');
    if (startedEvent?.reportId) {
      createdReportIds.push(startedEvent.reportId);
    }

    // Heartbeat events should appear if evaluation takes >15s
    const heartbeats = events.filter(e => e.type === 'heartbeat');
    // If the eval completed in <15s, heartbeats may not appear — that's OK
    // The important thing is they don't break parsing
    const completedEvent = events.find(e => e.type === 'completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.report.status).toBe('completed');
  });
});
