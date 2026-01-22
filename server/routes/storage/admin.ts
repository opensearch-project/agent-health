/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admin Routes for Storage API
 * Handles health checks, index initialization, stats, and backfill operations
 */

import { Router, Request, Response } from 'express';
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { INDEX_MAPPINGS } from '../../constants/indexMappings';
import { testStorageConnection } from '../../adapters/index.js';
import { resolveStorageConfig } from '../../middleware/dataSourceConfig.js';
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
    // Try to resolve config from headers or env vars
    const config = resolveStorageConfig(req);

    if (!config) {
      return res.json({ status: 'not_configured', message: 'Storage not configured' });
    }

    // Use the test connection function for health check
    const result = await testStorageConnection(config);
    if (result.status === 'ok') {
      res.json({
        status: 'ok',
        cluster: {
          name: result.clusterName,
          status: result.clusterStatus,
        },
      });
    } else {
      res.json({ status: 'error', error: result.message });
    }
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
 * Body: { endpoint, username?, password? }
 */
router.post('/api/storage/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password } = req.body;

    if (!endpoint) {
      return res.status(400).json({ status: 'error', message: 'Endpoint is required' });
    }

    const result = await testStorageConnection({ endpoint, username, password });
    res.json(result);
  } catch (error: any) {
    console.error('[StorageAPI] Test connection failed:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// Initialize Indexes
// ============================================================================

router.post(
  '/api/storage/init-indexes',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'Storage not configured' });
    }

    const client = requireStorageClient(req);
    const results: Record<string, any> = {};

    for (const [indexName, mapping] of Object.entries(INDEX_MAPPINGS)) {
      try {
        // Check if index exists
        const exists = await client.indices.exists({ index: indexName });
        if (exists.body) {
          results[indexName] = { status: 'exists' };
          continue;
        }

        await client.indices.create({ index: indexName, body: mapping as any });
        results[indexName] = { status: 'created' };
        console.log(`[StorageAPI] Created index: ${indexName}`);
      } catch (error: any) {
        results[indexName] = { status: 'error', error: error.message };
        console.error(`[StorageAPI] Failed to create index ${indexName}:`, error.message);
      }
    }

    res.json({ success: true, results });
  })
);

// ============================================================================
// Storage Stats
// ============================================================================

router.get(
  '/api/storage/stats',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isStorageAvailable(req)) {
      // Return empty stats when storage not configured
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
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'Storage not configured' });
    }

    const client = requireStorageClient(req);

    // Fetch all runs
    const result = await client.search({
      index: INDEXES.runs,
      body: {
        size: 10000,
        query: { match_all: {} },
      },
    });

    const runs = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
    let backfilled = 0;
    let errors = 0;

    for (const run of runs) {
      try {
        const analyticsDoc: any = {
          analyticsId: `analytics-${run.id}`,
          runId: run.id,
          experimentId: run.experimentId,
          experimentRunId: run.experimentRunId,
          testCaseId: run.testCaseId,
          testCaseVersionId: run.testCaseVersionId,
          traceId: run.traceId,
          agentId: run.agentId,
          modelId: run.modelId,
          iteration: run.iteration || 1,
          tags: run.tags || [],
          passFailStatus: run.passFailStatus,
          status: run.status,
          createdAt: run.createdAt,
          author: run.author,
        };

        // Flatten metrics with metric_ prefix
        if (run.metrics) {
          for (const [key, value] of Object.entries(run.metrics)) {
            analyticsDoc[`metric_${key}`] = value;
          }
        }

        await client.index({
          index: INDEXES.analytics,
          id: analyticsDoc.analyticsId,
          body: analyticsDoc,
          refresh: true,
        });
        backfilled++;
      } catch (e: any) {
        console.error(`Failed to backfill analytics for run ${run.id}:`, e.message);
        errors++;
      }
    }

    console.log(`[StorageAPI] Backfilled ${backfilled} analytics records (${errors} errors)`);
    res.json({ backfilled, errors, total: runs.length });
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
 * Save storage configuration to file
 * Body: { endpoint, username?, password? }
 */
router.post('/api/storage/config/storage', (req: Request, res: Response) => {
  try {
    const { endpoint, username, password } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    saveStorageConfig({ endpoint, username, password });
    res.json({ success: true, message: 'Storage configuration saved' });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to save storage config:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/config/observability
 * Save observability configuration to file
 * Body: { endpoint, username?, password?, indexes?: { traces?, logs?, metrics? } }
 */
router.post('/api/storage/config/observability', (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, indexes } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    saveObservabilityConfig({ endpoint, username, password, indexes });
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
