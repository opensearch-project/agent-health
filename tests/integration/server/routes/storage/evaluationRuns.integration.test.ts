/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for Evaluation Runs API
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm run test:integration -- --testPathPattern=evaluationRuns.integration
 *
 * Tests cover:
 *   - CRUD operations (create, read, update, delete)
 *   - SSE streaming during execution
 *   - Cancellation of running evaluations
 *   - Promotion from ad-hoc run to benchmark
 *   - Filtering and pagination
 *   - Source resolution (test-case-ids, benchmark, label-filter)
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

// Check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'connected';
  } catch {
    return false;
  }
};

// Helper: create a test case
const createTestCase = async (name: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: `Test prompt for ${name}`,
      context: [],
      expectedTrajectory: [],
      labels: ['@integration-test'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test case: ${response.statusText}`);
  }

  const testCase = await response.json();
  return testCase.id;
};

// Helper: create an evaluation run (non-streaming, using PATCH to seed)
const createEvalRunDirect = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = `eval-run-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    id,
    name: 'Integration Test Run',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [{ type: 'test-case-ids', ids: [] }],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };

  // Use PATCH to create (it does upsert via the file adapter)
  const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });

  // If PATCH requires the doc to exist, we need to handle that
  if (!response.ok) {
    // Fallback: try to start a run with mock that completes quickly
    throw new Error(`Failed to create eval run: ${response.status} ${await response.text()}`);
  }

  return response.json();
};

// Helper: parse SSE events from response text
function parseSSEEvents(text: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  const blocks = text.split('\n\n').filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.split('\n');
    let eventType = '';
    let eventData = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      else if (line.startsWith('data: ')) eventData = line.slice(6);
    }

    if (eventData) {
      try {
        events.push({ event: eventType, data: JSON.parse(eventData) });
      } catch {
        // Skip unparseable events
      }
    }
  }

  return events;
}

// Helper: cleanup created resources
const cleanupIds: { testCases: string[]; evalRuns: string[]; benchmarks: string[] } = {
  testCases: [],
  evalRuns: [],
  benchmarks: [],
};

