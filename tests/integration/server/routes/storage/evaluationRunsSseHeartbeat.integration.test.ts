/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the POST /api/storage/evaluation-runs SSE stream carries a
 * keep-alive heartbeat (`: ping` comment frames) while the run executes, and
 * still terminates with `event: completed`.
 *
 * Why (owner report 2026-09-09): a benchmark run can idle for minutes between
 * per-case events; proxies / tunnels / browsers close a silent SSE connection
 * long before a 30–60 min run finishes, which left the benchmark page's "Add
 * Run" header spinning forever. The heartbeat keeps the socket warm; the
 * client fix (header derives from the polled run doc) makes it correct even
 * when a proxy closes the stream anyway.
 *
 * Requires a backend booted with EVALUATION_RUN_SSE_HEARTBEAT_MS set low (this
 * suite uses 50 ms) — the default 15 s would not fire during a `demo` run.
 * When the env var is not set low the heartbeat assertion is skipped (the
 * terminal-event assertion still runs). Uses `agentKey: 'demo'` (built-in
 * mock provider, no external creds). Every created id is deleted.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const HEARTBEAT_MS = Number(process.env.EVALUATION_RUN_SSE_HEARTBEAT_MS ?? NaN);
const heartbeatIsLow = Number.isFinite(HEARTBEAT_MS) && HEARTBEAT_MS > 0 && HEARTBEAT_MS <= 1000;

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'ok' || data.status === 'connected';
  } catch {
    return false;
  }
};

describe('POST /api/storage/evaluation-runs — SSE heartbeat', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it('streams `: ping` comment frames between events and still ends with `event: completed`', async () => {
    if (!backendAvailable) return;

    const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('sse-heartbeat-tc'),
        category: 'Test', difficulty: 'Easy',
        initialPrompt: 'heartbeat probe', context: [], expectedTrajectory: [],
        labels: ['@integration-test'],
      }),
    });
    expect(tcRes.ok).toBe(true);
    const testCaseId = (await tcRes.json()).id as string;
    tracker.testCase(testCaseId);

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 60_000);
    let raw = '';
    let runId: string | null = null;
    try {
      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: uniqueTestName('sse-heartbeat-run'),
          sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
          agentKey: 'demo', modelId: 'demo-model', concurrency: 1, trigger: 'api',
        }),
        signal: controller.signal,
      });
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toBe('text/event-stream');

      // Drain the raw body to its natural end — we assert on the exact frames.
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        const m = raw.match(/event: started\ndata: (\{.*\})\n/);
        if (m && !runId) {
          runId = JSON.parse(m[1]).runId;
          tracker.evaluationRun(runId!);
        }
      }
    } finally {
      clearTimeout(abortTimer);
    }

    expect(runId).toBeTruthy();
    // Terminal event is present and is the LAST frame on the stream.
    const frames = raw.split('\n\n').filter(f => f.trim());
    expect(frames[frames.length - 1]).toMatch(/^event: completed\ndata: /);
    // Every frame is either a real event (`event: x\ndata: {...}`) or a
    // heartbeat comment — nothing the client parser could misread.
    for (const frame of frames) {
      expect(frame).toMatch(/^(event: [a-zA-Z]+\ndata: .*|: ping)$/s);
    }

    if (heartbeatIsLow) {
      const pings = frames.filter(f => f === ': ping').length;
      expect(pings).toBeGreaterThanOrEqual(1);
    }

    // Track the per-case report(s) the run produced so they are deleted too.
    const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`);
    if (runRes.ok) {
      const run = await runRes.json();
      expect(run.status).toBe('completed');
      for (const r of Object.values((run.results || {}) as Record<string, { reportId?: string }>)) {
        if (r?.reportId) tracker.run(r.reportId);
      }
    }
  }, 90_000);
});
