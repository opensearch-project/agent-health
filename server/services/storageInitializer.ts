/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage Initializer
 *
 * Shared logic for initializing the storage backend from config.
 * Used by both startup (app.ts) and drift detection (middleware).
 */

import type { StorageClusterConfig } from '../../types/index.js';
import type { StorageState } from '../adapters/index.js';
import { setStorageModule, setStorageError, FileStorageModule, FileSessionMetadataOperations, OpenSearchStorageModule } from '../adapters/index.js';
import { createOpenSearchClient, configToCacheKey } from './opensearchClientFactory.js';
import { ensureIndexesWithValidation } from './indexInitializer.js';

/**
 * Initialize (or reinitialize) the storage backend from the given config.
 *
 * - `config === null` → swap to FileStorageModule
 * - `config !== null` → test connectivity, swap to OpenSearchStorageModule
 * - On connection failure → set error state, do NOT fall back to file storage
 *
 * @param config  Resolved storage cluster config, or null for file storage
 * @param options.runIndexValidation  Run index creation/validation (default: false, expensive)
 * @returns The resulting StorageState
 */
export async function initializeStorageFromConfig(
  config: StorageClusterConfig | null,
  options?: { runIndexValidation?: boolean }
): Promise<StorageState> {
  // No config → file storage
  if (!config) {
    const state: StorageState = {
      backend: 'file',
      configKey: null,
      error: null,
      configuredEndpoint: null,
    };
    setStorageModule(new FileStorageModule(), state);
    return state;
  }

  const configKey = configToCacheKey(config);
  const client = createOpenSearchClient(config);

  try {
    // Verify connectivity
    await client.cluster.health({ timeout: '5s' });

    // Optionally run index validation (expensive — only at startup or explicit save)
    if (options?.runIndexValidation) {
      const setupResult = await ensureIndexesWithValidation(client, (progress) => {
        for (const p of progress) {
          if (p.status === 'reindexing') console.log(`[storageInit] Reindexing ${p.indexName}...`);
          if (p.status === 'completed') console.log(`[storageInit] Reindexed ${p.indexName} (${p.documentCount} docs)`);
          if (p.status === 'failed') console.error(`[storageInit] Failed to reindex ${p.indexName}: ${p.error}`);
        }
      });

      const { indexResults } = setupResult;
      const created = Object.entries(indexResults).filter(([, r]) => r.status === 'created').map(([n]) => n);
      const failedIndexes = Object.entries(indexResults)
        .filter(([, r]) => r.status === 'error')
        .map(([name, r]) => `${name}: ${r.error}`);
      if (created.length > 0) console.log(`[storageInit] Created indexes: ${created.join(', ')}`);
      if (failedIndexes.length > 0) {
        console.warn(`[storageInit] WARNING: ${failedIndexes.length} index(es) failed:\n  ${failedIndexes.join('\n  ')}`);
      } else {
        console.log('[storageInit] All indexes initialized successfully');
      }
    }

    const osModule = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());
    const state: StorageState = {
      backend: 'opensearch',
      configKey,
      error: null,
      configuredEndpoint: config.endpoint,
    };
    setStorageModule(osModule, state);
    console.log('[storageInit] OpenSearch storage module activated');
    return state;
  } catch (error: any) {
    const errorMsg = error.message || 'Connection failed';
    console.warn(`[storageInit] OpenSearch not reachable: ${errorMsg}`);
    setStorageError(errorMsg, configKey, config.endpoint);
    await client.close().catch(() => {});
    return {
      backend: 'error',
      configKey,
      error: errorMsg,
      configuredEndpoint: config.endpoint,
    };
  }
}