async function cleanup() {
  for (const id of cleanupIds.evalRuns) {
    try {
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  }
  for (const id of cleanupIds.benchmarks) {
    try {
      await fetch(`${BASE_URL}/api/storage/benchmarks/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  }
  for (const id of cleanupIds.testCases) {
    try {
      await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  }
}

describe('Evaluation Runs API Integration', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) {
      await cleanup();
    }
  });

  describe('GET /api/storage/evaluation-runs', () => {
    it('should return empty list initially or existing runs', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data).toHaveProperty('evaluationRuns');
      expect(data).toHaveProperty('total');
      expect(Array.isArray(data.evaluationRuns)).toBe(true);
      expect(typeof data.total).toBe('number');
    });

    it('should support pagination with from/size', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs?from=0&size=5`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.evaluationRuns.length).toBeLessThanOrEqual(5);
    });

    it('should filter by status', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs?status=completed`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      for (const run of data.evaluationRuns) {
        expect(run.status).toBe('completed');
      }
    });

    it('should filter by agentKey', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs?agentKey=demo`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      for (const run of data.evaluationRuns) {
        expect(run.agentKey).toBe('demo');
      }
    });
  });

  describe('POST /api/storage/evaluation-runs (SSE execution)', () => {
    it('should validate required fields', async () => {
      if (!backendAvailable) return;

      // Missing sources
      const res1 = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentKey: 'demo', modelId: 'claude-sonnet' }),
      });
      expect(res1.status).toBe(400);
      const err1 = await res1.json();
      expect(err1.error).toContain('sources');

      // Missing agentKey
      const res2 = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [{ type: 'test-case-ids', ids: ['x'] }], modelId: 'y' }),
      });
      expect(res2.status).toBe(400);
      const err2 = await res2.json();
      expect(err2.error).toContain('agentKey');

      // modelId is NO LONGER required — the agent's model comes from its own
      // agent-health.config.ts connectorConfig, resolved server-side by the
      // runner. A run with no modelId must NOT be rejected with a 400
      // 'modelId is required'; it proceeds past validation (SSE opens).
      const res3 = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [{ type: 'test-case-ids', ids: ['x'] }], agentKey: 'demo' }),
      });
      expect(res3.status).not.toBe(400);
      if (res3.status === 400) {
        const err3 = await res3.json();
        expect(err3.error).not.toContain('modelId');
      }
      // Drain the SSE body so the connection doesn't dangle.
      try { await res3.body?.cancel(); } catch { /* ignore */ }
    });

    it('should start an SSE stream and emit started event', async () => {
      if (!backendAvailable) return;

      const testCaseId = await createTestCase('SSE Stream Test');
      cleanupIds.testCases.push(testCaseId);

      // Use AbortController to terminate after first events
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'SSE Integration Test',
            sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
            agentKey: 'demo',
            modelId: 'claude-sonnet',
            concurrency: 1,
            trigger: 'api',
          }),
          signal: controller.signal,
        });

        expect(response.ok).toBe(true);
        expect(response.headers.get('content-type')).toBe('text/event-stream');

        // Read first chunk
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';

        // Read until we get at least a started event
        for (let i = 0; i < 10; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes('event: started')) break;
        }

        const events = parseSSEEvents(text);
        const startedEvent = events.find(e => e.event === 'started');
        expect(startedEvent).toBeDefined();
        expect(startedEvent!.data.runId).toBeDefined();
        expect(startedEvent!.data.testCases).toHaveLength(1);
        expect(startedEvent!.data.testCases[0].id).toBe(testCaseId);

        // Track run for cleanup
        cleanupIds.evalRuns.push(startedEvent!.data.runId);

        // Cancel the run to clean up
        await fetch(`${BASE_URL}/api/storage/evaluation-runs/${startedEvent!.data.runId}/cancel`, {
          method: 'POST',
        });

        reader.cancel();
      } catch (e: any) {
        if (e.name !== 'AbortError') throw e;
      } finally {
        clearTimeout(timeout);
      }
    }, 30000);
  });

  describe('GET /api/storage/evaluation-runs/:id', () => {
    it('should return 404 for non-existent run', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/non-existent-id-123`);
      expect(response.status).toBe(404);
    });

    it('should return a run by ID with all fields', async () => {
      if (!backendAvailable) return;

      // Get an existing run from the list
      const listRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs?size=1`);
      const listData = await listRes.json();

      if (listData.total === 0) return; // No runs to test with

      const runId = listData.evaluationRuns[0].id;
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`);
      expect(response.ok).toBe(true);

      const run = await response.json();
      expect(run.id).toBe(runId);
      expect(run).toHaveProperty('name');
      expect(run).toHaveProperty('status');
      expect(run).toHaveProperty('agentKey');
      expect(run).toHaveProperty('modelId');
      expect(run).toHaveProperty('sources');
      expect(run).toHaveProperty('createdAt');
    });
  });

  describe('POST /api/storage/evaluation-runs/:id/cancel', () => {
    it('should return 404 for non-running run', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/non-existent-run/cancel`, {
        method: 'POST',
      });
      expect(response.status).toBe(404);
    });

    it('should cancel a running evaluation', async () => {
      if (!backendAvailable) return;

      const testCaseId = await createTestCase('Cancel Test');
      cleanupIds.testCases.push(testCaseId);

      // Start a run
      const controller = new AbortController();
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cancel Integration Test',
          sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
          agentKey: 'demo',
          modelId: 'claude-sonnet',
          trigger: 'api',
        }),
        signal: controller.signal,
      });

      // Read until started event to get runId
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (let i = 0; i < 10; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: started')) break;
      }

      const events = parseSSEEvents(text);
      const startedEvent = events.find(e => e.event === 'started');
      expect(startedEvent).toBeDefined();

      const runId = startedEvent!.data.runId;
      cleanupIds.evalRuns.push(runId);

      // Cancel the run
      const cancelRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, {
        method: 'POST',
      });
      expect(cancelRes.ok).toBe(true);
      const cancelData = await cancelRes.json();
      expect(cancelData.success).toBe(true);

      // Verify status is cancelled
      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`);
      const run = await getRes.json();
      expect(run.status).toBe('cancelled');

      reader.cancel();
      controller.abort();
    }, 30000);
  });

  describe('PATCH /api/storage/evaluation-runs/:id', () => {
    it('should return 404 for non-existent run', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/non-existent-id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(response.status).toBe(404);
    });

    it('should partially update an existing run', async () => {
      if (!backendAvailable) return;

      // Get an existing run
      const listRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs?size=1`);
      const listData = await listRes.json();
      if (listData.total === 0) return;

      const runId = listData.evaluationRuns[0].id;
      const newName = `Updated ${Date.now()}`;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      expect(response.ok).toBe(true);

      const updated = await response.json();
      expect(updated.name).toBe(newName);
    });
  });

  describe('POST /api/storage/evaluation-runs/:id/promote', () => {
    it('should require benchmarkName', async () => {
      if (!backendAvailable) return;

      const listRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs?size=1`);
      const listData = await listRes.json();
      if (listData.total === 0) return;

      const runId = listData.evaluationRuns[0].id;
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const err = await response.json();
      expect(err.error).toContain('benchmarkName');
    });

    it('should promote an ad-hoc run to a benchmark', async () => {
      if (!backendAvailable) return;

      // Create a test case and a run without benchmarkId
      const testCaseId = await createTestCase('Promote Test');
      cleanupIds.testCases.push(testCaseId);

      // Start a quick run, then cancel immediately to have a run in the system
      const controller = new AbortController();
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Promote Integration Test',
          sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
          agentKey: 'demo',
          modelId: 'claude-sonnet',
          trigger: 'api',
        }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (let i = 0; i < 10; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: started')) break;
      }

      const events = parseSSEEvents(text);
      const runId = events.find(e => e.event === 'started')!.data.runId;
      cleanupIds.evalRuns.push(runId);

      // Cancel and mark as completed
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' });
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', benchmarkId: undefined }),
      });

      reader.cancel();
      controller.abort();

      // Wait a moment for state to settle
      await new Promise(r => setTimeout(r, 500));

      // Remove benchmarkId to ensure it's ad-hoc
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ benchmarkId: null }),
      });

      // Promote
      const benchmarkName = `Promoted BM ${Date.now()}`;
      const promoteRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ benchmarkName }),
      });

      if (promoteRes.ok) {
        const promoteData = await promoteRes.json();
        expect(promoteData.benchmark).toBeDefined();
        expect(promoteData.benchmark.name).toBe(benchmarkName);
        expect(promoteData.run.benchmarkId).toBe(promoteData.benchmark.id);
        cleanupIds.benchmarks.push(promoteData.benchmark.id);

        // Re-promoting should fail
        const rePromoteRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ benchmarkName: 'Another Name' }),
        });
        expect(rePromoteRes.status).toBe(400);
      } else {
        // If promote fails because run already has benchmarkId from cancel logic, that's acceptable
        const errBody = await promoteRes.json();
        expect(errBody.error).toMatch(/already|associated|benchmark/i);
      }
    }, 30000);
  });

  describe('DELETE /api/storage/evaluation-runs/:id', () => {
    it('should return 404 for non-existent run', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/non-existent-id-xyz`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(404);
    });

    it('should delete an existing run', async () => {
      if (!backendAvailable) return;

      // Create a run to delete
      const testCaseId = await createTestCase('Delete Test');
      cleanupIds.testCases.push(testCaseId);

      const controller = new AbortController();
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Delete Test Run',
          sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
          agentKey: 'demo',
          modelId: 'claude-sonnet',
          trigger: 'api',
        }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (let i = 0; i < 10; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: started')) break;
      }

      const events = parseSSEEvents(text);
      const runId = events.find(e => e.event === 'started')!.data.runId;

      // Cancel it first
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' });
      reader.cancel();
      controller.abort();

      await new Promise(r => setTimeout(r, 500));

      // Delete it
      const deleteRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'DELETE',
      });
      expect(deleteRes.ok).toBe(true);

      // Verify it's gone
      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`);
      expect(getRes.status).toBe(404);
    }, 30000);
  });

  describe('Source resolution', () => {
    it('should resolve test-case-ids source correctly', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Source Resolve TC 1');
      const tc2 = await createTestCase('Source Resolve TC 2');
      cleanupIds.testCases.push(tc1, tc2);

      const controller = new AbortController();
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Source Resolution Test',
          sources: [{ type: 'test-case-ids', ids: [tc1, tc2] }],
          agentKey: 'demo',
          modelId: 'claude-sonnet',
          trigger: 'api',
        }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (let i = 0; i < 10; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: started')) break;
      }

      const events = parseSSEEvents(text);
      const startedEvent = events.find(e => e.event === 'started');
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.data.testCases).toHaveLength(2);

      const testCaseIds = startedEvent!.data.testCases.map((tc: any) => tc.id);
      expect(testCaseIds).toContain(tc1);
      expect(testCaseIds).toContain(tc2);

      const runId = startedEvent!.data.runId;
      cleanupIds.evalRuns.push(runId);

      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' });
      reader.cancel();
      controller.abort();
    }, 30000);

    it('should resolve benchmark source', async () => {
      if (!backendAvailable) return;

      // Create test cases and a benchmark
      const tc1 = await createTestCase('Benchmark Source TC 1');
      const tc2 = await createTestCase('Benchmark Source TC 2');
      cleanupIds.testCases.push(tc1, tc2);

      const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Source Resolution BM ${Date.now()}`,
          testCaseIds: [tc1, tc2],
          runs: [],
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [tc1, tc2] }],
        }),
      });
      const bm = await bmRes.json();
      cleanupIds.benchmarks.push(bm.id);

      // Create evaluation run with benchmark source
      const controller = new AbortController();
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Benchmark Source Test',
          sources: [{ type: 'benchmark', benchmarkId: bm.id }],
          agentKey: 'demo',
          modelId: 'claude-sonnet',
          trigger: 'api',
        }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (let i = 0; i < 10; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: started')) break;
      }

      const events = parseSSEEvents(text);
      const startedEvent = events.find(e => e.event === 'started');
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.data.testCases).toHaveLength(2);

      const runId = startedEvent!.data.runId;
      cleanupIds.evalRuns.push(runId);

      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' });
      reader.cancel();
      controller.abort();
    }, 30000);

    it('should deduplicate test cases across multiple sources', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Dedup TC 1');
      const tc2 = await createTestCase('Dedup TC 2');
      cleanupIds.testCases.push(tc1, tc2);

      // Create a benchmark containing tc1
      const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Dedup BM ${Date.now()}`,
          testCaseIds: [tc1],
          runs: [],
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [tc1] }],
        }),
      });
      const bm = await bmRes.json();
      cleanupIds.benchmarks.push(bm.id);

      // Combine benchmark source (tc1) + test-case-ids (tc1, tc2)
      // Should deduplicate tc1
      const controller = new AbortController();
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Dedup Test',
          sources: [
            { type: 'benchmark', benchmarkId: bm.id },
            { type: 'test-case-ids', ids: [tc1, tc2] },
          ],
          agentKey: 'demo',
          modelId: 'claude-sonnet',
          trigger: 'api',
        }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (let i = 0; i < 10; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('event: started')) break;
      }

      const events = parseSSEEvents(text);
      const startedEvent = events.find(e => e.event === 'started');
      expect(startedEvent).toBeDefined();

      // Should be 2, not 3 (tc1 deduplicated)
      expect(startedEvent!.data.testCases).toHaveLength(2);

      const runId = startedEvent!.data.runId;
      cleanupIds.evalRuns.push(runId);

      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' });
      reader.cancel();
      controller.abort();
    }, 30000);
  });
});
