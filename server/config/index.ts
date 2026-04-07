/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server Configuration Module
 * Centralizes all environment variable access and configuration
 */

import { StorageConfig } from '@/types';

// ============================================================================
// Server Configuration
// ============================================================================

export const PORT = parseInt(process.env.PORT || process.env.BACKEND_PORT || process.env.VITE_BACKEND_PORT || '4001', 10);

// ============================================================================
// AWS Configuration
// ============================================================================

export const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
export const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// ============================================================================
// LiteLLM Configuration
// ============================================================================

export const LITELLM_API_KEY = process.env.LITELLM_API_KEY || '';
export const LITELLM_ENDPOINT = process.env.LITELLM_ENDPOINT || 'http://localhost:4000/v1/chat/completions';

// ============================================================================
// OpenSearch Logs Configuration
// ============================================================================

export const OPENSEARCH_LOGS = {
  endpoint: process.env.OPENSEARCH_LOGS_ENDPOINT,
  username: process.env.OPENSEARCH_LOGS_USERNAME,
  password: process.env.OPENSEARCH_LOGS_PASSWORD,
  index: process.env.OPENSEARCH_LOGS_INDEX || 'ml-commons-logs-*',
  tracesIndex: process.env.OPENSEARCH_LOGS_TRACES_INDEX || 'otel-v1-apm-span-*',
};

// ============================================================================
// OpenSearch Storage Configuration
// ============================================================================

export const STORAGE_CONFIG: StorageConfig = {
  endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT,
  username: process.env.OPENSEARCH_STORAGE_USERNAME,
  password: process.env.OPENSEARCH_STORAGE_PASSWORD,
  indexes: {
    testCases: 'evals_test_cases',
    // Note: Using old index name 'evals_experiments' for data compatibility
    // Will be renamed to 'evals_benchmarks' in a future migration
    benchmarks: 'evals_experiments',
    runs: 'evals_runs',
    analytics: 'evals_analytics',
  },
};

/**
 * Check if storage is configured
 */
export function isStorageConfigured(): boolean {
  return !!(STORAGE_CONFIG.endpoint && STORAGE_CONFIG.username && STORAGE_CONFIG.password);
}

// ============================================================================
// Environment Mode
// ============================================================================

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';
export const IS_DEVELOPMENT = NODE_ENV === 'development';

// ============================================================================
// Export all config as default
// ============================================================================

const config = {
  PORT,
  AWS_REGION,
  BEDROCK_MODEL_ID,
  LITELLM_API_KEY,
  LITELLM_ENDPOINT,
  OPENSEARCH_LOGS,
  STORAGE_CONFIG,
  isStorageConfigured,
  NODE_ENV,
  IS_PRODUCTION,
  IS_DEVELOPMENT,
};

export default config;
