/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG } from '@/lib/config';
import { getObservabilityConfigHeaders } from '@/lib/dataSourceConfig';
import { OpenSearchLog, LogQueryParams } from '@/types';

// Default time range for log queries (in minutes)
const DEFAULT_TIME_RANGE_MINUTES = 60;

/**
 * Browser-compatible OpenSearch Client for fetching logs
 * Uses backend /api/logs endpoint to avoid CORS issues
 */
class OpenSearchClient {
  private logsApiUrl: string;

  constructor() {
    // Use the backend server's /api/logs endpoint
    // Backend handles OpenSearch credentials server-side
    this.logsApiUrl = `${ENV_CONFIG.openSearchProxyUrl.replace('/api/opensearch/logs', '')}/api/logs`;
  }

  /**
   * Fetch logs from OpenSearch based on query parameters
   * Uses backend /api/logs endpoint - credentials handled server-side
   */
  async fetchLogs(params?: Partial<LogQueryParams>): Promise<OpenSearchLog[]> {
    try {
      const endTime = params?.endTime || new Date();
      const startTime = params?.startTime || new Date(endTime.getTime() - DEFAULT_TIME_RANGE_MINUTES * 60 * 1000);
      const size = params?.size || 100;

      console.info('[OpenSearch] Fetching logs via /api/logs:', {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        query: params?.query,
        size,
      });

      // Make request to backend /api/logs endpoint
      const response = await fetch(this.logsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getObservabilityConfigHeaders(),
        },
        body: JSON.stringify({
          query: params?.query,
          startTime: startTime.getTime(),
          endTime: endTime.getTime(),
          size,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[OpenSearch] API query failed:', response.status, errorText);
        throw new Error(`OpenSearch query failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      console.info('[OpenSearch] Response hits:', data.total || 0);

      // Logs are already transformed by the backend
      const logs: OpenSearchLog[] = data.logs || [];

      console.info('[OpenSearch] Logs received:', logs.length);
      return logs;
    } catch (error) {
      console.error('[OpenSearch] Error fetching logs:', error);
      throw new Error(`Failed to fetch logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch logs for a specific run/evaluation by run ID
   * Searches for the runId across all fields as plain text
   */
  async fetchLogsForRun(runId: string, params?: Partial<LogQueryParams>): Promise<OpenSearchLog[]> {
    try {
      const endTime = params?.endTime || new Date();
      const startTime = params?.startTime || new Date(endTime.getTime() - DEFAULT_TIME_RANGE_MINUTES * 60 * 1000);
      const size = params?.size || 100;

      console.info('[OpenSearch] Fetching logs for run:', runId);

      // Make request to backend /api/logs endpoint with runId
      const response = await fetch(this.logsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getObservabilityConfigHeaders(),
        },
        body: JSON.stringify({
          runId,
          startTime: startTime.getTime(),
          endTime: endTime.getTime(),
          size,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[OpenSearch] API query failed:', response.status, errorText);
        throw new Error(`OpenSearch query failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      console.info('[OpenSearch] Response hits for run:', data.total || 0);

      return data.logs || [];
    } catch (error) {
      console.error('[OpenSearch] Error fetching logs for run:', error);
      throw new Error(`Failed to fetch logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Test OpenSearch connection via backend health endpoint
   */
  async testConnection(): Promise<boolean> {
    try {
      // Test by fetching a small number of logs
      const response = await fetch(this.logsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getObservabilityConfigHeaders(),
        },
        body: JSON.stringify({
          size: 1,
          startTime: Date.now() - 60 * 60 * 1000,
          endTime: Date.now(),
        }),
      });

      return response.ok;
    } catch (error) {
      console.error('OpenSearch connection test failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const openSearchClient = new OpenSearchClient();
