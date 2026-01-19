/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data Source Configuration
 *
 * Manages localStorage-based configuration for OpenSearch endpoints.
 * Falls back to environment variables when localStorage config is not set.
 */

import type {
  DataSourceConfig,
  StorageClusterConfig,
  ObservabilityClusterConfig,
} from '@/types';

const STORAGE_KEY = 'agenteval_datasource_config';

// Default OTEL index patterns
export const DEFAULT_OTEL_INDEXES = {
  traces: 'otel-v1-apm-span-*',
  logs: 'ml-commons-logs-*',
  metrics: 'otel-v1-apm-service-map*',
} as const;

/**
 * Load data source configuration from localStorage
 */
export function loadDataSourceConfig(): DataSourceConfig | null {
  try {
    if (typeof window === 'undefined') return null;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Save data source configuration to localStorage
 */
export function saveDataSourceConfig(config: DataSourceConfig): void {
  try {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('[DataSourceConfig] Failed to save config:', error);
  }
}

/**
 * Clear data source configuration from localStorage
 */
export function clearDataSourceConfig(): void {
  try {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('[DataSourceConfig] Failed to clear config:', error);
  }
}

/**
 * Clear only storage configuration from localStorage
 */
export function clearStorageConfig(): void {
  const config = loadDataSourceConfig();
  if (config) {
    delete config.storage;
    if (Object.keys(config).length === 0) {
      clearDataSourceConfig();
    } else {
      saveDataSourceConfig(config);
    }
  }
}

/**
 * Clear only observability configuration from localStorage
 */
export function clearObservabilityConfig(): void {
  const config = loadDataSourceConfig();
  if (config) {
    delete config.observability;
    if (Object.keys(config).length === 0) {
      clearDataSourceConfig();
    } else {
      saveDataSourceConfig(config);
    }
  }
}

/**
 * Get storage configuration headers for API calls
 * Returns headers to send with storage API requests
 * Empty object if no localStorage config (backend will use env vars)
 */
export function getStorageConfigHeaders(): Record<string, string> {
  const config = loadDataSourceConfig();
  const storage = config?.storage;

  if (!storage?.endpoint) {
    return {};
  }

  const headers: Record<string, string> = {
    'X-Storage-Endpoint': storage.endpoint,
  };

  if (storage.username) {
    headers['X-Storage-Username'] = storage.username;
  }
  if (storage.password) {
    headers['X-Storage-Password'] = storage.password;
  }

  return headers;
}

/**
 * Get observability configuration headers for API calls
 * Returns headers to send with logs/traces/metrics API requests
 * Empty object if no localStorage config (backend will use env vars)
 */
export function getObservabilityConfigHeaders(): Record<string, string> {
  const config = loadDataSourceConfig();
  const observability = config?.observability;

  if (!observability?.endpoint) {
    return {};
  }

  const headers: Record<string, string> = {
    'X-Observability-Endpoint': observability.endpoint,
  };

  if (observability.username) {
    headers['X-Observability-Username'] = observability.username;
  }
  if (observability.password) {
    headers['X-Observability-Password'] = observability.password;
  }

  // Include custom index patterns if specified
  if (observability.indexes?.traces) {
    headers['X-Observability-Traces-Index'] = observability.indexes.traces;
  }
  if (observability.indexes?.logs) {
    headers['X-Observability-Logs-Index'] = observability.indexes.logs;
  }
  if (observability.indexes?.metrics) {
    headers['X-Observability-Metrics-Index'] = observability.indexes.metrics;
  }

  return headers;
}

/**
 * Check if storage configuration has credentials stored in localStorage
 * Used to show security warning in UI
 */
export function hasStorageCredentials(): boolean {
  const config = loadDataSourceConfig();
  return !!(config?.storage?.username || config?.storage?.password);
}

/**
 * Check if observability configuration has credentials stored in localStorage
 * Used to show security warning in UI
 */
export function hasObservabilityCredentials(): boolean {
  const config = loadDataSourceConfig();
  return !!(config?.observability?.username || config?.observability?.password);
}

/**
 * Get storage config for display in UI
 * Returns the current localStorage config or empty defaults
 */
export function getStorageConfigForUI(): StorageClusterConfig {
  const config = loadDataSourceConfig();
  return {
    endpoint: config?.storage?.endpoint || '',
    username: config?.storage?.username || '',
    password: config?.storage?.password || '',
  };
}

/**
 * Get observability config for display in UI
 * Returns the current localStorage config or empty defaults
 */
export function getObservabilityConfigForUI(): ObservabilityClusterConfig {
  const config = loadDataSourceConfig();
  return {
    endpoint: config?.observability?.endpoint || '',
    username: config?.observability?.username || '',
    password: config?.observability?.password || '',
    indexes: {
      traces: config?.observability?.indexes?.traces || '',
      logs: config?.observability?.indexes?.logs || '',
      metrics: config?.observability?.indexes?.metrics || '',
    },
  };
}

/**
 * Save storage configuration
 * Only saves non-empty values to keep localStorage clean
 */
export function saveStorageConfig(storage: StorageClusterConfig): void {
  const config = loadDataSourceConfig() || {};

  // Only save if there's meaningful data
  if (storage.endpoint) {
    config.storage = {
      endpoint: storage.endpoint,
      ...(storage.username && { username: storage.username }),
      ...(storage.password && { password: storage.password }),
    };
  } else {
    delete config.storage;
  }

  if (Object.keys(config).length === 0) {
    clearDataSourceConfig();
  } else {
    saveDataSourceConfig(config);
  }
}

/**
 * Save observability configuration
 * Only saves non-empty values to keep localStorage clean
 */
export function saveObservabilityConfig(observability: ObservabilityClusterConfig): void {
  const config = loadDataSourceConfig() || {};

  // Only save if there's meaningful data
  if (observability.endpoint) {
    const indexes: ObservabilityClusterConfig['indexes'] = {};

    // Only include non-empty index patterns
    if (observability.indexes?.traces) {
      indexes.traces = observability.indexes.traces;
    }
    if (observability.indexes?.logs) {
      indexes.logs = observability.indexes.logs;
    }
    if (observability.indexes?.metrics) {
      indexes.metrics = observability.indexes.metrics;
    }

    config.observability = {
      endpoint: observability.endpoint,
      ...(observability.username && { username: observability.username }),
      ...(observability.password && { password: observability.password }),
      ...(Object.keys(indexes).length > 0 && { indexes }),
    };
  } else {
    delete config.observability;
  }

  if (Object.keys(config).length === 0) {
    clearDataSourceConfig();
  } else {
    saveDataSourceConfig(config);
  }
}
