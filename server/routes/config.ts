/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Config Routes - Expose configuration data via HTTP API
 *
 * These endpoints allow CLI commands to fetch agent and model configurations
 * through the server API instead of importing config directly.
 * This follows the server-mediated architecture pattern.
 */

import { Router, Request, Response } from 'express';
import { loadConfigSync } from '@/lib/config/index';
import type { ModelConfig } from '@/types/index.js';

const router = Router();

/**
 * GET /api/agents - List all configured agents
 *
 * Returns the list of agents from the runtime configuration.
 * Used by CLI `list agents` command.
 */
router.get('/api/agents', (req: Request, res: Response) => {
  try {
    const config = loadConfigSync();
    res.json({
      agents: config.agents,
      total: config.agents.length,
      meta: { source: 'config' },
    });
  } catch (error: any) {
    console.error('[ConfigAPI] List agents failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/models - List all configured models
 *
 * Returns the list of models from the runtime configuration.
 * Used by CLI `list models` command.
 */
router.get('/api/models', (req: Request, res: Response) => {
  try {
    const config = loadConfigSync();
    const modelEntries = Object.entries(config.models) as Array<[string, ModelConfig]>;
    const models = modelEntries.map(([key, modelConfig]) => ({
      key,
      ...modelConfig,
    }));
    res.json({
      models,
      total: models.length,
      meta: { source: 'config' },
    });
  } catch (error: any) {
    console.error('[ConfigAPI] List models failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
