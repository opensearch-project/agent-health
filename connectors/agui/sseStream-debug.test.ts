/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for SSE stream debugging enhancements
 */

import { jest } from '@jest/globals';

// Mock debug function
const mockDebug = jest.fn();
jest.mock('@/lib/debug', () => ({
  debug: mockDebug,
  isDebugEnabled: jest.fn().mockReturnValue(false),
}));

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('SSEClient Debug Enhancements', () => {
  let SSEClient: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await import('@/connectors/agui/sseStream');
    SSEClient = module.SSEClient;
  });

  describe('Request logging', () => {
    it('should log request configuration with headers', async () => {
      const client = new SSEClient();

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
          }),
        },
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const headers = {
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'value',
      };

      await client.consume({
        url: 'http://test.com/stream',
        method: 'POST',
        headers,
        body: { test: 'data' },
      });

      // Verify debug logs include headers
      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Headers:', expect.any(Object));
      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Timeout:', expect.any(Number), 'ms');
      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Request config:', expect.stringContaining('POST'));
    });

    it('should log response status', async () => {
      const client = new SSEClient();

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
          getReader: () => ({
            read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
          }),
        },
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      await client.consume({
        url: 'http://test.com/stream',
      });

      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Response received:', 200, 'OK');
    });
  });

  describe('Error logging and diagnostics', () => {
    it('should log detailed error information', async () => {
      const client = new SSEClient();

      const error = new Error('Connection failed');
      error.name = 'FetchError';
      (error as any).cause = 'ECONNREFUSED';

      mockFetch.mockRejectedValueOnce(error);

      const onError = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        onError,
      });

      // Verify detailed error logging
      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Error details:', expect.objectContaining({
        name: 'FetchError',
        message: 'Connection failed',
        cause: 'ECONNREFUSED',
      }));

      expect(onError).toHaveBeenCalled();
    });

    it('should provide diagnostic hint for "fetch failed" error', async () => {
      const client = new SSEClient();

      const error = new Error('fetch failed');
      mockFetch.mockRejectedValueOnce(error);

      await client.consume({
        url: 'http://test.com/stream',
        onError: jest.fn(),
      });

      // Verify diagnostic hints were logged
      expect(mockDebug).toHaveBeenCalledWith('SSE', '💡 Diagnostic: "fetch failed" typically means:');
      expect(mockDebug).toHaveBeenCalledWith('SSE', expect.stringContaining('Connection refused'));
      expect(mockDebug).toHaveBeenCalledWith('SSE', expect.stringContaining('DNS resolution failed'));
      expect(mockDebug).toHaveBeenCalledWith('SSE', expect.stringContaining('SSL/TLS certificate issues'));
    });

    it('should provide diagnostic hint for timeout error', async () => {
      const client = new SSEClient();

      const error = new Error('Request timeout');
      mockFetch.mockRejectedValueOnce(error);

      await client.consume({
        url: 'http://test.com/stream',
        onError: jest.fn(),
      });

      expect(mockDebug).toHaveBeenCalledWith('SSE', expect.stringContaining('Request timed out'));
    });

    it('should provide diagnostic hint for ENOTFOUND error', async () => {
      const client = new SSEClient();

      const error = new Error('getaddrinfo ENOTFOUND test.com');
      mockFetch.mockRejectedValueOnce(error);

      await client.consume({
        url: 'http://test.com/stream',
        onError: jest.fn(),
      });

      expect(mockDebug).toHaveBeenCalledWith('SSE', expect.stringContaining('DNS lookup failed'));
    });

    it('should provide diagnostic hint for ECONNREFUSED error', async () => {
      const client = new SSEClient();

      const error = new Error('connect ECONNREFUSED 127.0.0.1:8080');
      mockFetch.mockRejectedValueOnce(error);

      await client.consume({
        url: 'http://127.0.0.1:8080/stream',
        onError: jest.fn(),
      });

      expect(mockDebug).toHaveBeenCalledWith('SSE', expect.stringContaining('Connection refused'));
      expect(mockDebug).toHaveBeenCalledWith('SSE', expect.stringContaining('service not listening'));
    });

    it('should log error response body for non-ok responses', async () => {
      const client = new SSEClient();

      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Detailed error message from server',
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const onError = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        onError,
      });

      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Error response body:', expect.stringContaining('Detailed error message'));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Internal Server Error'),
      }));
    });

    it('should handle error response body read failure', async () => {
      const client = new SSEClient();

      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => {
          throw new Error('Cannot read body');
        },
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      await client.consume({
        url: 'http://test.com/stream',
        onError: jest.fn(),
      });

      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Could not read error response body');
    });
  });

  describe('Unknown error handling', () => {
    it('should handle unknown error types', async () => {
      const client = new SSEClient();

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: jest.fn().mockReturnValue('text/event-stream'),
        },
        body: {
          getReader: () => ({
            read: jest.fn().mockRejectedValueOnce('string error'),
            releaseLock: jest.fn(),
          }),
        },
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const onError = jest.fn();
      const onEvent = jest.fn();
      const onComplete = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        onEvent,
        onError,
        onComplete,
      });

      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Unknown error details:', 'string error');
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Unknown error occurred',
      }));
    });
  });

  describe('Success path logging', () => {
    it('should not spam logs on successful connection', async () => {
      const client = new SSEClient();

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: test\n\n') })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      };

      mockFetch.mockResolvedValueOnce(mockResponse);

      const onEvent = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        onEvent,
      });

      // Basic connection logs should exist
      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Connecting to', 'http://test.com/stream');
      expect(mockDebug).toHaveBeenCalledWith('SSE', 'Response received:', 200, 'OK');

      // But not excessive logging
      const debugCalls = mockDebug.mock.calls.filter((call) => call[0] === 'SSE');
      expect(debugCalls.length).toBeLessThan(20); // Reasonable threshold
    });
  });
});
