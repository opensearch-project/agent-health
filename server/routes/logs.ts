/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Logs API Routes - Fetch agent execution logs from OpenSearch
 */

import { Request, Response, Router } from 'express';
import { fetchLogs, fetchLogsLegacy } from '../services/logsService';
import { getObservabilityClient } from '../services/observabilityClient.js';

const router = Router();

/**
 * POST /api/logs - Fetch agent execution logs from OpenSearch
 */
router.post('/api/logs', async (req: Request, res: Response) => {
  try {
    const { runId, query, startTime, endTime, size = 100 } = req.body;

    const obs = getObservabilityClient(req);
    if (!obs) {
      return res.status(503).json({ error: 'Observability data source not configured' });
    }

    const result = await fetchLogs(
      { runId, query, startTime, endTime, size },
      obs.client,
      obs.indexes.logs
    );

    res.json(result);
  } catch (error: any) {
    console.error('[LogsAPI] Error:', error);
    res.status(500).json({ error: `Logs fetch failed: ${error.message}` });
  }
});

/**
 * POST /api/opensearch/logs - Proxy OpenSearch log queries to avoid CORS
 * @deprecated Use /api/logs instead
 */
router.post('/api/opensearch/logs', async (req: Request, res: Response) => {
  try {
    const { endpoint, indexPattern, query, auth } = req.body;

    // Validate required fields
    if (!endpoint || !indexPattern || !query) {
      return res.status(400).json({
        error: 'Missing required fields: endpoint, indexPattern, and query'
      });
    }

    // Call logs service legacy proxy
    const result = await fetchLogsLegacy({
      endpoint,
      indexPattern,
      query,
      auth
    });

    res.json(result);

  } catch (error: any) {
    console.error('[OpenSearchProxy] Error:', error);
    res.status(500).json({
      error: `OpenSearch proxy failed: ${error.message}`
    });
  }
});

export default router;
