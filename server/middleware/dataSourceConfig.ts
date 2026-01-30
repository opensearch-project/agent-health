/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data Source Configuration Resolution
 *
 * Resolves data source configuration from:
 * 1. File (agent-health.yaml) - highest priority
 * 2. Environment variables - fallback
 *
 * NO HEADERS - credentials are never sent from browser for security.
 */

import { Request } from 'express';
import type { StorageClusterConfig, ObservabilityClusterConfig } from '../../types/index.js';
import {
  getStorageConfigFromFile,
  getObservabilityConfigFromFile,
} from '../services/configService.js';

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
 * Resolve storage cluster configuration
 *
 * Priority:
 * 1. File config (agent-health.yaml)
 * 2. Environment variables (OPENSEARCH_STORAGE_*)
 * 3. null (not configured)
 */
export function resolveStorageConfig(req: Request): StorageClusterConfig | null {
  // 1. Check file config first
  const fileConfig = getStorageConfigFromFile();
  if (fileConfig) {
    return fileConfig;
  }

  // 2. Fall back to environment variables
  const envEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;

  if (envEndpoint) {
    return {
      endpoint: envEndpoint,
      username: process.env.OPENSEARCH_STORAGE_USERNAME,
      password: process.env.OPENSEARCH_STORAGE_PASSWORD,
      tlsSkipVerify: process.env.OPENSEARCH_STORAGE_TLS_SKIP_VERIFY === 'true',
    };
  }

  // Not configured
  return null;
}

/**
 * Resolve observability cluster configuration
 *
 * Priority:
 * 1. File config (agent-health.yaml)
 * 2. Environment variables (OPENSEARCH_LOGS_*)
 * 3. null (not configured)
 *
 * Index patterns use defaults if not specified in file or env vars.
 */
export function resolveObservabilityConfig(req: Request): ObservabilityClusterConfig | null {
  // 1. Check file config first
  const fileConfig = getObservabilityConfigFromFile();
  
  if (fileConfig) {
    return {
      endpoint: fileConfig.endpoint,
      username: fileConfig.username,
      password: fileConfig.password,
      tlsSkipVerify: fileConfig.tlsSkipVerify,
      indexes: {
        traces: fileConfig.indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
        logs: fileConfig.indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
        metrics: fileConfig.indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
      },
    };
  }

  // 2. Fall back to environment variables
  const envEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;

  if (envEndpoint) {
    return {
      endpoint: envEndpoint,
      username: process.env.OPENSEARCH_LOGS_USERNAME,
      password: process.env.OPENSEARCH_LOGS_PASSWORD,
      tlsSkipVerify: process.env.OPENSEARCH_LOGS_TLS_SKIP_VERIFY === 'true',
      indexes: {
        traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX || DEFAULT_OTEL_INDEXES.traces,
        logs: process.env.OPENSEARCH_LOGS_INDEX || DEFAULT_OTEL_INDEXES.logs,
        metrics: DEFAULT_OTEL_INDEXES.metrics,
      },
    };
  }

  return null;
}

/**
 * Check if storage is configured (either via file or env vars)
 */
export function isStorageConfigured(req: Request): boolean {
  return resolveStorageConfig(req) !== null;
}

/**
 * Check if observability is configured (either via file or env vars)
 */
export function isObservabilityConfigured(req: Request): boolean {
  return resolveObservabilityConfig(req) !== null;
}

/**
 * Get storage config from environment variables only (for backwards compatibility)
 * Used by routes that don't yet support file-based config
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
 * Used by routes that don't yet support file-based config
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
