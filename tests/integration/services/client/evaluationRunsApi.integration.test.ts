/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  executeEvaluationRun,
  listEvaluationRuns,
  getEvaluationRun,
  cancelEvaluationRun,
  deleteEvaluationRun,
  promoteEvaluationRun,
  updateEvaluationRun,
  CreateEvaluationRunRequest,
} from '@/services/client/evaluationRunsApi';

/**
 * Helper to create a ReadableStream that emits SSE-formatted events.
 */
function createSSEStream(events: Array<{ event: string; data: any }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const { event, data } of events) {
        const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function mockFetchResponse(body: any, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const { ok = true, status = 200, statusText = 'OK' } = options;
  return Promise.resolve({
    ok,
    status,
    statusText,
    json: () => Promise.resolve(body),
    body: null,
  } as unknown as Response);
}

function mockFetchSSEResponse(stream: ReadableStream<Uint8Array>, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const { ok = true, status = 200, statusText = 'OK' } = options;
  return Promise.resolve({
    ok,
    status,
    statusText,
    json: () => Promise.resolve({}),
    body: stream,
  } as unknown as Response);
}

describe('evaluationRunsApi', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('executeEvaluationRun', () => {
    const baseRequest: CreateEvaluationRunRequest = {
      name: 'Test Run',
      sources: [{ type: 'testCaseIds', testCaseIds: ['tc-1', 'tc-2'] }],
      agentKey: 'test-agent',
      modelId: 'claude-sonnet-4',
    };

    it('processes SSE stream with started, progress, testCaseComplete, and completed events', async () => {
      const completedRun = { id: 'r1', name: 'Test Run', status: 'completed' };
      const stream = createSSEStream([
        { event: 'started', data: { runId: 'r1', testCases: [{ id: 'tc-1' }, { id: 'tc-2' }] } },
        { event: 'progress', data: { runId: 'r1', testCaseId: 'tc-1', startedCount: 1, completedCount: 0, totalTestCases: 2, status: 'running' } },
        { event: 'testCaseComplete', data: { testCaseId: 'tc-1', result: { passed: true } } },
        { event: 'progress', data: { runId: 'r1', testCaseId: 'tc-2', startedCount: 2, completedCount: 1, totalTestCases: 2, status: 'running' } },
        { event: 'testCaseComplete', data: { testCaseId: 'tc-2', result: { passed: false } } },
        { event: 'completed', data: completedRun },
      ]);

      global.fetch = jest.fn().mockReturnValue(mockFetchSSEResponse(stream));

      const onProgress = jest.fn();
      const onStarted = jest.fn();
      const onTestCaseComplete = jest.fn();

      const result = await executeEvaluationRun(baseRequest, onProgress, onStarted, onTestCaseComplete);

      expect(result).toEqual(completedRun);
      expect(onStarted).toHaveBeenCalledWith({ runId: 'r1', testCases: [{ id: 'tc-1' }, { id: 'tc-2' }] });
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onTestCaseComplete).toHaveBeenCalledTimes(2);
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', { passed: true });
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-2', { passed: false });

      expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseRequest),
      });
    });

    it('throws when SSE stream contains an error event', async () => {
      const stream = createSSEStream([
        { event: 'started', data: { runId: 'r1', testCases: [] } },
        { event: 'error', data: { error: 'Agent timeout exceeded' } },
      ]);

      global.fetch = jest.fn().mockReturnValue(mockFetchSSEResponse(stream));

      await expect(executeEvaluationRun(baseRequest, jest.fn())).rejects.toThrow('Agent timeout exceeded');
    });

    it('throws "No response body" when response has no body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: null,
        json: () => Promise.resolve({}),
      } as unknown as Response);

      await expect(executeEvaluationRun(baseRequest, jest.fn())).rejects.toThrow('No response body');
    });

    it('throws with error message on non-ok HTTP response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: 'Invalid agent key' }),
      } as unknown as Response);

      await expect(executeEvaluationRun(baseRequest, jest.fn())).rejects.toThrow('Invalid agent key');
    });

    it('throws when stream ends without a completed event', async () => {
      const stream = createSSEStream([
        { event: 'started', data: { runId: 'r1', testCases: [] } },
        { event: 'progress', data: { runId: 'r1', testCaseId: 'tc-1', startedCount: 1, completedCount: 0, totalTestCases: 1, status: 'running' } },
      ]);

      global.fetch = jest.fn().mockReturnValue(mockFetchSSEResponse(stream));

      await expect(executeEvaluationRun(baseRequest, jest.fn())).rejects.toThrow('completed without returning result');
    });
  });

  describe('listEvaluationRuns', () => {
    it('constructs query params correctly from options', async () => {
      const mockResponse = { evaluationRuns: [], total: 0 };
      global.fetch = jest.fn().mockReturnValue(mockFetchResponse(mockResponse));

      const result = await listEvaluationRuns({
        benchmarkId: 'b-1',
        agentKey: 'test-agent',
        status: 'completed',
        from: 0,
        size: 10,
      });

      expect(result).toEqual(mockResponse);
      const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(calledUrl).toContain('benchmarkId=b-1');
      expect(calledUrl).toContain('agentKey=test-agent');
      expect(calledUrl).toContain('status=completed');
      expect(calledUrl).toContain('from=0');
      expect(calledUrl).toContain('size=10');
    });

    it('sends no query string when no options are provided', async () => {
      const mockResponse = { evaluationRuns: [{ id: 'r1' }], total: 1 };
      global.fetch = jest.fn().mockReturnValue(mockFetchResponse(mockResponse));

      const result = await listEvaluationRuns();

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs');
    });
  });

  describe('getEvaluationRun', () => {
    it('returns parsed JSON for a valid run', async () => {
      const run = { id: 'r1', name: 'Test', status: 'completed' };
      global.fetch = jest.fn().mockReturnValue(mockFetchResponse(run));

      const result = await getEvaluationRun('r1');

      expect(result).toEqual(run);
      expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs/r1');
    });

    it('throws on non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ error: 'Not found' }),
      } as unknown as Response);

      await expect(getEvaluationRun('nonexistent')).rejects.toThrow('Failed to get evaluation run: Not Found');
    });
  });

  describe('cancelEvaluationRun', () => {
    it('returns true on successful cancellation', async () => {
      global.fetch = jest.fn().mockReturnValue(mockFetchResponse({ success: true }));

      const result = await cancelEvaluationRun('r1');

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs/r1/cancel', {
        method: 'POST',
      });
    });

    it('throws with error message on non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: () => Promise.resolve({ error: 'Run already completed' }),
      } as unknown as Response);

      await expect(cancelEvaluationRun('r1')).rejects.toThrow('Run already completed');
    });
  });

  describe('deleteEvaluationRun', () => {
    it('returns true on successful deletion', async () => {
      global.fetch = jest.fn().mockReturnValue(mockFetchResponse({ success: true }));

      const result = await deleteEvaluationRun('r1');

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs/r1', {
        method: 'DELETE',
      });
    });
  });

  describe('promoteEvaluationRun', () => {
    it('sends benchmarkName in body and returns result', async () => {
      const promoteResult = { benchmark: { id: 'b-new', name: 'Promoted' }, run: { id: 'r1', status: 'completed' } };
      global.fetch = jest.fn().mockReturnValue(mockFetchResponse(promoteResult));

      const result = await promoteEvaluationRun('r1', 'Promoted Benchmark');

      expect(result).toEqual(promoteResult);
      expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs/r1/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ benchmarkName: 'Promoted Benchmark' }),
      });
    });
  });

  describe('updateEvaluationRun', () => {
    it('sends PATCH with partial updates and returns updated run', async () => {
      const updatedRun = { id: 'r1', name: 'Renamed Run', status: 'completed' };
      global.fetch = jest.fn().mockReturnValue(mockFetchResponse(updatedRun));

      const result = await updateEvaluationRun('r1', { name: 'Renamed Run' } as any);

      expect(result).toEqual(updatedRun);
      expect(global.fetch).toHaveBeenCalledWith('/api/storage/evaluation-runs/r1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Run' }),
      });
    });

    it('surfaces the server\'s validation error message on a 400 (not a generic statusText)', async () => {
      // Regression: this previously discarded the response body and threw
      // `Failed to update evaluation run: ${statusText}` ("Bad Request") —
      // the rename UI's inline error text (see InlineRenameField.tsx) would
      // show that generic string instead of e.g. "name must not be empty",
      // even though the route already returns a specific { error } message.
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: 'name must not be empty' }),
      } as unknown as Response);

      await expect(updateEvaluationRun('r1', { name: '' } as any)).rejects.toThrow('name must not be empty');
    });

    it('falls back to the response statusText when the error response has no JSON body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('not json')),
      } as unknown as Response);

      await expect(updateEvaluationRun('r1', { name: 'x' } as any)).rejects.toThrow('Internal Server Error');
    });
  });
});
