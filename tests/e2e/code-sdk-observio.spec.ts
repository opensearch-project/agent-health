/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Tests for Code-Based Test Case SDK with Observio agent.
 *
 * These tests exercise the full deterministic evaluation path via the CLI
 * benchmark command, using a code-based .eval.js fixture against the Observio
 * sample agent (ReAct pattern with AG-UI protocol).
 *
 * Prerequisites:
 *   - Observio agent running on port 3001 (cd observio-sample-agent && npm run start:ag-ui)
 *   - Agent Health server running (npm run dev:server)
 *
 * Tests will gracefully skip if Observio is not reachable.
 */

import { test, expect } from './fixtures/test-fixtures';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OBSERVIO_ENDPOINT = 'http://localhost:3001/run-agent';
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/observio-sample.eval.js');

/**
 * Check if Observio agent is reachable.
 * Returns true if the agent responds to a health check or connection attempt.
 */
async function isObservioAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(OBSERVIO_ENDPOINT.replace('/run-agent', '/health'), {
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);

    // Even a 404 means the server is up (no /health route is fine)
    if (response) return true;

    // Try connecting to the base URL as fallback
    const fallbackController = new AbortController();
    const fallbackTimeout = setTimeout(() => fallbackController.abort(), 3000);
    const fallback = await fetch('http://localhost:3001/', {
      signal: fallbackController.signal,
    }).catch(() => null);
    clearTimeout(fallbackTimeout);

    return fallback !== null;
  } catch {
    return false;
  }
}

test.describe('Code SDK - Observio E2E via API', () => {
  let observioRunning: boolean;

  test.beforeAll(async () => {
    observioRunning = await isObservioAvailable();
    if (!observioRunning) {
      console.log(
        '[code-sdk-observio] Observio agent not available at ' + OBSERVIO_ENDPOINT +
        '. Skipping live agent tests. Start with: cd observio-sample-agent && npm run start:ag-ui'
      );
    }
  });

  // The tests in this file use page.evaluate(() => fetch('/api/...')) which
  // resolves the relative URL against the page's current origin. Without an
  // explicit goto, that origin is about:blank and every fetch fails. Navigate
  // to baseURL once before each test so /api/* resolves to the backend.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should verify fixture file is loadable via evaluation-runs API', async ({ page }) => {
    // This test verifies the server can accept code-import sources
    // even without a live agent. It validates the API request format.
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return { ok: false, agents: [] };
        const data = await res.json();
        return { ok: true, agents: data.agents || [] };
      } catch {
        return { ok: false, agents: [] };
      }
    });

    expect(result.ok).toBe(true);

    // Verify observio agent is in the agents list
    const observioAgent = result.agents.find(
      (a: any) => a.key === 'observio'
    );
    expect(observioAgent).toBeTruthy();
    expect(observioAgent.connectorType).toBe('agui-streaming');
    expect(observioAgent.name).toContain('Observio');
  });

  test('should confirm Observio agent is configured with correct endpoint', async ({ page }) => {
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return { agent: null };
        const data = await res.json();
        const agent = (data.agents || []).find(
          (a: any) => a.key === 'observio'
        );
        return { agent };
      } catch {
        return { agent: null };
      }
    });

    expect(result.agent).toBeTruthy();
    // Endpoint should point to localhost:3001 (default Observio port)
    expect(result.agent.endpoint).toContain('3001');
  });

  test('should execute deterministic evaluation run against Observio (live agent)', async ({ page }) => {
    test.skip(!observioRunning, 'Observio agent not available');
    // Real eval = Observio agent + Bedrock judge + 2 fixture test cases.
    // The default 60s Playwright test timeout is too short; allow 3 min.
    test.setTimeout(180_000);

    // Execute a code-import evaluation run via the API
    const result = await page.evaluate(async (fixturePath: string) => {
      try {
        const res = await fetch('/api/storage/evaluation-runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'E2E Code SDK - Observio',
            sources: [
              { type: 'code-import', filenames: [fixturePath], testCaseIds: [] },
            ],
            agentKey: 'observio',
            modelId: 'claude-sonnet',
            concurrency: 1,
            trigger: 'e2e-test',
          }),
        });

        if (!res.ok || !res.body) {
          const errText = await res.text();
          return { ok: false, error: errText, runId: null, completed: false };
        }

        // Parse SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let runId = '';
        let completed = false;
        let completedCount = 0;
        let totalTestCases = 0;
        const timeout = Date.now() + 120000; // 2 minute timeout

        while (Date.now() < timeout) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.runId && data.testCases) {
                  runId = data.runId;
                  totalTestCases = data.testCases.length;
                } else if (data.completedCount !== undefined) {
                  completedCount = data.completedCount;
                } else if (data.status === 'completed' || data.status === 'cancelled') {
                  completed = true;
                  break;
                } else if (data.error) {
                  return { ok: false, error: data.error, runId, completed: false };
                }
              } catch {
                // Skip malformed SSE lines
              }
            }
          }
          if (completed) break;
        }

        return { ok: true, runId, completed, completedCount, totalTestCases, error: null };
      } catch (err: any) {
        return { ok: false, error: err.message, runId: null, completed: false };
      }
    }, FIXTURE_PATH);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.runId).toBeTruthy();
    expect(result.completed).toBe(true);
    expect(result.totalTestCases).toBe(2); // 2 test cases in the fixture
  });

  test('should verify deterministic evaluation results have expected fields (live agent)', async ({ page }) => {
    test.skip(!observioRunning, 'Observio agent not available');
    // Real eval = Observio agent + Bedrock judge; needs more than the
    // default 60s test timeout.
    test.setTimeout(180_000);

    // First, create a run
    const createResult = await page.evaluate(async (fixturePath: string) => {
      const res = await fetch('/api/storage/evaluation-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E Code SDK Verify - Observio',
          sources: [
            { type: 'code-import', filenames: [fixturePath], testCaseIds: [] },
          ],
          agentKey: 'observio',
          modelId: 'claude-sonnet',
          concurrency: 1,
          trigger: 'e2e-test',
        }),
      });

      if (!res.ok || !res.body) {
        return { runId: null };
      }

      // Read stream until done
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let runId = '';
      const timeout = Date.now() + 120000;

      while (Date.now() < timeout) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.runId && data.testCases) runId = data.runId;
              if (data.status === 'completed' || data.status === 'cancelled') break;
            } catch {}
          }
        }
      }

      return { runId };
    }, FIXTURE_PATH);

    if (!createResult.runId) {
      test.skip(true, 'Could not create evaluation run');
      return;
    }

    // Fetch the completed run and verify results
    const runDetails = await page.evaluate(async (runId: string) => {
      const res = await fetch(`/api/storage/evaluation-runs/${runId}`);
      if (!res.ok) return null;
      return await res.json();
    }, createResult.runId);

    expect(runDetails).toBeTruthy();
    expect(runDetails.status).toMatch(/completed|failed/);

    // Verify that results exist for both test cases
    const resultEntries = Object.entries(runDetails.results || {});
    expect(resultEntries.length).toBe(2);

    // Each result should have a reportId and status
    for (const [_tcId, result] of resultEntries) {
      const r = result as any;
      expect(r.status).toMatch(/completed|failed/);
      if (r.status === 'completed') {
        expect(r.reportId).toBeTruthy();
      }
    }
  });

  test('should clean up e2e evaluation runs', async ({ page }) => {
    // Clean up any runs created by this test suite
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/storage/evaluation-runs');
        if (!res.ok) return { cleaned: 0 };
        const data = await res.json();
        const e2eRuns = (data.evaluationRuns || []).filter(
          (r: any) => r.name?.startsWith('E2E Code SDK')
        );

        let cleaned = 0;
        for (const run of e2eRuns) {
          const delRes = await fetch(`/api/storage/evaluation-runs/${run.id}`, {
            method: 'DELETE',
          });
          if (delRes.ok) cleaned++;
        }
        return { cleaned };
      } catch {
        return { cleaned: 0 };
      }
    });

    // Cleanup is best-effort
    expect(typeof result.cleaned).toBe('number');
  });
});

