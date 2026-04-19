/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metrics API Routes - Compute trace-based metrics
 */

import { Request, Response, Router } from 'express';
import { debug } from '@/lib/debug';
import { computeMetrics, computeBatchMetrics, computeMetricsFromSampleSpans, computeAggregateMetrics } from '../services/metricsService';
import { resolveObservabilityConfig, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import { MetricsResult } from '@/types';

const router = Router();

/**
 * GET /api/metrics/:runId - Compute metrics from traces for a single run
 */
router.get('/api/metrics/:runId', async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    // Check for sample/demo data first (no OpenSearch needed)
    if (runId.startsWith('demo-')) {
      const sampleMetrics = computeMetricsFromSampleSpans(runId);
      if (sampleMetrics) {
        debug('MetricsAPI', 'Returning sample metrics for demo runId:', runId);
        return res.json(sampleMetrics);
      }
    }

    // Get observability configuration from headers or env vars
    const config = resolveObservabilityConfig(req);

    if (!config) {
      return res.status(503).json({
        error: 'Observability data source not configured'
      });
    }

    const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;

    debug('MetricsAPI', 'Computing metrics for runId:', runId);

    const metrics = await computeMetrics(runId, {
      endpoint: config.endpoint,
      username: config.username,
      password: config.password,
      indexPattern
    });

    debug('MetricsAPI', 'Metrics computed:', {
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

    debug('MetricsAPI', 'Computing batch metrics for', runIds.length, 'runs');

    // Separate demo vs real run IDs
    const demoRunIds = runIds.filter((id: string) => id.startsWith('demo-'));
    const realRunIds = runIds.filter((id: string) => !id.startsWith('demo-'));

    // Compute demo metrics from sample spans (no OpenSearch needed)
    const demoResults: (MetricsResult | { runId: string; error: string; status: string })[] =
      demoRunIds.map((runId: string) => {
        const metrics = computeMetricsFromSampleSpans(runId);
        return metrics || { runId, error: 'No sample data found', status: 'error' };
      });

    // Compute real metrics from OpenSearch (if any real run IDs)
    let realResults: (MetricsResult | { runId: string; error: string; status: string })[] = [];

    if (realRunIds.length > 0) {
      const config = resolveObservabilityConfig(req);

      if (!config) {
        realResults = realRunIds.map((runId: string) => ({
          runId,
          error: 'Observability data source not configured',
          status: 'error'
        }));
      } else {
        const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;
        const osConfig = {
          endpoint: config.endpoint,
          username: config.username,
          password: config.password,
          indexPattern
        };

        try {
          realResults = await computeBatchMetrics(realRunIds, osConfig);
        } catch (e: any) {
          realResults = realRunIds.map((runId: string) => ({
            runId,
            error: e.message,
            status: 'error'
          }));
        }
      }
    }

    // Combine results preserving original order
    const resultsMap = new Map<string, any>();
    [...demoResults, ...realResults].forEach(r => resultsMap.set(r.runId, r));
    const results = runIds.map((id: string) => resultsMap.get(id));

    // Also compute aggregate metrics (filter out errors with type guard)
    const successfulMetrics = results.filter((r): r is MetricsResult => !('error' in r));
    const aggregate = computeAggregateMetrics(successfulMetrics);

    debug('MetricsAPI', 'Batch metrics computed:', {
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
