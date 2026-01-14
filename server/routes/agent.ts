/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Proxy Route - Forward requests to agent endpoints
 */

import { Request, Response, Router } from 'express';
import { proxyAgentRequest, validateAgentRequest } from '../services/agentService';

const router = Router();

/**
 * POST /api/agent - Proxy agent requests to avoid CORS
 * Forwards request to the actual agent endpoint and streams SSE response back
 */
router.post('/api/agent', async (req: Request, res: Response) => {
  console.log('[Route /api/agent] Request received, endpoint:', req.body.endpoint);

  try {
    const { endpoint, payload, headers } = req.body;

    // Validate request
    const validation = validateAgentRequest({ endpoint, payload });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Proxy request and stream response
    await proxyAgentRequest({ endpoint, payload, headers }, res);

  } catch (error: any) {
    console.error('[AgentProxy] Error:', error);
    res.status(500).json({
      error: `Agent proxy failed: ${error.message}`
    });
  }
});

export default router;
