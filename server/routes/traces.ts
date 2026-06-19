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
import { classifyOpenSearchError, validateAwsCredentials, type ErrorCategory } from '../services/tracesService.js';
import {
  getSampleSpansForRunIds,
  getSampleSpansByTraceId,
  getAllSampleTraceSpans,
  getAllSampleTraceSpansWithRecentTimestamps,
  isSampleTraceId,
} from '../../cli/demo/sampleTraces.js';
import { resolveObservabilityConfig } from '../middleware/dataSourceConfig.js';
import { getObservabilityModule } from '../services/observabilityClient.js';
import type { Span } from '../../types/index.js';

const router = Router();

/**
 * POST /api/traces - Fetch traces by trace ID or run IDs
 */
router.post('/api/traces', async (req: Request, res: Response) => {
  try {
    const { traceId, runIds, sessionId, startTime, endTime, size = 100, serviceName, textSearch, cursor, agents } = req.body;

    if (sessionId !== undefined && typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId must be a string' });
    }
    if (agents !== undefined && (!Array.isArray(agents) || agents.some((a: any) =>
        !a || typeof a.serviceName !== 'string' ||
        typeof a.startedAt !== 'number' || typeof a.endedAt !== 'number'))) {
      return res.status(400).json({
        error: 'agents must be an array of { serviceName: string, startedAt: number, endedAt: number }'
      });
    }

    // Validate request - allow time range queries for live tailing
    const hasTimeRange = startTime || endTime;
    const hasIdFilter = traceId || (runIds && runIds.length > 0) || sessionId || (agents && agents.length > 0);

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

    // 2. Query the active observability backend (OpenSearch cluster or file store).
    //    Precedence: a configured cluster is authoritative; otherwise the file
    //    backend is the zero-config default (local runs work out of the box).
    let realSpans: Span[] = [];
    let warning: string | undefined;
    let warningCategory: ErrorCategory | undefined;
    let suggestion: string | undefined;
    let nextCursor: string | null = null;
    let hasMore: boolean = false;
    const backend: 'opensearch' | 'file' = resolveObservabilityConfig(req) ? 'opensearch' : 'file';
    const obs = getObservabilityModule(req);

    if (traceId || (runIds && runIds.length > 0) || sessionId || startTime || endTime || (agents && agents.length > 0)) {
      try {
        const result = await obs.traces.query(
          { traceId, runIds, sessionId, startTime, endTime, size, serviceName, textSearch, cursor, agents }
        );

        realSpans = (result.spans || []) as Span[];
        nextCursor = result.nextCursor || null;
        hasMore = result.hasMore || false;
      } catch (e: any) {
        const classified = classifyOpenSearchError(e);
        console.warn(`[TracesAPI] ${backend} query failed (${classified.category}):`, classified.message);
        warning = classified.message;
        warningCategory = classified.category;
        suggestion = classified.suggestion;
      }
    }

    // File backend with no stored matches on a time-range browse → show demo
    // traces so first-run users can explore without a live agent (parity with
    // the old not-configured experience).
    if (backend === 'file' && realSpans.length === 0 && hasTimeRange && !hasIdFilter) {
      let demoSpans = getAllSampleTraceSpansWithRecentTimestamps();
      if (serviceName) {
        demoSpans = demoSpans.filter(s => s.attributes['service.name'] === serviceName);
      }
      if (textSearch) {
        const searchLower = textSearch.toLowerCase();
        demoSpans = demoSpans.filter(s => {
          if (s.name.toLowerCase().includes(searchLower)) return true;
          return Object.values(s.attributes).some(
            v => typeof v === 'string' && v.toLowerCase().includes(searchLower)
          );
        });
      }
      sampleSpans = [...sampleSpans, ...demoSpans];
    }

    // Merge: sample spans first, then real spans
    const allSpans = [...sampleSpans, ...realSpans];

    res.json({
      spans: allSpans,
      total: allSpans.length,
      nextCursor,
      hasMore,
      backend,
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
    const config = resolveObservabilityConfig(req);

    if (!config) {
      // File backend (zero-config default): traces are stored locally on disk.
      const fileObs = getObservabilityModule(req);
      const health = await fileObs.health();
      return res.json({
        ...health,
        backend: 'file',
        message: 'Using local filesystem trace storage (agent-health-data/traces). Connect an OpenSearch observability cluster to scale.',
        sampleTraceCount: getAllSampleTraceSpans().length,
      });
    }

    // Proactive credential check for SigV4 auth
    if (config.authType === 'sigv4') {
      const credError = await validateAwsCredentials(config.awsProfile);
      if (credError) {
        return res.json({
          status: 'error',
          error: credError,
          errorCategory: 'auth' as ErrorCategory,
          suggestion: `Run \`aws sso login --profile ${config.awsProfile || 'default'}\` or refresh your AWS credentials.`,
        });
      }
    }

    const obs = getObservabilityModule(req);
    const result = await obs.health();
    res.json({ ...result, backend: 'opensearch' });
  } catch (error: any) {
    res.json({ status: 'error', error: error.message });
  }
});

export default router;
