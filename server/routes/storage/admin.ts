/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admin Routes for Storage API
 * Handles health checks, index initialization, stats, and backfill operations
 */

import { Router, Request, Response } from 'express';
import { getOpenSearchClient, isStorageConfigured, INDEXES } from '../../services/opensearchClient';
import { INDEX_MAPPINGS } from '../../constants/indexMappings';
import { testStorageConnection } from '../../adapters/index.js';
import { resolveStorageConfig } from '../../middleware/dataSourceConfig.js';

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
  asyncHandler(async (_req: Request, res: Response) => {
    const client = getOpenSearchClient();
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
  asyncHandler(async (_req: Request, res: Response) => {
    const client = getOpenSearchClient();
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
  asyncHandler(async (_req: Request, res: Response) => {
    const client = getOpenSearchClient();

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

export default router;
