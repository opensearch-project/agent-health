/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import { runServerEvaluation } from '@/services/client/evaluationApi';
import type { TrajectoryStep, TestCase } from '@/types';

// Helper to create a mock ReadableStream from SSE data chunks
function createMockSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

// Helper to format SSE data
function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

describe('evaluationApi', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('runServerEvaluation', () => {
    const mockReport = {
      id: 'report-123',
      status: 'completed',
      passFailStatus: 'passed',
      metrics: { accuracy: 85 },
      trajectorySteps: 3,
      llmJudgeReasoning: 'Good performance',
    };

    it('should execute evaluation and return completed result', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test Case 1', agent: 'Test Agent' }),
        sseData({
          type: 'step',
          stepIndex: 0,
          step: { id: 's1', type: 'thinking', content: 'Analyzing...', timestamp: Date.now() },
        }),
        sseData({
          type: 'step',
          stepIndex: 1,
          step: { id: 's2', type: 'response', content: 'Done', timestamp: Date.now() },
        }),
        sseData({ type: 'completed', reportId: 'report-123', report: mockReport }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onStep = jest.fn();
      const result = await runServerEvaluation(
        { agentKey: 'test-agent', modelId: 'claude-sonnet', testCaseId: 'tc-1' },
        onStep
      );

      expect(global.fetch).toHaveBeenCalledWith('/api/evaluate', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));

      expect(onStep).toHaveBeenCalledTimes(2);
      expect(onStep).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'thinking', content: 'Analyzing...' })
      );

      expect(result.reportId).toBe('report-123');
      expect(result.report).toEqual(mockReport);
    });

    it('should support inline test case in request body', async () => {
      const inlineTestCase: TestCase = {
        id: 'adhoc-1',
        name: 'Ad-hoc Test',
        description: 'test',
        labels: [],
        category: 'Ad-hoc',
        difficulty: 'Medium',
        currentVersion: 1,
        versions: [],
        isPromoted: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        initialPrompt: 'test prompt',
        context: [],
      };

      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Ad-hoc Test', agent: 'Test Agent' }),
        sseData({ type: 'completed', reportId: 'report-456', report: mockReport }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const result = await runServerEvaluation({
        agentKey: 'test-agent',
        modelId: 'claude-sonnet',
        testCase: inlineTestCase,
      });

      // Verify the inline test case was sent in the request body
      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.testCase).toBeDefined();
      expect(body.testCase.id).toBe('adhoc-1');
      expect(body.testCaseId).toBeUndefined();

      expect(result.reportId).toBe('report-456');
    });

    it('should throw on HTTP error with JSON error body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
        json: jest.fn().mockResolvedValue({ error: 'Agent not found: unknown-agent' }),
      });

      await expect(
        runServerEvaluation({ agentKey: 'unknown-agent', modelId: 'test', testCaseId: 'tc-1' })
      ).rejects.toThrow('Agent not found: unknown-agent');
    });

    it('should throw on HTTP error when JSON parsing fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
      });

      await expect(
        runServerEvaluation({ agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' })
      ).rejects.toThrow('Internal Server Error');
    });

    it('should throw when no response body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: null,
      });

      await expect(
        runServerEvaluation({ agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' })
      ).rejects.toThrow('No response body');
    });

    it('should throw on SSE error event', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent' }),
        sseData({ type: 'error', error: 'Connector execution failed' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      await expect(
        runServerEvaluation({ agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' })
      ).rejects.toThrow('Connector execution failed');
    });

    it('should throw when stream ends without completed event', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent' }),
        sseData({ type: 'step', stepIndex: 0, step: { type: 'thinking', content: 'hmm' } }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      await expect(
        runServerEvaluation({ agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' })
      ).rejects.toThrow('Evaluation completed without returning result');
    });

    it('should handle incomplete JSON chunks gracefully', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent' }),
        'data: {"type": "ste', // Incomplete JSON
        'p", "stepIndex": 0, "step": {"type": "thinking", "content": "test"}}\n\n', // Rest of JSON
        sseData({ type: 'completed', reportId: 'report-789', report: mockReport }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onStep = jest.fn();
      const result = await runServerEvaluation(
        { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' },
        onStep
      );

      expect(result.reportId).toBe('report-789');
    });

    it('should process completed event in remaining buffer', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent' }),
        `data: ${JSON.stringify({ type: 'completed', reportId: 'report-buf', report: mockReport })}`, // No trailing \n\n
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const result = await runServerEvaluation(
        { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' }
      );

      expect(result.reportId).toBe('report-buf');
    });

    it('should work without onStep callback', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent' }),
        sseData({ type: 'step', stepIndex: 0, step: { type: 'thinking', content: 'test' } }),
        sseData({ type: 'completed', reportId: 'report-no-cb', report: mockReport }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      // Should not throw when no onStep callback provided
      const result = await runServerEvaluation(
        { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' }
      );

      expect(result.reportId).toBe('report-no-cb');
    });

    it('should throw on error event in remaining buffer', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent' }),
        `data: ${JSON.stringify({ type: 'error', error: 'Buffer error' })}`, // No trailing \n\n
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      await expect(
        runServerEvaluation({ agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' })
      ).rejects.toThrow('Buffer error');
    });
  });

  describe('runServerEvaluation - SSE disconnect recovery', () => {
    const mockReport = {
      id: 'report-recover',
      status: 'completed',
      passFailStatus: 'passed',
      metrics: { accuracy: 91 },
      trajectorySteps: 2,
      llmJudgeReasoning: 'Recovered via polling',
    };

    function streamThatErrors(events: any[], errorAfter: number): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= errorAfter) {
            controller.error(new Error('network disconnect'));
            return;
          }
          if (i < events.length) {
            controller.enqueue(encoder.encode(sseData(events[i])));
            i++;
          } else {
            controller.close();
          }
        },
      });
    }

    it('should fall back to polling when SSE drops after started event', async () => {
      const sseStream = streamThatErrors(
        [
          { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-recover' },
          { type: 'step', stepIndex: 0, step: { type: 'action', content: 'doing' } },
        ],
        2,
      );

      // First call: SSE; subsequent: storage polling.
      let pollCount = 0;
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, body: sseStream })
        .mockImplementation(() => {
          pollCount++;
          const status = pollCount >= 2 ? 'completed' : 'running';
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              id: 'report-recover',
              status,
              passFailStatus: status === 'completed' ? 'passed' : undefined,
              metrics: { accuracy: 91 },
              trajectory: [{ type: 'action' }, { type: 'response' }],
              llmJudgeReasoning: 'Recovered via polling',
            }),
          });
        });

      const onReconnect = jest.fn();
      const onPoll = jest.fn();

      const result = await runServerEvaluation(
        { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' },
        { onReconnect, onPoll },
      );

      expect(onReconnect).toHaveBeenCalledWith('report-recover', expect.any(String));
      expect(onPoll.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(result.reportId).toBe('report-recover');
      expect(result.report.status).toBe('completed');
      expect(result.report.passFailStatus).toBe('passed');
    }, 30000);

    it('should NOT poll if a server error event arrived before the stream dropped', async () => {
      // Server explicitly told us this failed — polling would be wrong.
      const sseStream = streamThatErrors(
        [
          { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-x' },
          { type: 'error', error: 'Agent endpoint unreachable' },
        ],
        2,
      );

      global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, body: sseStream });

      const onReconnect = jest.fn();
      await expect(
        runServerEvaluation(
          { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' },
          { onReconnect },
        ),
      ).rejects.toThrow('Agent endpoint unreachable');
      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('should ignore heartbeat events when computing the result', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-hb' }),
        sseData({ type: 'heartbeat' }),
        sseData({ type: 'step', stepIndex: 0, step: { type: 'action', content: 'x' } }),
        sseData({ type: 'heartbeat' }),
        sseData({ type: 'completed', reportId: 'report-hb', report: { ...mockReport, id: 'report-hb' } }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({ ok: true, body: mockStream });

      const onStep = jest.fn();
      const result = await runServerEvaluation(
        { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' },
        { onStep },
      );

      // Heartbeats should not show up as steps
      expect(onStep).toHaveBeenCalledTimes(1);
      expect(result.reportId).toBe('report-hb');
    });

    it('should poll when the stream ends without a completed event', async () => {
      const sseStream = createMockSSEStream([
        sseData({ type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-noend' }),
        sseData({ type: 'step', stepIndex: 0, step: { type: 'action', content: 'x' } }),
        // No completed event
      ]);

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, body: sseStream })
        .mockImplementation(() => Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'report-noend',
            status: 'completed',
            passFailStatus: 'failed',
            metrics: { accuracy: 30 },
            trajectory: [{ type: 'action' }],
            llmJudgeReasoning: 'Incomplete on stream side',
          }),
        }));

      const result = await runServerEvaluation(
        { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' },
      );
      expect(result.reportId).toBe('report-noend');
      expect(result.report.passFailStatus).toBe('failed');
    });

    it('should return cached completed result if stream errors AFTER completion', async () => {
      // Edge case: server sent completed, then TCP RST before EOF.
      // We must not throw — the result is valid.
      const sseStream = streamThatErrors(
        [
          { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-late' },
          { type: 'completed', reportId: 'report-late', report: { ...mockReport, id: 'report-late' } },
        ],
        2,
      );

      global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, body: sseStream });

      const result = await runServerEvaluation(
        { agentKey: 'test', modelId: 'test', testCaseId: 'tc-1' },
      );
      expect(result.reportId).toBe('report-late');
    });
  });
});
