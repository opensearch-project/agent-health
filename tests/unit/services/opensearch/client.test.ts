/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { openSearchClient } from '@/services/opensearch';

describe('OpenSearchClient', () => {
  let originalFetch: typeof global.fetch;
  let consoleInfoSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleInfoSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('fetchLogs', () => {
    it('should fetch logs with default parameters', async () => {
      const mockLogs = [
        { timestamp: '2024-01-01T00:00:00Z', message: 'log 1' },
        { timestamp: '2024-01-01T00:01:00Z', message: 'log 2' },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ total: 2, logs: mockLogs }),
      });

      const logs = await openSearchClient.fetchLogs();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/logs'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
      expect(logs).toEqual(mockLogs);
    });

    it('should use custom parameters when provided', async () => {
      const customStartTime = new Date('2024-01-01T00:00:00Z');
      const customEndTime = new Date('2024-01-01T01:00:00Z');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ total: 0, logs: [] }),
      });

      await openSearchClient.fetchLogs({
        startTime: customStartTime,
        endTime: customEndTime,
        query: 'error',
        size: 50,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"query":"error"'),
        })
      );

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.startTime).toBe(customStartTime.getTime());
      expect(callBody.endTime).toBe(customEndTime.getTime());
      expect(callBody.size).toBe(50);
    });

    it('should throw error on HTTP error response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });

      await expect(openSearchClient.fetchLogs()).rejects.toThrow(
        'OpenSearch query failed (500): Internal Server Error'
      );
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle fetch errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(openSearchClient.fetchLogs()).rejects.toThrow(
        'Failed to fetch logs: Network error'
      );
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle non-Error exceptions', async () => {
      global.fetch = jest.fn().mockRejectedValue('Unknown error string');

      await expect(openSearchClient.fetchLogs()).rejects.toThrow(
        'Failed to fetch logs: Unknown error'
      );
    });

    it('should return empty array when logs not present in response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ total: 0 }), // No logs field
      });

      const logs = await openSearchClient.fetchLogs();

      expect(logs).toEqual([]);
    });
  });

  describe('fetchLogsForRun', () => {
    it('should fetch logs for a specific run ID', async () => {
      const mockLogs = [{ timestamp: '2024-01-01T00:00:00Z', message: 'run log' }];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ total: 1, logs: mockLogs }),
      });

      const logs = await openSearchClient.fetchLogsForRun('run-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"runId":"run-123"'),
        })
      );
      expect(logs).toEqual(mockLogs);
    });

    it('should use custom parameters when provided', async () => {
      const customStartTime = new Date('2024-01-01T00:00:00Z');
      const customEndTime = new Date('2024-01-01T01:00:00Z');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ total: 0, logs: [] }),
      });

      await openSearchClient.fetchLogsForRun('run-456', {
        startTime: customStartTime,
        endTime: customEndTime,
        size: 200,
      });

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.runId).toBe('run-456');
      expect(callBody.startTime).toBe(customStartTime.getTime());
      expect(callBody.endTime).toBe(customEndTime.getTime());
      expect(callBody.size).toBe(200);
    });

    it('should throw error on HTTP error response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue('Run not found'),
      });

      await expect(openSearchClient.fetchLogsForRun('run-xyz')).rejects.toThrow(
        'OpenSearch query failed (404): Run not found'
      );
    });

    it('should handle fetch errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection timeout'));

      await expect(openSearchClient.fetchLogsForRun('run-abc')).rejects.toThrow(
        'Failed to fetch logs: Connection timeout'
      );
    });

    it('should handle non-Error exceptions', async () => {
      global.fetch = jest.fn().mockRejectedValue('String error');

      await expect(openSearchClient.fetchLogsForRun('run-def')).rejects.toThrow(
        'Failed to fetch logs: Unknown error'
      );
    });

    it('should return empty array when logs not present in response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ total: 0 }), // No logs field
      });

      const logs = await openSearchClient.fetchLogsForRun('run-ghi');

      expect(logs).toEqual([]);
    });
  });

  describe('testConnection', () => {
    it('should return true when connection is successful', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ logs: [] }),
      });

      const result = await openSearchClient.testConnection();

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"size":1'),
        })
      );
    });

    it('should return false when connection fails with HTTP error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

      const result = await openSearchClient.testConnection();

      expect(result).toBe(false);
    });

    it('should return false when fetch throws', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('DNS resolution failed'));

      const result = await openSearchClient.testConnection();

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });
});
