/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API Key Authentication Middleware
 * When AH_API_KEY (legacy: AGENT_HEALTH_API_KEY) is set, requires Bearer
 * token on /api/coding-agents/* routes. When not set, all requests pass
 * through (backwards compatible).
 */

import { Request, Response, NextFunction } from 'express';
import { readEnv } from '@/lib/envCompat';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const requiredKey = readEnv('AH_API_KEY', 'AGENT_HEALTH_API_KEY');
  if (!requiredKey) return next();

  // Only protect coding-agents API routes
  if (!req.path.startsWith('/api/coding-agents')) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: API key required' });
    return;
  }

  const providedKey = authHeader.slice(7);
  if (providedKey !== requiredKey) {
    res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    return;
  }

  next();
}
