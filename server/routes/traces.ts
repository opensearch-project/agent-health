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
import { fetchTraces, checkTracesHealth, classifyOpenSearchError } from '../services/tracesService.js';
import {
  getSampleSpansForRunIds,
  getSampleSpansByTraceId,
  getAllSampleTraceSpans,
  getAllSampleTraceSpansWithRecentTimestamps,
  isSampleTraceId,
} from '../../cli/demo/sampleTraces.js';
import { resolveObservabilityConfig, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import { createOpenSearchClient } from '../services/opensearchClientFactory.js';
import type { Span } from '../../types/index.js';

const router = Router();

/**
 * POST /api/traces - Fetch traces by trace ID or run IDs
 */
router.post('/api/traces', async (req: Request, res: Response) => {
  try {
    const { traceId, runIds, sessionId, startTime, endTime, size = 100, serviceName, textSearch, cursor } = req.body;

    // Validate request - allow time range queries for live tailing
    const hasTimeRange = startTime || endTime;
    const hasIdFilter = traceId || (runIds && runIds.length > 0) || sessionId;

    if (!hasIdFilter && !hasTimeRange) {
      return res.status(400).json({
        error: 'Either traceId, runIds, or time range is required'
      });
    }

    // 1. Handle sample/demo trace lookups
    let sampleSpans: Span[] = [];

    if (traceId && isSampleTraceId(traceId)) {
      sampleSpans = getSampleSpansByTraceId(traceId);
    } else if (runIds && runIds.length > 0) {
      sampleSpans = getSampleSpansForRunIds(runIds);
    }

    // 2. Query live OpenSearch traces (independent of sample logic)
    let realSpans: Span[] = [];
    let warning: string | undefined;
    let warningCategory: string | undefined;
    let suggestion: string | undefined;
    let nextCursor: string | null = null;
    let hasMore: boolean = false;
    const config = resolveObservabilityConfig(req);

    if (config && (traceId || (runIds && runIds.length > 0) || sessionId || startTime || endTime)) {
      let client;
      try {
        client = createOpenSearchClient(config);
        const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;

        const result = await fetchTraces(
          { traceId, runIds, sessionId, startTime, endTime, size, serviceName, textSearch, cursor },
          client,
          indexPattern
        );

        realSpans = (result.spans || []) as Span[];
        nextCursor = result.nextCursor || null;
        hasMore = result.hasMore || false;
      } catch (e: any) {
        const classified = classifyOpenSearchError(e);
        console.warn(`[TracesAPI] OpenSearch query failed (${classified.category}):`, classified.message);
        warning = classified.message;
        warningCategory = classified.category;
        suggestion = classified.suggestion;
      } finally {
        if (client) {
          await client.close().catch(() => {});
        }
      }
    } else if (!config) {
      // No observability cluster configured
      if (hasTimeRange && !hasIdFilter) {
        // Time-range browse query: show demo traces as fallback
        sampleSpans = getAllSampleTraceSpansWithRecentTimestamps();

        if (serviceName) {
          sampleSpans = sampleSpans.filter(
            s => s.attributes['service.name'] === serviceName
          );
        }
        if (textSearch) {
          const searchLower = textSearch.toLowerCase();
          sampleSpans = sampleSpans.filter(s => {
            if (s.name.toLowerCase().includes(searchLower)) return true;
            return Object.values(s.attributes).some(
              v => typeof v === 'string' && v.toLowerCase().includes(searchLower)
            );
          });
        }
      }
      warning = 'Observability data source not configured';
      warningCategory = 'not_configured';
      suggestion = 'Configure OPENSEARCH_LOGS_ENDPOINT or observabilityStorage in agent-health.config.ts to connect to your traces cluster.';
    }

    // Merge: sample spans first, then real spans
    const allSpans = [...sampleSpans, ...realSpans];

    res.json({
      spans: allSpans,
      total: allSpans.length,
      nextCursor,
      hasMore,
      warning,
      warningCategory,
      suggestion,
    });

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

    let client;
    try {
      client = createOpenSearchClient(config);
      const indexPattern = config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces;

      // Call traces service to check health
      const result = await checkTracesHealth(client, indexPattern);
      res.json(result);
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  } catch (error: any) {
    res.json({ status: 'error', error: error.message });
  }
});

export default router;
