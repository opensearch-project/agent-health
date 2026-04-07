/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admin Routes for Storage API
 * Handles health checks, index initialization, stats, and backfill operations.
 *
 * Uses the storage adapter for health checks and analytics backfill.
 * Index initialization is delegated to the indexInitializer service.
 */

import { Router, Request, Response } from 'express';
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { INDEX_MAPPINGS } from '../../constants/indexMappings';
import { getStorageModule, testStorageConnection, isFileStorage, setStorageModule, OpenSearchStorageModule, FileStorageModule } from '../../adapters/index.js';
import { resolveStorageConfig } from '../../middleware/dataSourceConfig.js';
import { createOpenSearchClient } from '../../services/opensearchClientFactory.js';
import { debug } from '@/lib/debug';
import { ensureIndexes, ensureIndexesWithValidation } from '../../services/indexInitializer.js';
import { reindexSingleIndex } from '../../services/mappingFixer.js';
import {
  getConfigStatus,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
} from '../../services/configService.js';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response, next: any) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

// ============================================================================
// Health Check
// ============================================================================

router.get('/api/storage/health', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const health = await storage.health();

    // If using file storage, also check if OpenSearch is configured
    if (isFileStorage()) {
      const config = resolveStorageConfig(req);
      if (config) {
        // OpenSearch is configured but file storage is active
        // Check OpenSearch connectivity for the UI
        const osResult = await testStorageConnection(config);
        return res.json({
          status: health.status,
          backend: 'file',
          opensearch: osResult,
        });
      }
      return res.json({
        status: health.status,
        backend: 'file',
      });
    }

    // OpenSearch storage module active
    return res.json(health);
  } catch (error: any) {
    console.error('[StorageAPI] Health check failed:', error.message);
    res.json({ status: 'error', error: error.message });
  }
});

// ============================================================================
// Test Connection
// ============================================================================

/**
 * POST /api/storage/test-connection
 * Test connection to a storage cluster with provided credentials
 * Falls back to env vars for any missing fields
 * Body: { endpoint, username?, password?, tlsSkipVerify? }
 */
router.post('/api/storage/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, authType, awsProfile, awsRegion, awsService } = req.body;

    if (!endpoint) {
      return res.status(400).json({ status: 'error', message: 'Endpoint is required' });
    }

    const result = await testStorageConnection({
      endpoint,
      authType: authType ?? process.env.OPENSEARCH_STORAGE_AUTH_TYPE,
      username: username ?? process.env.OPENSEARCH_STORAGE_USERNAME,
      password: password ?? process.env.OPENSEARCH_STORAGE_PASSWORD,
      awsProfile: awsProfile ?? process.env.OPENSEARCH_STORAGE_AWS_PROFILE,
      awsRegion: awsRegion ?? process.env.OPENSEARCH_STORAGE_AWS_REGION,
      awsService: awsService ?? process.env.OPENSEARCH_STORAGE_AWS_SERVICE,
      tlsSkipVerify: tlsSkipVerify ?? (process.env.OPENSEARCH_STORAGE_TLS_SKIP_VERIFY === 'true'),
    });
    res.json(result);
  } catch (error: any) {
    console.error('[StorageAPI] Test connection failed:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// Initialize Indexes (OpenSearch-specific)
// ============================================================================

router.post(
  '/api/storage/init-indexes',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch storage not configured. File storage does not require index initialization.' });
    }

    const client = requireStorageClient(req);
    const results = await ensureIndexes(client);

    res.json({ success: true, results });
  })
);

// ============================================================================
// Reindex (migrate existing index to correct mappings)
// ============================================================================

/**
 * POST /api/storage/reindex
 * Reindex an existing index to apply correct mappings.
 * Delegates to reindexSingleIndex() in mappingFixer service.
 * Body: { index: string } — the index name to reindex (must be in INDEX_MAPPINGS)
 */
router.post(
  '/api/storage/reindex',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch storage not configured.' });
    }

    const { index: indexName } = req.body;
    if (!indexName || typeof indexName !== 'string') {
      return res.status(400).json({ error: 'index is required in request body' });
    }

    const mapping = INDEX_MAPPINGS[indexName];
    if (!mapping) {
      return res.status(400).json({ error: `Unknown index: ${indexName}. Must be one of: ${Object.keys(INDEX_MAPPINGS).join(', ')}` });
    }

    const client = requireStorageClient(req);
    const tempIndex = `${indexName}_reindex_temp`;

    try {
      // Check source index exists
      const exists = await client.indices.exists({ index: indexName });
      if (!exists.body) {
        return res.status(404).json({ error: `Index ${indexName} does not exist` });
      }

      const result = await reindexSingleIndex(client, indexName);

      res.json({
        success: true,
        index: indexName,
        documentsReindexed: result.documentsReindexed,
      });
    } catch (error: any) {
      console.error(`[StorageAPI] Reindex failed for ${indexName}:`, error.message);

      // Check if temp index still exists for manual cleanup
      let tempStillExists = false;
      try {
        const check = await client.indices.exists({ index: tempIndex });
        tempStillExists = check.body;
      } catch { /* ignore */ }

      res.status(500).json({
        error: `Reindex failed: ${error.message}`,
        tempIndex: tempStillExists ? tempIndex : undefined,
        hint: tempStillExists ? `Temp index ${tempIndex} still exists with your data. Do NOT delete it manually until the original index is recovered.` : undefined,
      });
    }
  })
);

// ============================================================================
// Storage Stats
// ============================================================================

