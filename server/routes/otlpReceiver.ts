/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Embedded OTLP/HTTP (JSON) trace receiver.
 *
 * `POST /v1/traces` accepts an OTLP/JSON ExportTraceServiceRequest and persists
 * the spans to the file trace store (`agent-health-data/traces/`). This lets
 * agent-health act as its own mini-collector for **local** runs — point an
 * agent's `OTEL_EXPORTER_OTLP_ENDPOINT` here (with `http/json`) and its traces
 * land on disk, viewable in the Traces UI with no OpenSearch or collector.
 *
 * Precedence/safety: when an OpenSearch observability cluster IS configured it
 * is authoritative — the receiver then accepts but **drops** payloads (agents
 * export to the external collector in that mode), so disk and cluster never
 * split-brain. JSON body parsing uses the app's existing 10mb limit.
 */

import { Request, Response, Router } from 'express';
import { otlpToSpans } from '../services/otlpTransform.js';
import { FileObservabilityModule } from '../adapters/observability/FileObservabilityModule.js';
import { resolveObservabilityConfig } from '../middleware/dataSourceConfig.js';
import { debug } from '../../lib/debug.js';

const router = Router();

// Fresh module per call so AGENT_HEALTH_DATA_DIR overrides (tests) are honored;
// TraceStore holds no in-memory state, so this is cheap.
function fileObservability(): FileObservabilityModule {
  return new FileObservabilityModule();
}

/**
 * POST /v1/traces — OTLP/HTTP JSON trace ingest.
 */
router.post('/v1/traces', async (req: Request, res: Response) => {
  try {
    // Cluster is authoritative when configured — never write to disk in that mode.
    if (resolveObservabilityConfig(req)) {
      debug('OTLPReceiver', 'OpenSearch observability configured — dropping local OTLP payload');
      return res.status(200).json({ partialSuccess: {} });
    }

    const spans = otlpToSpans(req.body);
    if (spans.length > 0) {
      await fileObservability().ingest(spans);
      debug('OTLPReceiver', `Ingested ${spans.length} span(s) to file trace store`);
    }

    // OTLP success response shape.
    return res.status(200).json({ partialSuccess: {} });
  } catch (error: any) {
    console.error('[OTLPReceiver] Failed to ingest traces:', error?.message || error);
    return res.status(400).json({ error: error?.message || 'Failed to ingest traces' });
  }
});

export default router;
