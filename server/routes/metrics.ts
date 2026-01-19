/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metrics API Routes - Compute trace-based metrics
 */

import { Request, Response, Router } from 'express';
import { computeMetrics, computeAggregateMetrics } from '../services/metricsService';
import { resolveObservabilityConfig, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import { MetricsResult } from '@/types';

const router = Router();

/**
 * GET /api/metrics/:runId - Compute metrics from traces for a single run
 */
router.get('/api/metrics/:runId', async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    // Get observability configuration from headers or env vars
    const config = resolveObservabilityConfig(req);

    if (!config) {
      return res.status(503).json({
        error: 'Observability data source not configured'
      });
    }

    const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;

    console.log('[MetricsAPI] Computing metrics for runId:', runId);

    const metrics = await computeMetrics(runId, {
      endpoint: config.endpoint,
      username: config.username,
      password: config.password,
      indexPattern
    });

    console.log('[MetricsAPI] Metrics computed:', {
      runId: metrics.runId,
      totalTokens: metrics.totalTokens,
      costUsd: metrics.costUsd?.toFixed(4),
      durationMs: metrics.durationMs?.toFixed(0),
      llmCalls: metrics.llmCalls,
      toolCalls: metrics.toolCalls,
      status: metrics.status
    });

    res.json(metrics);
  } catch (error: any) {
    console.error('[MetricsAPI] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/metrics/batch - Compute metrics for multiple runs
 */
router.post('/api/metrics/batch', async (req: Request, res: Response) => {
  try {
    const { runIds } = req.body;

    if (!Array.isArray(runIds)) {
      return res.status(400).json({ error: 'runIds must be an array' });
    }

    // Get observability configuration from headers or env vars
    const config = resolveObservabilityConfig(req);

    if (!config) {
      return res.status(503).json({
        error: 'Observability data source not configured'
      });
    }

    const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;

    console.log('[MetricsAPI] Computing batch metrics for', runIds.length, 'runs');

    const osConfig = {
      endpoint: config.endpoint,
      username: config.username,
      password: config.password,
      indexPattern
    };

    const results = await Promise.all(
      runIds.map(runId =>
        computeMetrics(runId, osConfig).catch(e => ({
          runId,
          error: e.message,
          status: 'error'
        }))
      )
    );

    // Also compute aggregate metrics (filter out errors with type guard)
    const successfulMetrics = results.filter((r): r is MetricsResult => !('error' in r));
    const aggregate = computeAggregateMetrics(successfulMetrics);

    console.log('[MetricsAPI] Batch metrics computed:', {
      total: runIds.length,
      successful: successfulMetrics.length,
      totalCost: aggregate.totalCostUsd?.toFixed(4)
    });

    res.json({
      metrics: results,
      aggregate
    });
  } catch (error: any) {
    console.error('[MetricsAPI] Batch error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
