/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data Source Configuration - Frontend API Client
 *
 * This module provides API calls to manage server-side configuration.
 * Credentials are stored on the server (in agent-health.yaml), NOT in browser.
 *
 * Security: No credentials are ever stored in localStorage or sent via headers.
 */

import { ENV_CONFIG } from '@/lib/config';
import type {
  StorageClusterConfig,
  ObservabilityClusterConfig,
} from '@/types';

// Default OTEL index patterns (kept for UI defaults)
export const DEFAULT_OTEL_INDEXES = {
  traces: 'otel-v1-apm-span-*',
  logs: 'ml-commons-logs-*',
  metrics: 'otel-v1-apm-service-map*',
} as const;

// API base URL
const API_BASE = ENV_CONFIG.backendUrl;

/**
 * Configuration status returned by the backend
 * Never includes credentials - only source and endpoint info
 */
export interface ConfigStatus {
  storage: {
    configured: boolean;
    source: 'file' | 'environment' | 'none';
    endpoint?: string;
  };
  observability: {
    configured: boolean;
    source: 'file' | 'environment' | 'none';
    endpoint?: string;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
}

// ============================================================================
// Config Status API
// ============================================================================

/**
 * Get configuration status from the server
 * Returns source (file/environment/none) and endpoints, never credentials
 */
export async function getConfigStatus(): Promise<ConfigStatus> {
  const response = await fetch(`${API_BASE}/api/storage/config/status`);

  if (!response.ok) {
    throw new Error('Failed to get config status');
  }

  return response.json();
}

// ============================================================================
// Storage Configuration API
// ============================================================================

/**
 * Save storage configuration to server (agent-health.yaml)
 */
export async function saveStorageConfig(config: StorageClusterConfig): Promise<void> {
  const response = await fetch(`${API_BASE}/api/storage/config/storage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: config.endpoint,
      username: config.username || undefined,
      password: config.password || undefined,
      tlsSkipVerify: config.tlsSkipVerify,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || 'Failed to save storage configuration');
  }
}

/**
 * Clear storage configuration from server
 */
export async function clearStorageConfig(): Promise<void> {
  const response = await fetch(`${API_BASE}/api/storage/config/storage`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || 'Failed to clear storage configuration');
  }
}

// ============================================================================
// Observability Configuration API
// ============================================================================

/**
 * Save observability configuration to server (agent-health.yaml)
 */
export async function saveObservabilityConfig(config: ObservabilityClusterConfig): Promise<void> {
  const response = await fetch(`${API_BASE}/api/storage/config/observability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: config.endpoint,
      username: config.username || undefined,
      password: config.password || undefined,
      tlsSkipVerify: config.tlsSkipVerify,
      indexes: config.indexes,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || 'Failed to save observability configuration');
  }
}

/**
 * Clear observability configuration from server
 */
export async function clearObservabilityConfig(): Promise<void> {
  const response = await fetch(`${API_BASE}/api/storage/config/observability`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || 'Failed to clear observability configuration');
  }
}

// ============================================================================
// Legacy Compatibility Stubs
// These functions are no-ops or return empty values for backwards compatibility
// with any code that might still import them during transition
// ============================================================================

/** @deprecated No longer used - configuration is server-side only */
export function loadDataSourceConfig(): null {
  return null;
}

/** @deprecated No longer used - configuration is server-side only */
export function clearDataSourceConfig(): void {
  // No-op - use clearStorageConfig() and clearObservabilityConfig() instead
}

/** @deprecated No longer used - credentials are not sent via headers */
export function getStorageConfigHeaders(): Record<string, string> {
  return {};
}

/** @deprecated No longer used - credentials are not sent via headers */
export function getObservabilityConfigHeaders(): Record<string, string> {
  return {};
}

/** @deprecated No longer used - credentials not stored in browser */
export function hasStorageCredentials(): boolean {
  return false;
}

/** @deprecated No longer used - credentials not stored in browser */
export function hasObservabilityCredentials(): boolean {
  return false;
}
