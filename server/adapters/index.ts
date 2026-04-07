/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data Source Adapter Factory
 *
 * Storage module singleton: FileStorageModule by default,
 * can be swapped to OpenSearch when a storage cluster is configured.
 *
 * Usage in routes:
 *   import { getStorageModule } from '../adapters/index.js';
 *   const storage = getStorageModule();
 *   const testCases = await storage.testCases.getAll();
 */

import { Client } from '@opensearch-project/opensearch';
import type {
  StorageClusterConfig,
  ObservabilityClusterConfig,
  HealthStatus,
} from '../../types/index.js';
import { STORAGE_INDEXES, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import { createOpenSearchClient } from '../services/opensearchClientFactory.js';
import type { IStorageModule } from './types.js';
import { FileStorageModule } from './file/StorageModule.js';

// ============================================================================
// Test Connection Functions
// ============================================================================

export interface TestConnectionResult {
  status: 'ok' | 'error';
  message?: string;
  latencyMs?: number;
  clusterName?: string;
  clusterStatus?: string;
}

/**
 * Test connection to a storage cluster
 */
export async function testStorageConnection(config: StorageClusterConfig): Promise<TestConnectionResult> {
  if (!config.endpoint) {
    return { status: 'error', message: 'Endpoint is required' };
  }

  const startTime = Date.now();
  let client: Client | null = null;

  try {
    client = createOpenSearchClient(config);

    // Test cluster health
    const result = await client.cluster.health({ timeout: '10s' });
    const latencyMs = Date.now() - startTime;

    return {
      status: 'ok',
      latencyMs,
      clusterName: result.body.cluster_name,
      clusterStatus: result.body.status,
    };
  } catch (error: any) {
    return {
      status: 'error',
      message: error.message || 'Connection failed',
      latencyMs: Date.now() - startTime,
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

/**
 * Test connection to an observability cluster
 * Also verifies that the specified index patterns exist
 */
export async function testObservabilityConnection(config: ObservabilityClusterConfig): Promise<TestConnectionResult> {
  if (!config.endpoint) {
    return { status: 'error', message: 'Endpoint is required' };
  }

  const startTime = Date.now();
  let client: Client | null = null;

  try {
    client = createOpenSearchClient(config);

    // Test cluster health
    const healthResult = await client.cluster.health({ timeout: '10s' });
    const latencyMs = Date.now() - startTime;

    // Optionally check if index patterns exist
    const tracesIndex = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;
    const logsIndex = config.indexes?.logs || DEFAULT_OTEL_INDEXES.logs;

    // Check if at least one of the index patterns matches any indices
    let indexWarning: string | undefined;
    try {
      const indicesResult = await client.cat.indices({ format: 'json' });
      const indices = (indicesResult.body as any[]).map((i: any) => i.index);

      // Simple pattern matching (convert glob to regex)
      const tracesPattern = new RegExp('^' + tracesIndex.replace(/\*/g, '.*') + '$');
      const logsPattern = new RegExp('^' + logsIndex.replace(/\*/g, '.*') + '$');

      const hasTracesIndices = indices.some((i: string) => tracesPattern.test(i));
      const hasLogsIndices = indices.some((i: string) => logsPattern.test(i));

      if (!hasTracesIndices && !hasLogsIndices) {
        indexWarning = `No indices matching '${tracesIndex}' or '${logsIndex}' found`;
      }
    } catch {
      // Index check failed, but connection itself is OK
    }

    return {
      status: 'ok',
      latencyMs,
      clusterName: healthResult.body.cluster_name,
      clusterStatus: healthResult.body.status,
      ...(indexWarning && { message: indexWarning }),
    };
  } catch (error: any) {
    console.error('[testObservabilityConnection] Connection failed:', error.message);
    return {
      status: 'error',
      message: error.meta?.body?.error?.reason || error.message || 'Connection failed',
      latencyMs: Date.now() - startTime,
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

// ============================================================================
// Health Check Functions (using resolved config)
// ============================================================================

/**
 * Check storage health using provided config
 */
export async function checkStorageHealth(config: StorageClusterConfig | null): Promise<HealthStatus> {
  if (!config) {
    return { status: 'not_configured', error: 'Storage not configured' };
  }

  try {
    const result = await testStorageConnection(config);
    if (result.status === 'ok') {
      return {
        status: 'ok',
        cluster: {
          name: result.clusterName,
          status: result.clusterStatus,
        },
      };
    }
    return { status: 'error', error: result.message };
  } catch (error: any) {
    return { status: 'error', error: error.message };
  }
}

/**
 * Check observability health using provided config
 */
export async function checkObservabilityHealth(config: ObservabilityClusterConfig | null): Promise<HealthStatus> {
  if (!config) {
    return { status: 'not_configured', error: 'Observability not configured' };
  }

  try {
    const result = await testObservabilityConnection(config);
    if (result.status === 'ok') {
      return {
        status: 'ok',
        cluster: {
          name: result.clusterName,
          status: result.clusterStatus,
        },
      };
    }
    return { status: 'error', error: result.message };
  } catch (error: any) {
    return { status: 'error', error: error.message };
  }
}

// ============================================================================
// Storage Module Singleton
// ============================================================================

/**
 * Default storage module: JSON files in agent-health-data/.
 * Always available, no configuration needed.
 */
let storageModule: IStorageModule = new FileStorageModule();

/**
 * Get the current storage module.
 * Returns FileStorageModule by default — always configured, zero dependencies.
 * Can be swapped to OpenSearch via setStorageModule() when storage cluster is configured.
 */
export function getStorageModule(): IStorageModule {
  return storageModule;
}

/**
 * Replace the storage module (e.g., when OpenSearch becomes available).
 * Used at startup or when storage config changes at runtime.
 */
export function setStorageModule(module: IStorageModule): void {
  storageModule = module;
}

/**
 * Check if file-based storage is active (vs OpenSearch).
 */
export function isFileStorage(): boolean {
  return storageModule instanceof FileStorageModule;
}

// ============================================================================
// Exports
// ============================================================================

export { STORAGE_INDEXES, DEFAULT_OTEL_INDEXES };
export { FileStorageModule } from './file/StorageModule.js';
export { OpenSearchStorageModule } from './opensearch/StorageModule.js';
export type { IStorageModule } from './types.js';
