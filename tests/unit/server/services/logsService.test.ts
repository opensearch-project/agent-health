/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  fetchLogs,
  fetchLogsLegacy,
  LogsQueryOptions,
  OpenSearchLogsConfig,
  LegacyLogsQueryOptions,
} from '@/server/services/logsService';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('LogsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchLogs', () => {
    const defaultConfig: OpenSearchLogsConfig = {
      endpoint: 'http://localhost:9200',
      username: 'admin',
      password: 'admin',
      indexPattern: 'ml-commons-logs-*',
    };

    it('should throw error when endpoint is not configured', async () => {
      const options: LogsQueryOptions = { runId: 'test-run' };
      const config: OpenSearchLogsConfig = { endpoint: '' };

      await expect(fetchLogs(options, config)).rejects.toThrow('OpenSearch Logs not configured');
    });

    it('should fetch logs by runId', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _index: 'ml-commons-logs-2024.01.01',
              _source: {
                '@timestamp': '2024-01-01T00:00:00Z',
                message: '[run_id=test-run] Test log message',
                level: 'INFO',
                source: 'agent',
              },
            },
          ],
          total: { value: 1 },
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const options: LogsQueryOptions = { runId: 'test-run', size: 50 };
      const result = await fetchLogs(options, defaultConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/ml-commons-logs-*/_search',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': expect.stringContaining('Basic'),
          }),
        })
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query.bool.must).toContainEqual({
        match: { message: 'test-run' },
      });

      expect(result.total).toBe(1);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0].message).toContain('test-run');
    });

    it('should add time range filter when no runId is provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [], total: { value: 0 } } }),
      });

      const options: LogsQueryOptions = { query: 'error' };
      await fetchLogs(options, defaultConfig);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const timeRangeFilter = requestBody.query.bool.must.find(
        (f: any) => f.range && f.range['@timestamp']
      );
      expect(timeRangeFilter).toBeDefined();
    });

    it('should not add time range filter when runId is provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [], total: { value: 0 } } }),
      });

      const options: LogsQueryOptions = { runId: 'test-run' };
      await fetchLogs(options, defaultConfig);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const timeRangeFilter = requestBody.query.bool.must.find(
        (f: any) => f.range && f.range['@timestamp']
      );
      expect(timeRangeFilter).toBeUndefined();
    });

    it('should filter by custom query', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [], total: { value: 0 } } }),
      });

      const options: LogsQueryOptions = { query: 'exception' };
      await fetchLogs(options, defaultConfig);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query.bool.must).toContainEqual({
        match: { message: 'exception' },
      });
    });

    it('should transform hits to log entries', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _index: 'ml-commons-logs-2024.01.01',
              _source: {
                '@timestamp': '2024-01-01T12:00:00Z',
                message: 'Test message',
                level: 'ERROR',
                source: 'test-source',
                custom_field: 'custom_value',
              },
            },
          ],
          total: { value: 1 },
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const options: LogsQueryOptions = { runId: 'test' };
      const result = await fetchLogs(options, defaultConfig);

      expect(result.logs[0]).toMatchObject({
        timestamp: '2024-01-01T12:00:00Z',
        index: 'ml-commons-logs-2024.01.01',
        message: 'Test message',
        level: 'ERROR',
        source: 'test-source',
        custom_field: 'custom_value',
      });
    });

    it('should handle missing source fields gracefully', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _index: 'test-index',
              _source: {
                some_field: 'value',
              },
            },
          ],
          total: { value: 1 },
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const options: LogsQueryOptions = { runId: 'test' };
      const result = await fetchLogs(options, defaultConfig);

      expect(result.logs[0].level).toBe('info');
      expect(result.logs[0].source).toBe('unknown');
    });

    it('should throw error on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });

      const options: LogsQueryOptions = { runId: 'test' };

      await expect(fetchLogs(options, defaultConfig)).rejects.toThrow('Bad request');
    });

    it('should work without auth credentials', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [], total: { value: 0 } } }),
      });

      const configNoAuth: OpenSearchLogsConfig = {
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
      };

      await fetchLogs({ runId: 'test' }, configNoAuth);

      const requestHeaders = mockFetch.mock.calls[0][1].headers;
      expect(requestHeaders['Authorization']).toBeUndefined();
    });
  });

  describe('fetchLogsLegacy', () => {
    it('should throw error when required fields are missing', async () => {
      await expect(
        fetchLogsLegacy({
          endpoint: '',
          indexPattern: 'logs-*',
          query: {},
        })
      ).rejects.toThrow('Missing required fields');

      await expect(
        fetchLogsLegacy({
          endpoint: 'http://localhost:9200',
          indexPattern: '',
          query: {},
        })
      ).rejects.toThrow('Missing required fields');

      await expect(
        fetchLogsLegacy({
          endpoint: 'http://localhost:9200',
          indexPattern: 'logs-*',
          query: null as any,
        })
      ).rejects.toThrow('Missing required fields');
    });

    it('should proxy OpenSearch query', async () => {
      const mockResponse = { hits: { hits: [], total: { value: 0 } } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const options: LegacyLogsQueryOptions = {
        endpoint: 'http://localhost:9200',
        indexPattern: 'my-logs-*',
        query: { match_all: {} },
      };

      const result = await fetchLogsLegacy(options);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/my-logs-*/_search',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ match_all: {} }),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should include auth header when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      const options: LegacyLogsQueryOptions = {
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: {},
        auth: 'Bearer token123',
      };

      await fetchLogsLegacy(options);

      const requestHeaders = mockFetch.mock.calls[0][1].headers;
      expect(requestHeaders['Authorization']).toBe('Bearer token123');
    });

    it('should throw error on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      const options: LegacyLogsQueryOptions = {
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: {},
      };

      await expect(fetchLogsLegacy(options)).rejects.toThrow('Internal server error');
    });
  });
});
