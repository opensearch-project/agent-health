/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for apiClient fixes:
 * 1. Null check for res.body before calling getReader()
 * 2. SSE reader cleanup on error (reader.cancel() in finally block)
 */

import { ApiClient } from '@/cli/utils/apiClient';

describe('ApiClient - Null Body and SSE Cleanup Fixes', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('executeBenchmark - null body check', () => {
    it('should throw error when response body is null', async () => {
      // Mock fetch to return response with null body
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: null, // Null body - this is what we're testing
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');

      await expect(
        client.executeBenchmark('bench-123', { name: 'test', agentKey: 'demo', modelId: 'test' })
      ).rejects.toThrow('Response body is missing');
    });

    it('should throw error when response body is undefined', async () => {
      // Mock fetch to return response with undefined body
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: undefined,
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');

      await expect(
        client.executeBenchmark('bench-123', { name: 'test', agentKey: 'demo', modelId: 'test' })
      ).rejects.toThrow('Response body is missing');
    });
  });

  describe('runEvaluation - null body check', () => {
    it('should throw error when response body is null', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: null,
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');

      await expect(
        client.runEvaluation('tc-123', 'demo', 'model-1')
      ).rejects.toThrow('Response body is missing');
    });
  });

  describe('executeBenchmark - SSE reader cleanup', () => {
    it('should cancel reader when stream completes normally', async () => {
      const mockCancel = jest.fn().mockResolvedValue(undefined);
      const mockRead = jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"type":"started","runId":"run-1","testCases":[]}\n\n'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"type":"completed","run":{"id":"run-1","status":"completed"}}\n\n'),
        })
        .mockResolvedValueOnce({ done: true, value: undefined });

      const mockReader = {
        read: mockRead,
        cancel: mockCancel,
        releaseLock: jest.fn(),
      };

      const mockBody = {
        getReader: jest.fn().mockReturnValue(mockReader),
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');
      await client.executeBenchmark('bench-123', { name: 'test', agentKey: 'demo', modelId: 'test' });

      // Reader should be cancelled in finally block
      expect(mockCancel).toHaveBeenCalled();
    });

    it('should cancel reader when stream throws error before started event', async () => {
      // Test error BEFORE started event (no runId captured, so no polling fallback)
      const mockCancel = jest.fn().mockResolvedValue(undefined);
      const mockRead = jest.fn()
        .mockRejectedValueOnce(new Error('Stream connection lost'));

      const mockReader = {
        read: mockRead,
        cancel: mockCancel,
        releaseLock: jest.fn(),
      };

      const mockBody = {
        getReader: jest.fn().mockReturnValue(mockReader),
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');

      // Should throw, but reader should still be cancelled
      await expect(
        client.executeBenchmark('bench-123', { name: 'test', agentKey: 'demo', modelId: 'test' })
      ).rejects.toThrow('Stream connection lost');

      // Reader should be cancelled even on error
      expect(mockCancel).toHaveBeenCalled();
    });

    it('should handle cancel throwing error gracefully', async () => {
      const mockCancel = jest.fn().mockRejectedValue(new Error('Cancel failed'));
      const mockRead = jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"type":"started","runId":"run-1","testCases":[]}\n\n'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"type":"completed","run":{"id":"run-1","status":"completed"}}\n\n'),
        })
        .mockResolvedValueOnce({ done: true, value: undefined });

      const mockReader = {
        read: mockRead,
        cancel: mockCancel,
        releaseLock: jest.fn(),
      };

      const mockBody = {
        getReader: jest.fn().mockReturnValue(mockReader),
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');

      // Should not throw even if cancel fails
      const result = await client.executeBenchmark('bench-123', { name: 'test', agentKey: 'demo', modelId: 'test' });

      expect(result).toBeDefined();
      expect(mockCancel).toHaveBeenCalled();
    });
  });

  describe('runEvaluation - SSE reader cleanup', () => {
    it('should cancel reader when stream completes normally', async () => {
      const mockCancel = jest.fn().mockResolvedValue(undefined);
      const mockRead = jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"type":"started","testCase":"tc-1","agent":"demo"}\n\n'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"type":"completed","report":{"id":"r-1","status":"completed","trajectorySteps":5}}\n\n'),
        })
        .mockResolvedValueOnce({ done: true, value: undefined });

      const mockReader = {
        read: mockRead,
        cancel: mockCancel,
        releaseLock: jest.fn(),
      };

      const mockBody = {
        getReader: jest.fn().mockReturnValue(mockReader),
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');
      await client.runEvaluation('tc-123', 'demo', 'model-1');

      expect(mockCancel).toHaveBeenCalled();
    });

    it('should cancel reader when error event received', async () => {
      const mockCancel = jest.fn().mockResolvedValue(undefined);
      const mockRead = jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"type":"error","error":"Something went wrong"}\n\n'),
        })
        .mockResolvedValueOnce({ done: true, value: undefined });

      const mockReader = {
        read: mockRead,
        cancel: mockCancel,
        releaseLock: jest.fn(),
      };

      const mockBody = {
        getReader: jest.fn().mockReturnValue(mockReader),
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
        headers: new Headers(),
      });

      const client = new ApiClient('http://localhost:4001');

      await expect(
        client.runEvaluation('tc-123', 'demo', 'model-1')
      ).rejects.toThrow('Something went wrong');

      // Reader should still be cancelled
      expect(mockCancel).toHaveBeenCalled();
    });
  });
});
