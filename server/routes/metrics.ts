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
import type { ServiceWindowHint } from '../services/tracesService';
import { getObservabilityClient } from '../services/observabilityClient.js';
import { MetricsResult } from '@/types';

const router = Router();

/**
 * Validate one `agents[]` hint (the `/api/traces` shape). Returns the
 * normalized hint, or a string describing why it is invalid.
 */
function parseAgentHint(raw: unknown): ServiceWindowHint | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'each agents entry must be an object';
  const a = raw as Record<string, unknown>;
  if (typeof a.serviceName !== 'string' || !a.serviceName) return 'agents[].serviceName must be a non-empty string';
  if (typeof a.startedAt !== 'number' || !Number.isFinite(a.startedAt)) return 'agents[].startedAt must be a number (epoch ms)';
  if (typeof a.endedAt !== 'number' || !Number.isFinite(a.endedAt)) return 'agents[].endedAt must be a number (epoch ms)';
  if (a.endedAt < a.startedAt) return 'agents[].endedAt must not be before startedAt';
  if (a.sessionId !== undefined && typeof a.sessionId !== 'string') return 'agents[].sessionId must be a string when present';
  return {
    serviceName: a.serviceName,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    ...(typeof a.sessionId === 'string' && a.sessionId ? { sessionId: a.sessionId } : {}),
  };
}

/**
 * Parse the batch route's `agents` body field: a `runId -> hint[]` map (the
 * per-key form the comparison page sends). Returns the normalized map, or a
 * string describing the first validation failure. Entries whose value is an
 * empty array are dropped.
 */
function parseAgentsByRunId(raw: unknown): Record<string, ServiceWindowHint[]> | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'agents must be an object mapping runId -> [{ serviceName, startedAt, endedAt, sessionId? }]';
  }
  const out: Record<string, ServiceWindowHint[]> = {};
  for (const [rid, hints] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(hints)) return `agents["${rid}"] must be an array of hints`;
    const parsed: ServiceWindowHint[] = [];
    for (const h of hints) {
      const p = parseAgentHint(h);
      if (typeof p === 'string') return p;
      parsed.push(p);
    }
    if (parsed.length > 0) out[rid] = parsed;
  }
  return out;
}

/**
 * GET /api/metrics/:runId - Compute metrics from traces for a single run
 *   query: ?sessionId= (optional Strategy-D correlator, see the batch route below)
 *   query: ?traceId= (optional Strategy-A correlator — the eval span's own
 *     OTel traceId, shared with subprocess/HTTP agents via W3C TRACEPARENT
 *     propagation; see server/services/metricsService.ts)
 *   query: ?serviceName=&startedAt=&endedAt= (optional Strategy-C hint — the
 *     agent's OTel service.name + the run's wall-clock window in epoch ms;
 *     the same correlation the Traces tab / trace judge use)
 */
