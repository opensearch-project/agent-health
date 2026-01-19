/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Traces API Routes - Fetch and query OpenSearch traces
 *
 * Sample trace data (demo-*) is always included in responses.
 * Real data from OpenSearch logs cluster is merged when configured.
 */

import { Request, Response, Router } from 'express';
import { fetchTraces, checkTracesHealth } from '../services/tracesService.js';
import {
  getSampleSpansForRunIds,
  getSampleSpansByTraceId,
  getAllSampleTraceSpans,
  isSampleTraceId,
} from '../../cli/demo/sampleTraces.js';
import { resolveObservabilityConfig, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import type { Span } from '../../types/index.js';

const router = Router();

/**
 * POST /api/traces - Fetch traces by trace ID or run IDs
 */
router.post('/api/traces', async (req: Request, res: Response) => {
  try {
    const { traceId, runIds, startTime, endTime, size = 500, serviceName, textSearch } = req.body;

    // Validate request - allow time range queries for live tailing
    const hasTimeRange = startTime || endTime;
    const hasIdFilter = traceId || (runIds && runIds.length > 0);

    if (!hasIdFilter && !hasTimeRange) {
      return res.status(400).json({
        error: 'Either traceId, runIds, or time range is required'
      });
    }

    // Get sample traces that match the query
    let sampleSpans: Span[] = [];

    if (traceId) {
      // If querying by trace ID, check sample data first
      if (isSampleTraceId(traceId)) {
        sampleSpans = getSampleSpansByTraceId(traceId);
      }
    } else if (runIds && runIds.length > 0) {
      // Filter sample spans by run IDs (via run.id attribute)
      sampleSpans = getSampleSpansForRunIds(runIds);
    }

    let realSpans: Span[] = [];

    // Get observability configuration from headers or env vars
    const config = resolveObservabilityConfig(req);

    // Fetch from observability cluster if configured
    if (config) {
      try {
        const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;

        const result = await fetchTraces(
          { traceId, runIds, startTime, endTime, size, serviceName, textSearch },
          {
            endpoint: config.endpoint,
            username: config.username,
            password: config.password,
            indexPattern
          }
        );

        realSpans = (result.spans || []) as Span[];
      } catch (e: any) {
        console.warn('[TracesAPI] Observability data source unavailable, returning sample data only:', e.message);
      }
    }

    // Merge: sample spans first, then real spans
    const allSpans = [...sampleSpans, ...realSpans];

    res.json({ spans: allSpans, total: allSpans.length });

  } catch (error: any) {
    console.error('[TracesAPI] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/traces/health - Check traces index availability
 */
router.get('/api/traces/health', async (req: Request, res: Response) => {
  try {
    // Get observability configuration from headers or env vars
    const config = resolveObservabilityConfig(req);

    // If observability not configured, return sample-only status
    if (!config) {
      return res.json({
        status: 'sample_only',
        message: 'Observability data source not configured. Sample trace data available.',
        sampleTraceCount: getAllSampleTraceSpans().length,
      });
    }

    const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;

    // Call traces service to check health
    const result = await checkTracesHealth({
      endpoint: config.endpoint,
      username: config.username,
      password: config.password,
      indexPattern
    });

    res.json(result);
  } catch (error: any) {
    res.json({ status: 'error', error: error.message });
  }
});

export default router;
