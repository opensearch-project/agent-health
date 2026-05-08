/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @experimental Session Metadata Routes
 *
 * Generic sidecar metadata for coding agent sessions.
 * One GET, one PUT — callers define the schema.
 */

import { Router, Request, Response } from 'express';
import { getStorageModule } from '../adapters/index.js';

const router = Router();

/**
 * GET /api/coding-agents/sessions/:agent/:sessionId/metadata
 * Read session metadata. Returns null body if none exists.
 */
router.get('/api/coding-agents/sessions/:agent/:sessionId/metadata', async (req: Request, res: Response) => {
  try {
    const { agent, sessionId } = req.params;
    const storage = getStorageModule();
    const doc = await storage.sessionMetadata.get(agent, sessionId);
    res.json(doc || null);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/coding-agents/sessions/:agent/:sessionId/metadata
 * Upsert session metadata. Merges with existing data; agentKind/sessionId are immutable.
 */
router.put('/api/coding-agents/sessions/:agent/:sessionId/metadata', async (req: Request, res: Response) => {
  try {
    const { agent, sessionId } = req.params;
    const data = req.body;

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    if ('agentKind' in data || 'sessionId' in data) {
      return res.status(400).json({ error: 'agentKind and sessionId cannot be set in body' });
    }

    const storage = getStorageModule();
    const doc = await storage.sessionMetadata.put(agent, sessionId, data);
    res.json(doc);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/sessions/metadata
 * List all sessions that have metadata.
 */
router.get('/api/coding-agents/sessions/metadata', async (req: Request, res: Response) => {
  try {
    const size = parseInt(req.query.size as string) || 100;
    const from = parseInt(req.query.from as string) || 0;
    const storage = getStorageModule();
    const result = await storage.sessionMetadata.list({ size, from });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