router.get('/api/metrics/:runId', async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const sessionIdParam = req.query?.sessionId;
    const sessionId = typeof sessionIdParam === 'string' && sessionIdParam ? sessionIdParam : undefined;
    const traceIdParam = req.query?.traceId;
    const traceId = typeof traceIdParam === 'string' && traceIdParam ? traceIdParam : undefined;
    let agents: ServiceWindowHint[] | undefined;
    if (req.query?.serviceName !== undefined || req.query?.startedAt !== undefined || req.query?.endedAt !== undefined) {
      const hint = parseAgentHint({
        serviceName: req.query?.serviceName,
        startedAt: Number(req.query?.startedAt),
        endedAt: Number(req.query?.endedAt),
        ...(sessionId ? { sessionId } : {}),
      });
      if (typeof hint === 'string') {
        return res.status(400).json({ error: `Invalid service-window hint: ${hint}` });
      }
      agents = [hint];
    }

    if (runId.startsWith('demo-')) {
      const sampleMetrics = computeMetricsFromSampleSpans(runId);
      if (sampleMetrics) {
        debug('MetricsAPI', 'Returning sample metrics for demo runId:', runId);
        return res.json(sampleMetrics);
      }
    }

    const obs = getObservabilityClient(req);
    if (!obs) {
      return res.status(503).json({ error: 'Observability data source not configured' });
    }

    debug('MetricsAPI', 'Computing metrics for runId:', runId);

    const metrics = await computeMetrics(runId, { client: obs.client, indexPattern: obs.indexes.traces }, sessionId, traceId, agents);

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
 *   body: { runIds: string[], sessionIds?: Record<string, string>,
 *           traceIds?: Record<string, string>,
 *           agents?: Record<string, Array<{ serviceName, startedAt, endedAt, sessionId? }>> }
 *
 * `sessionIds` is an optional runId -> agent-emitted session.id map (Strategy
 * D correlator, e.g. Claude Code's `session.id`) OR'd into the trace query
 * alongside Strategy B (`agent_health.run.id` / `gen_ai.conversation.id`) —
 * see server/services/metricsService.ts. Without it, agents that only ever
 * stamp `session.id` (never adopting our own attribute) never match this
 * query even though the SAME spans are found by the Traces tab.
 *
 * `agents` is an optional runId -> Strategy-C/D hints map: the agent's OTel
 * `service.name` plus the run's wall-clock window (and optionally its
 * `session.id`) — the exact `agents[]` element `/api/traces` accepts. It is
 * unioned with A/B/D so a report that carries NO correlation id at all (a
 * REST-connector agent that never echoed one) still gets metrics from the
 * spans its agent emitted in that window, exactly as the Traces tab and the
 * trace judge already find them. Keys need not be real run ids; results are
 * returned under whatever key the caller used.
 */
router.post('/api/metrics/batch', async (req: Request, res: Response) => {
  try {
    const { runIds, sessionIds, traceIds, agents } = req.body;

    if (!Array.isArray(runIds)) {
      return res.status(400).json({ error: 'runIds must be an array' });
    }
    // Every element must be a non-empty string: a `terms` clause with `[null]`
    // makes OpenSearch reject the whole request, and `.startsWith` below would
    // throw on a non-string — either way a client bug surfaced as a 500.
    if (!runIds.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
      return res.status(400).json({ error: 'runIds must contain only non-empty strings' });
    }
    let sessionIdByRunId: Record<string, string> | undefined;
    if (sessionIds !== undefined) {
      if (typeof sessionIds !== 'object' || sessionIds === null || Array.isArray(sessionIds)) {
        return res.status(400).json({ error: 'sessionIds must be an object mapping runId -> sessionId' });
      }
      sessionIdByRunId = {};
      for (const [rid, sid] of Object.entries(sessionIds as Record<string, unknown>)) {
        if (typeof sid === 'string' && sid) sessionIdByRunId[rid] = sid;
      }
    }
    let traceIdByRunId: Record<string, string> | undefined;
    if (traceIds !== undefined) {
      if (typeof traceIds !== 'object' || traceIds === null || Array.isArray(traceIds)) {
        return res.status(400).json({ error: 'traceIds must be an object mapping runId -> traceId' });
      }
      traceIdByRunId = {};
      for (const [rid, tid] of Object.entries(traceIds as Record<string, unknown>)) {
        if (typeof tid === 'string' && tid) traceIdByRunId[rid] = tid;
      }
    }
    let agentsByRunId: Record<string, ServiceWindowHint[]> | undefined;
    if (agents !== undefined) {
      const parsed = parseAgentsByRunId(agents);
      if (typeof parsed === 'string') {
        return res.status(400).json({ error: parsed });
      }
      agentsByRunId = parsed;
    }

    debug('MetricsAPI', 'Computing batch metrics for', runIds.length, 'runs');

    const demoRunIds = runIds.filter((id: string) => id.startsWith('demo-'));
    const realRunIds = runIds.filter((id: string) => !id.startsWith('demo-'));

    const demoResults: (MetricsResult | { runId: string; error: string; status: string })[] =
      demoRunIds.map((runId: string) => {
        const metrics = computeMetricsFromSampleSpans(runId);
        return metrics || { runId, error: 'No sample data found', status: 'error' };
      });

    let realResults: (MetricsResult | { runId: string; error: string; status: string })[] = [];

    if (realRunIds.length > 0) {
      const obs = getObservabilityClient(req);

      if (!obs) {
        realResults = realRunIds.map((runId: string) => ({
          runId,
          error: 'Observability data source not configured',
          status: 'error'
        }));
      } else {
        try {
          realResults = await computeBatchMetrics(realRunIds, { client: obs.client, indexPattern: obs.indexes.traces }, sessionIdByRunId, traceIdByRunId, agentsByRunId);
        } catch (e: any) {
          realResults = realRunIds.map((runId: string) => ({
            runId,
            error: e.message,
            status: 'error'
          }));
        }
      }
    }

    const resultsMap = new Map<string, any>();
    [...demoResults, ...realResults].forEach(r => resultsMap.set(r.runId, r));
    const results = runIds.map((id: string) => resultsMap.get(id));

    const successfulMetrics = results.filter((r): r is MetricsResult => !('error' in r));
    const aggregate = computeAggregateMetrics(successfulMetrics);

    debug('MetricsAPI', 'Batch metrics computed:', {
      total: runIds.length,
      successful: successfulMetrics.length,
      totalCost: aggregate.totalCostUsd?.toFixed(4)
    });

    res.json({ metrics: results, aggregate });
  } catch (error: any) {
    console.error('[MetricsAPI] Batch error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
