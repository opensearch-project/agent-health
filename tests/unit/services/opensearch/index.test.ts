/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchLogs, fetchLogsForRun, testOpenSearchConnection, openSearchClient } from '@/services/opensearch';

// Mock the client
jest.mock('@/services/opensearch/client', () => ({
  openSearchClient: {
    fetchLogs: jest.fn(),
    fetchLogsForRun: jest.fn(),
    testConnection: jest.fn(),
  },
}));

describe('OpenSearch Service Exports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchLogs', () => {
    it('should call openSearchClient.fetchLogs with params', async () => {
      const mockLogs = [{ timestamp: '2024-01-01', message: 'test' }];
      (openSearchClient.fetchLogs as jest.Mock).mockResolvedValue(mockLogs);

      const params = { query: 'error', size: 10 };
      const result = await fetchLogs(params);

      expect(openSearchClient.fetchLogs).toHaveBeenCalledWith(params);
      expect(result).toEqual(mockLogs);
    });

    it('should call openSearchClient.fetchLogs without params', async () => {
      const mockLogs: any[] = [];
      (openSearchClient.fetchLogs as jest.Mock).mockResolvedValue(mockLogs);

      const result = await fetchLogs();

      expect(openSearchClient.fetchLogs).toHaveBeenCalledWith(undefined);
      expect(result).toEqual(mockLogs);
    });
  });

  describe('fetchLogsForRun', () => {
    it('should call openSearchClient.fetchLogsForRun with runId and params', async () => {
      const mockLogs = [{ timestamp: '2024-01-01', message: 'run log' }];
      (openSearchClient.fetchLogsForRun as jest.Mock).mockResolvedValue(mockLogs);

      const params = { size: 50 };
      const result = await fetchLogsForRun('run-123', params);

      expect(openSearchClient.fetchLogsForRun).toHaveBeenCalledWith('run-123', params);
      expect(result).toEqual(mockLogs);
    });

    it('should call openSearchClient.fetchLogsForRun with only runId', async () => {
      const mockLogs: any[] = [];
      (openSearchClient.fetchLogsForRun as jest.Mock).mockResolvedValue(mockLogs);

      const result = await fetchLogsForRun('run-456');

      expect(openSearchClient.fetchLogsForRun).toHaveBeenCalledWith('run-456', undefined);
      expect(result).toEqual(mockLogs);
    });
  });

  describe('testOpenSearchConnection', () => {
    it('should call openSearchClient.testConnection and return true', async () => {
      (openSearchClient.testConnection as jest.Mock).mockResolvedValue(true);

      const result = await testOpenSearchConnection();

      expect(openSearchClient.testConnection).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false when connection test fails', async () => {
      (openSearchClient.testConnection as jest.Mock).mockResolvedValue(false);

      const result = await testOpenSearchConnection();

      expect(result).toBe(false);
    });
  });

  describe('openSearchClient export', () => {
    it('should be exported', () => {
      expect(openSearchClient).toBeDefined();
      expect(openSearchClient.fetchLogs).toBeDefined();
      expect(openSearchClient.fetchLogsForRun).toBeDefined();
      expect(openSearchClient.testConnection).toBeDefined();
    });
  });
});
