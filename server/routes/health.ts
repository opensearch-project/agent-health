/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Health Check Route
 */

import { Request, Response, Router } from 'express';
import { getVersion } from '../utils/version';

const router = Router();

/**
 * GET /health - Simple health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  console.log('[Health] Health check requested');
  res.json({
    status: 'ok',
    version: getVersion(),
    service: 'agent-health'
  });
});

export default router;
