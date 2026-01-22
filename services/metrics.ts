/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metrics Service - Client-side service for fetching trace-based metrics
 */

import { TraceMetrics } from '@/types';
import { ENV_CONFIG } from '@/lib/config';

const API_BASE = ENV_CONFIG.backendUrl;

/**
 * Fetch metrics for a single run from OpenSearch traces
 * Backend handles config resolution (file or env vars) - no headers needed from frontend
 *
 * @param runId - The agent run ID (gen_ai@request@id from traces)
 * @returns Computed metrics including tokens, cost, duration, tool calls
 */
export async function fetchRunMetrics(runId: string): Promise<TraceMetrics> {
  const response = await fetch(`${API_BASE}/api/metrics/${encodeURIComponent(runId)}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to fetch metrics: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch metrics for multiple runs in batch
 * Backend handles config resolution (file or env vars) - no headers needed from frontend
 *
 * @param runIds - Array of run IDs to fetch metrics for
 * @returns Object containing individual metrics and aggregate statistics
 */
export async function fetchBatchMetrics(runIds: string[]): Promise<{
  metrics: TraceMetrics[];
  aggregate: {
    totalRuns: number;
    successRate: number;
    totalCostUsd: number;
    avgCostUsd: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    avgTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgLlmCalls: number;
    avgToolCalls: number;
  };
}> {
  const response = await fetch(`${API_BASE}/api/metrics/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ runIds })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to fetch batch metrics: ${response.status}`);
  }

  return response.json();
}

/**
 * Format cost as USD string
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(4)}`;
  }
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 60000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format token count with K/M suffix for large numbers
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}
