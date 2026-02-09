/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Proxy Route - Forward requests to agent endpoints
 */

import { Request, Response, Router } from 'express';
import { proxyAgentRequest, validateAgentRequest } from '../services/agentService';
import { loadConfigSync } from '@/lib/config/index';
import { executeBeforeRequestHook } from '@/lib/hooks';

const router = Router();

/**
 * POST /api/agent - Proxy agent requests to avoid CORS
 * Forwards request to the actual agent endpoint and streams SSE response back
 */
router.post('/api/agent', async (req: Request, res: Response) => {
  console.log('[Route /api/agent] Request received, endpoint:', req.body.endpoint);

  try {
    let { endpoint, payload, headers } = req.body;
    const { agentKey } = req.body;

    // Validate request
    const validation = validateAgentRequest({ endpoint, payload });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Execute beforeRequest hook if agent has one configured
    if (agentKey) {
      const config = loadConfigSync();
      const agentConfig = config.agents.find(a => a.key === agentKey);
      if (agentConfig?.hooks) {
        const hookResult = await executeBeforeRequestHook(
          agentConfig.hooks,
          { endpoint, payload, headers: headers || {} },
          agentKey
        );
        endpoint = hookResult.endpoint;
        payload = hookResult.payload;
        headers = hookResult.headers;
      }
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
