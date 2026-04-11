/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Health Check Route
 */

import { Request, Response, Router } from 'express';
import { getVersion } from '../utils/version';
import { codingAnalyticsEnabled } from '../services/codingAgents';

const router = Router();

/**
 * GET /health - Simple health check endpoint
 * Includes feature flags so the frontend can conditionally render UI.
 */
router.get('/health', (req: Request, res: Response) => {
  console.log('[Health] Health check requested');
  res.json({
    status: 'ok',
    version: getVersion(),
    service: 'agent-health',
    features: {
      codingAgentAnalytics: codingAnalyticsEnabled,
    },
  });
});

export default router;
