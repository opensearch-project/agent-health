/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * executeEvaluationRun SSE parser — behaviour that the "Add Run stuck on
 * Running…" fix (2026-09-09) depends on:
 *   - `: ping` comment lines (the server's new keep-alive heartbeat) are
 *     ignored, and the `completed` run is still returned;
 *   - a stream that ENDS without `completed` (idle proxy closed it) throws
 *     the existing error, which the page treats as "fall back to polling",
 *     not as a failure;
 *   - `started` still fires first so the page can capture the runId.
 */

import { executeEvaluationRun } from '@/services/client/evaluationRunsApi';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const request = { sources: [{ type: 'benchmark' as const, benchmarkId: 'b1' }], agentKey: 'demo', modelId: 'm' };

describe('executeEvaluationRun SSE parser', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it('ignores `: ping` heartbeat comment lines between events and still resolves the completed run', async () => {
    const completed = { id: 'eval-run-1', status: 'completed', results: {} };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: streamFromChunks([
        sse('started', { runId: 'eval-run-1', testCases: [{ id: 'tc-1', name: 'Case', version: 1 }] }),
        ': ping\n\n',
        ': ping\n\n',
        sse('progress', { runId: 'eval-run-1', testCaseId: 'tc-1', startedCount: 1, completedCount: 0, totalTestCases: 1, status: 'running' }),
        // A heartbeat split across two chunks must also be harmless.
        ': pi', 'ng\n\n',
        sse('completed', completed),
      ]),
    }) as any;
    const onProgress = jest.fn();
    const onStarted = jest.fn();

    await expect(executeEvaluationRun(request, onProgress, onStarted)).resolves.toEqual(completed);
    expect(onStarted).toHaveBeenCalledWith({ runId: 'eval-run-1', testCases: [{ id: 'tc-1', name: 'Case', version: 1 }] });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('a trailing heartbeat with no terminating blank line is ignored too (no bogus parse, no throw on that alone)', async () => {
    const completed = { id: 'eval-run-2', status: 'completed', results: {} };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: streamFromChunks([sse('completed', completed), ': ping']),
    }) as any;
    await expect(executeEvaluationRun(request, jest.fn())).resolves.toEqual(completed);
  });

  it('throws the "completed without returning result" error when the stream ends after `started` with no `completed` (the dropped-connection case)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: streamFromChunks([
        sse('started', { runId: 'eval-run-3', testCases: [] }),
        ': ping\n\n',
        sse('progress', { runId: 'eval-run-3', testCaseId: 'tc-1', startedCount: 1, completedCount: 0, totalTestCases: 3, status: 'running' }),
      ]),
    }) as any;
    const onStarted = jest.fn();

    await expect(executeEvaluationRun(request, jest.fn(), onStarted))
      .rejects.toThrow('Evaluation run completed without returning result');
    // The page relies on `started` having fired BEFORE the throw so it can
    // hand the run over to polling by runId.
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ runId: 'eval-run-3' }));
  });

  it('rejects with the server error message on an `error` event', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: streamFromChunks([sse('error', { error: 'Benchmark not found: b1' })]),
    }) as any;
    await expect(executeEvaluationRun(request, jest.fn())).rejects.toThrow('Benchmark not found: b1');
  });

  it('rejects when the POST itself is not ok (no runId is ever produced)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, statusText: 'Bad Request', json: async () => ({ error: 'agentKey is required' }),
    }) as any;
    const onStarted = jest.fn();
    await expect(executeEvaluationRun(request, jest.fn(), onStarted)).rejects.toThrow('agentKey is required');
    expect(onStarted).not.toHaveBeenCalled();
  });
});
