/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data Source Configuration Resolution
 *
 * Extracts data source configuration from request headers.
 * Falls back to environment variables when headers are not provided.
 */

import { Request } from 'express';
import type { StorageClusterConfig, ObservabilityClusterConfig } from '../../types/index.js';

// Default OTEL index patterns
export const DEFAULT_OTEL_INDEXES = {
  traces: 'otel-v1-apm-span-*',
  logs: 'ml-commons-logs-*',
  metrics: 'otel-v1-apm-service-map*',
} as const;

// Default storage index names (not configurable)
// Note: benchmarks key uses old index name 'evals_experiments' for data compatibility
export const STORAGE_INDEXES = {
  testCases: 'evals_test_cases',
  benchmarks: 'evals_experiments',
  runs: 'evals_runs',
  analytics: 'evals_analytics',
} as const;

/**
 * Resolve storage cluster configuration from request headers or environment variables
 *
 * Priority:
 * 1. Request headers (X-Storage-*)
 * 2. Environment variables (OPENSEARCH_STORAGE_*)
 * 3. null (not configured)
 */
export function resolveStorageConfig(req: Request): StorageClusterConfig | null {
  // Check for headers first
  const headerEndpoint = req.headers['x-storage-endpoint'] as string | undefined;

  if (headerEndpoint) {
    // Use header-based config
    return {
      endpoint: headerEndpoint,
      username: req.headers['x-storage-username'] as string | undefined,
      password: req.headers['x-storage-password'] as string | undefined,
    };
  }

  // Fall back to environment variables
  const envEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;

  if (envEndpoint) {
    return {
      endpoint: envEndpoint,
      username: process.env.OPENSEARCH_STORAGE_USERNAME,
      password: process.env.OPENSEARCH_STORAGE_PASSWORD,
    };
  }

  // Not configured
  return null;
}

/**
 * Resolve observability cluster configuration from request headers or environment variables
 *
 * Priority:
 * 1. Request headers (X-Observability-*)
 * 2. Environment variables (OPENSEARCH_LOGS_*)
 * 3. null (not configured)
 *
 * Index patterns use defaults if not specified in headers or env vars.
 */
export function resolveObservabilityConfig(req: Request): ObservabilityClusterConfig | null {
  // Check for headers first
  const headerEndpoint = req.headers['x-observability-endpoint'] as string | undefined;

  if (headerEndpoint) {
    // Use header-based config
    return {
      endpoint: headerEndpoint,
      username: req.headers['x-observability-username'] as string | undefined,
      password: req.headers['x-observability-password'] as string | undefined,
      indexes: {
        traces: (req.headers['x-observability-traces-index'] as string) || DEFAULT_OTEL_INDEXES.traces,
        logs: (req.headers['x-observability-logs-index'] as string) || DEFAULT_OTEL_INDEXES.logs,
        metrics: (req.headers['x-observability-metrics-index'] as string) || DEFAULT_OTEL_INDEXES.metrics,
      },
    };
  }

  // Fall back to environment variables
  const envEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;

  if (envEndpoint) {
    return {
      endpoint: envEndpoint,
      username: process.env.OPENSEARCH_LOGS_USERNAME,
      password: process.env.OPENSEARCH_LOGS_PASSWORD,
      indexes: {
        traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX || DEFAULT_OTEL_INDEXES.traces,
        logs: process.env.OPENSEARCH_LOGS_INDEX || DEFAULT_OTEL_INDEXES.logs,
        metrics: DEFAULT_OTEL_INDEXES.metrics, // No env var for metrics index currently
      },
    };
  }

  // Not configured
  return null;
}

/**
 * Check if storage is configured (either via headers or env vars)
 */
export function isStorageConfigured(req: Request): boolean {
  return resolveStorageConfig(req) !== null;
}

/**
 * Check if observability is configured (either via headers or env vars)
 */
export function isObservabilityConfigured(req: Request): boolean {
  return resolveObservabilityConfig(req) !== null;
}

/**
 * Get storage config from environment variables only (for backwards compatibility)
 * Used by routes that don't yet support header-based config
 */
export function getStorageConfigFromEnv(): StorageClusterConfig | null {
  const endpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;

  if (!endpoint) {
    return null;
  }

  return {
    endpoint,
    username: process.env.OPENSEARCH_STORAGE_USERNAME,
    password: process.env.OPENSEARCH_STORAGE_PASSWORD,
  };
}

/**
 * Get observability config from environment variables only
 * Used by routes that don't yet support header-based config
 */
export function getObservabilityConfigFromEnv(): ObservabilityClusterConfig | null {
  const endpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;

  if (!endpoint) {
    return null;
  }

  return {
    endpoint,
    username: process.env.OPENSEARCH_LOGS_USERNAME,
    password: process.env.OPENSEARCH_LOGS_PASSWORD,
    indexes: {
      traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX || DEFAULT_OTEL_INDEXES.traces,
      logs: process.env.OPENSEARCH_LOGS_INDEX || DEFAULT_OTEL_INDEXES.logs,
      metrics: DEFAULT_OTEL_INDEXES.metrics,
    },
  };
}
