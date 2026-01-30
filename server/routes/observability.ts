/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observability Routes
 *
 * Handles observability data source configuration and health checks.
 * Test connection endpoint for OTEL instrumentation data sources.
 */

import { Router, Request, Response } from 'express';
import { testObservabilityConnection, checkObservabilityHealth } from '../adapters/index.js';
import { resolveObservabilityConfig, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';

const router = Router();

// ============================================================================
// Health Check
// ============================================================================

/**
 * GET /api/observability/health
 * Check observability data source health
 * Uses headers for config, falls back to env vars
 */
router.get('/api/observability/health', async (req: Request, res: Response) => {
  try {
    const config = resolveObservabilityConfig(req);
    const result = await checkObservabilityHealth(config);
    res.json(result);
  } catch (error: any) {
    console.error('[ObservabilityAPI] Health check failed:', error.message);
    res.json({ status: 'error', error: error.message });
  }
});

// ============================================================================
// Test Connection
// ============================================================================

/**
 * POST /api/observability/test-connection
 * Test connection to an observability data source with provided credentials
 * Body: { endpoint, username?, password?, indexes?: { traces?, logs?, metrics? } }
 */
router.post('/api/observability/test-connection', async (req: Request, res: Response) => {
  try {
    const { endpoint, username, password, tlsSkipVerify, indexes } = req.body;

    if (!endpoint) {
      return res.status(400).json({ status: 'error', message: 'Endpoint is required' });
    }

    const result = await testObservabilityConnection({
      endpoint,
      username: username ?? process.env.OPENSEARCH_LOGS_USERNAME,
      password: password ?? process.env.OPENSEARCH_LOGS_PASSWORD,
      tlsSkipVerify: tlsSkipVerify ?? (process.env.OPENSEARCH_LOGS_TLS_SKIP_VERIFY === 'true'),
      indexes: {
        traces: indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
        logs: indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
        metrics: indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
      },
    });

    res.json(result);
  } catch (error: any) {
    console.error('[ObservabilityAPI] Test connection failed:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// Configuration Info
// ============================================================================

/**
 * GET /api/observability/defaults
 * Get default OTEL index patterns
 */
router.get('/api/observability/defaults', (_req: Request, res: Response) => {
  res.json({
    indexes: DEFAULT_OTEL_INDEXES,
  });
});

export default router;
