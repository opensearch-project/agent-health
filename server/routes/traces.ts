/**
 * Traces API Routes - Fetch and query OpenSearch traces
 */

import { Request, Response, Router } from 'express';
import { fetchTraces, checkTracesHealth } from '../services/tracesService';

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

    // Get OpenSearch configuration
    const endpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
    const username = process.env.OPENSEARCH_LOGS_USERNAME;
    const password = process.env.OPENSEARCH_LOGS_PASSWORD;
    const indexPattern = process.env.OPENSEARCH_LOGS_TRACES_INDEX || 'otel-v1-apm-span-*';

    if (!endpoint || !username || !password) {
      return res.status(500).json({
        error: 'OpenSearch Logs not configured. Please set OPENSEARCH_LOGS_ENDPOINT, OPENSEARCH_LOGS_USERNAME, and OPENSEARCH_LOGS_PASSWORD.'
      });
    }

    // Call traces service to fetch traces
    const result = await fetchTraces(
      { traceId, runIds, startTime, endTime, size, serviceName, textSearch },
      { endpoint, username, password, indexPattern }
    );

    res.json(result);

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
    const endpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
    const username = process.env.OPENSEARCH_LOGS_USERNAME;
    const password = process.env.OPENSEARCH_LOGS_PASSWORD;
    const indexPattern = process.env.OPENSEARCH_LOGS_TRACES_INDEX || 'otel-v1-apm-span-*';

    // Call traces service to check health
    const result = await checkTracesHealth({
      endpoint,
      username,
      password,
      indexPattern
    });

    res.json(result);
  } catch (error: any) {
    res.json({ status: 'error', error: error.message });
  }
});

export default router;