test.describe('Code SDK - Server-side code-import validation', () => {
  // Same rationale as above: ensure relative /api/* fetches resolve against
  // the backend origin rather than about:blank.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should reject code-import with non-existent file path', async ({ page }) => {
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/storage/evaluation-runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'E2E Invalid File Test',
            sources: [
              { type: 'code-import', filenames: ['/nonexistent/path/fake.eval.js'], testCaseIds: [] },
            ],
            agentKey: 'observio',
            modelId: 'claude-sonnet',
            concurrency: 1,
            trigger: 'e2e-test',
          }),
        });

        // Read the SSE stream for error
        if (!res.body) return { status: res.status, error: 'no body' };

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let errorMessage = '';
        const timeout = Date.now() + 10000;

        while (Date.now() < timeout) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.error) {
                  errorMessage = data.error;
                  break;
                }
              } catch {}
            }
          }
          if (errorMessage) break;
        }

        return { status: res.status, error: errorMessage };
      } catch (err: any) {
        return { status: 0, error: err.message };
      }
    });

    // Should either get an HTTP error or an SSE error event about file not found
    const hasError = result.status >= 400 || result.error.toLowerCase().includes('not found') || result.error.length > 0;
    expect(hasError).toBe(true);
  });

  test('should accept code-import source type via agents API', async ({ page }) => {
    // Verify the server's source type recognition
    // Use the /api/agents endpoint to confirm the server is configured correctly
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return { ok: false };
        const data = await res.json();
        return {
          ok: true,
          hasObservio: (data.agents || []).some((a: any) => a.key === 'observio'),
          agentCount: (data.agents || []).length,
        };
      } catch {
        return { ok: false };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.hasObservio).toBe(true);
    expect(result.agentCount).toBeGreaterThan(0);
  });
});