router.get(
  '/api/storage/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const storage = getStorageModule();

    if (isFileStorage()) {
      // For file storage, count files in each directory
      try {
        const tcResult = await storage.testCases.getAll();
        const benchResult = await storage.benchmarks.getAll();
        const runResult = await storage.runs.getAll();

        const stats: Record<string, any> = {
          test_cases: { count: tcResult.total },
          benchmarks: { count: benchResult.total },
          runs: { count: runResult.total },
          analytics: { count: 0 },
        };

        return res.json({ stats, backend: 'file' });
      } catch (error: any) {
        return res.json({ stats: {}, error: error.message, backend: 'file' });
      }
    }

    // OpenSearch path
    if (!isStorageAvailable(req)) {
      const stats: Record<string, any> = {};
      for (const indexName of Object.values(INDEXES)) {
        stats[indexName] = { count: 0, error: 'Storage not configured' };
      }
      return res.json({ stats });
    }

    const client = requireStorageClient(req);
    const stats: Record<string, any> = {};

    for (const indexName of Object.values(INDEXES)) {
      try {
        const result = await client.count({ index: indexName });
        stats[indexName] = { count: result.body.count };
      } catch (error: any) {
        stats[indexName] = { count: 0, error: error.message };
      }
    }

    res.json({ stats });
  })
);

// ============================================================================
// Backfill Analytics
// ============================================================================

router.post(
  '/api/storage/backfill-analytics',
  asyncHandler(async (req: Request, res: Response) => {
    const storage = getStorageModule();
    const result = await storage.analytics.backfill();

    debug('StorageAPI', `Backfilled ${result.backfilled} analytics records (${result.errors} errors)`);
    res.json(result);
  })
);

// ============================================================================
// Configuration Management
// ============================================================================

/**
 * GET /api/storage/config/status
 * Get configuration status (no credentials returned)
 */
router.get('/api/storage/config/status', (req: Request, res: Response) => {
  try {
    const status = getConfigStatus();
    res.json(status);
  } catch (error: any) {
    console.error('[StorageAPI] Failed to get config status:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/storage
 * Save storage configuration to file and validate index mappings.
 * Returns needsReindex: true if incompatible mappings are detected.
 * Body: { endpoint, username?, password?, tlsSkipVerify? }
 */
router.post('/api/storage/config/storage', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, authType, awsProfile, awsRegion, awsService } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    saveStorageConfig({ endpoint, username, password, tlsSkipVerify, authType, awsProfile, awsRegion, awsService });

    const client = createOpenSearchClient({
      endpoint,
      authType,
      username,
      password,
      awsProfile,
      awsRegion,
      awsService,
      tlsSkipVerify: tlsSkipVerify === true,
    });

    // Auto-create indexes, validate mappings, and auto-fix if needed
    const setupResult = await ensureIndexesWithValidation(client);

    setStorageModule(new OpenSearchStorageModule(client));

    const hasFixFailures = setupResult.fixResults?.some((f) => f.status === 'failed') ?? false;
    const hadIssues = setupResult.validationResults.some((r) => r.status === 'needs_reindex');
    const needsReindex = hadIssues && (hasFixFailures || !setupResult.fixResults);
    if (hasFixFailures) {
      const failedNames = setupResult.fixResults!.filter((f) => f.status === 'failed').map((f) => f.indexName);
      console.warn(`[StorageAPI] Index fix failures: ${failedNames.join(', ')}`);
    }
    res.json({
      success: true,
      message: 'Storage configuration saved',
      connected: true,
      indexResults: setupResult.indexResults,
      validationResults: setupResult.validationResults,
      fixResults: setupResult.fixResults,
      needsReindex,
    });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to save storage config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/setup-indexes
 * SSE endpoint for index setup with real-time progress.
 * Validates and fixes index mappings, streaming per-index progress events.
 */
router.post(
  '/api/storage/setup-indexes',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch storage not configured.' });
    }

    const client = requireStorageClient(req);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendEvent({ type: 'started', indexes: Object.keys(INDEX_MAPPINGS) });

      const setupResult = await ensureIndexesWithValidation(client, (progress) => {
        sendEvent({ type: 'fix_progress', progress });
      });

      sendEvent({
        type: 'validation',
        results: setupResult.validationResults,
      });

      sendEvent({
        type: 'completed',
        indexResults: setupResult.indexResults,
        validationResults: setupResult.validationResults,
        fixResults: setupResult.fixResults,
      });
    } catch (error: any) {
      console.error('[StorageAPI] Setup indexes failed:', error.message);
      sendEvent({ type: 'error', error: error.message });
    } finally {
      res.end();
    }
  })
);

/**
 * POST /api/storage/config/observability
 * Save observability configuration to file
 * Body: { endpoint, username?, password?, tlsSkipVerify?, indexes?: { traces?, logs?, metrics? } }
 */
router.post('/api/storage/config/observability', (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, indexes, authType, awsProfile, awsRegion, awsService } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    saveObservabilityConfig({ endpoint, username, password, tlsSkipVerify, indexes, authType, awsProfile, awsRegion, awsService });
    res.json({ success: true, message: 'Observability configuration saved' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to save observability config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/storage/config/storage
 * Clear storage configuration from file
 */
router.delete('/api/storage/config/storage', (req: Request, res: Response) => {
  try {
    clearStorageConfig();
    setStorageModule(new FileStorageModule());
    res.json({ success: true, message: 'Storage configuration cleared' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to clear storage config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/storage/config/observability
 * Clear observability configuration from file
 */
router.delete('/api/storage/config/observability', (req: Request, res: Response) => {
  try {
    clearObservabilityConfig();
    res.json({ success: true, message: 'Observability configuration cleared' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to clear observability config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
