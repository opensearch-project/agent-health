/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Response } from 'express';
import {
  setSSEHeaders,
  sendErrorEvent,
  validateAgentRequest,
  proxyAgentRequest,
  AgentProxyRequest,
} from '@/server/services/agentService';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Helper to create mock response
function createMockResponse() {
  const res = {
    setHeader: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('AgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('setSSEHeaders', () => {
    it('should set correct SSE headers', () => {
      const res = createMockResponse();

      setSSEHeaders(res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    });
  });

  describe('sendErrorEvent', () => {
    it('should write error event and end response', () => {
      const res = createMockResponse();
      const errorMessage = 'Test error message';

      sendErrorEvent(res, errorMessage);

      expect(res.write).toHaveBeenCalledTimes(1);
      const written = (res.write as jest.Mock).mock.calls[0][0];
      expect(written).toContain('data: ');
      expect(written).toContain('RUN_ERROR');
      expect(written).toContain(errorMessage);
      expect(res.end).toHaveBeenCalled();
    });

    it('should include timestamp in error event', () => {
      const res = createMockResponse();
      const beforeTime = Date.now();

      sendErrorEvent(res, 'error');

      const written = (res.write as jest.Mock).mock.calls[0][0];
      const eventData = JSON.parse(written.replace('data: ', '').replace('\n\n', ''));
      expect(eventData.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(eventData.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('validateAgentRequest', () => {
    it('should return valid: false when endpoint is missing', () => {
      const result = validateAgentRequest({ payload: {} });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('endpoint');
    });

    it('should return valid: false when payload is missing', () => {
      const result = validateAgentRequest({ endpoint: 'http://localhost:3000' });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('payload');
    });

    it('should return valid: true when both endpoint and payload are present', () => {
      const result = validateAgentRequest({
        endpoint: 'http://localhost:3000/api/agent',
        payload: { question: 'test' },
      });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept additional headers', () => {
      const result = validateAgentRequest({
        endpoint: 'http://localhost:3000/api/agent',
        payload: { question: 'test' },
        headers: { Authorization: 'Bearer token' },
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('proxyAgentRequest', () => {
    it('should set SSE headers on response', async () => {
      // Use mock:// endpoint for demo mode
      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'mock://demo-agent',
        payload: { question: 'test' },
      };

      await proxyAgentRequest(request, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    });

    it('should use mock agent when endpoint starts with mock://', async () => {
      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'mock://demo-agent',
        payload: { question: 'test' },
      };

      await proxyAgentRequest(request, res);

      // Should not call fetch for mock endpoint
      expect(mockFetch).not.toHaveBeenCalled();
      // Should write events
      expect(res.write).toHaveBeenCalled();
      // Should end the response
      expect(res.end).toHaveBeenCalled();
    });

    it('should stream RUN_STARTED and RUN_FINISHED events in mock mode', async () => {
      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'mock://demo-agent',
        payload: { question: 'test' },
      };

      await proxyAgentRequest(request, res);

      const writeCalls = (res.write as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      const hasRunStarted = writeCalls.some((call: string) => call.includes('RUN_STARTED'));
      const hasRunFinished = writeCalls.some((call: string) => call.includes('RUN_FINISHED'));

      expect(hasRunStarted).toBe(true);
      expect(hasRunFinished).toBe(true);
    });

    it('should send error event when agent returns error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });
      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'http://localhost:3000/api/agent',
        payload: { question: 'test' },
      };

      await proxyAgentRequest(request, res);

      const writeCalls = (res.write as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      const hasErrorEvent = writeCalls.some((call: string) => call.includes('RUN_ERROR'));
      expect(hasErrorEvent).toBe(true);
    });

    it('should send error event when no response body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: null,
        headers: new Map([['content-type', 'text/event-stream']]),
      });
      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'http://localhost:3000/api/agent',
        payload: { question: 'test' },
      };

      await proxyAgentRequest(request, res);

      const writeCalls = (res.write as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      const hasErrorEvent = writeCalls.some((call: string) => call.includes('RUN_ERROR'));
      expect(hasErrorEvent).toBe(true);
    });

    it('should stream response from agent endpoint', async () => {
      // Create a mock ReadableStream reader
      const chunks = [
        new TextEncoder().encode('data: {"type":"RUN_STARTED"}\n\n'),
        new TextEncoder().encode('data: {"type":"RUN_FINISHED"}\n\n'),
      ];
      let chunkIndex = 0;
      const mockReader = {
        read: jest.fn().mockImplementation(() => {
          if (chunkIndex < chunks.length) {
            return Promise.resolve({ done: false, value: chunks[chunkIndex++] });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        releaseLock: jest.fn(),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => mockReader },
        headers: new Map([['content-type', 'text/event-stream']]),
      });

      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'http://localhost:3000/api/agent',
        payload: { question: 'test' },
      };

      await proxyAgentRequest(request, res);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          }),
        })
      );
      expect(res.write).toHaveBeenCalledTimes(2);
      expect(mockReader.releaseLock).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it('should include custom headers in request', async () => {
      const mockReader = {
        read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
        releaseLock: jest.fn(),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => mockReader },
        headers: new Map([['content-type', 'text/event-stream']]),
      });

      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'http://localhost:3000/api/agent',
        payload: { question: 'test' },
        headers: { Authorization: 'Bearer token123' },
      };

      await proxyAgentRequest(request, res);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token123',
          }),
        })
      );
    });

    it('should handle stream errors gracefully', async () => {
      const mockReader = {
        read: jest.fn().mockRejectedValue(new Error('Stream error')),
        releaseLock: jest.fn(),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => mockReader },
        headers: new Map([['content-type', 'text/event-stream']]),
      });

      const res = createMockResponse();
      const request: AgentProxyRequest = {
        endpoint: 'http://localhost:3000/api/agent',
        payload: { question: 'test' },
      };

      // Should not throw
      await proxyAgentRequest(request, res);

      expect(mockReader.releaseLock).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });
  });
});
