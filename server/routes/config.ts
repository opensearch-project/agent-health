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
import type { AgentConfig, ModelConfig } from '@/types/index.js';
import { VALID_CONNECTOR_TYPES } from '@/lib/constants';
import { addCustomAgent, removeCustomAgent, getCustomAgents } from '@/server/services/customAgentStore';

const router = Router();

/**
 * Validate a URL string (must be http or https).
 * Returns an error message or null if valid.
 */
function validateEndpointUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'URL must use http or https protocol';
    }
    return null;
  } catch {
    return 'Invalid URL format';
  }
}

/**
 * GET /api/agents - List all configured agents (built-in + custom)
 *
 * Returns the list of agents from the runtime configuration merged
 * with any custom agents added via the UI.
 * Used by CLI `list agents` command and frontend refreshConfig().
 */
router.get('/api/agents', (req: Request, res: Response) => {
  try {
    const config = loadConfigSync();
    // Strip hooks (functions can't be serialized to JSON)
    const configAgents = config.agents.map(({ hooks, ...rest }) => rest);
    const customAgents = getCustomAgents();
    const agents = [...configAgents, ...customAgents];
    res.json({
      agents,
      total: agents.length,
      meta: { source: 'config' },
    });
  } catch (error: any) {
    console.error('[ConfigAPI] List agents failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agents/custom - Add a custom agent endpoint
 *
 * Body: { name: string, endpoint: string, connectorType?: ConnectorProtocol, useTraces?: boolean }
 * Returns 201 with the created AgentConfig.
 */
router.post('/api/agents/custom', (req: Request, res: Response) => {
  try {
    const { name, endpoint, connectorType, useTraces } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!endpoint || typeof endpoint !== 'string' || !endpoint.trim()) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }

    const urlError = validateEndpointUrl(endpoint.trim());
    if (urlError) {
      res.status(400).json({ error: urlError });
      return;
    }

    if (connectorType !== undefined && !VALID_CONNECTOR_TYPES.includes(connectorType)) {
      res.status(400).json({ error: `connectorType must be one of: ${VALID_CONNECTOR_TYPES.join(', ')}` });
      return;
    }

    const key = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agent: AgentConfig = {
      key,
      name: name.trim(),
      endpoint: endpoint.trim(),
      isCustom: true,
      connectorType: connectorType ?? 'agui-streaming',
      useTraces: useTraces === true,
      headers: {},
    };

    addCustomAgent(agent);
    res.status(201).json({ agent });
  } catch (error: any) {
    console.error('[ConfigAPI] Add custom agent failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/agents/custom/:id - Remove a custom agent endpoint
 *
 * Returns 204 on success, 404 if not found.
 */
router.delete('/api/agents/custom/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const removed = removeCustomAgent(id);
    if (!removed) {
      res.status(404).json({ error: 'Custom agent not found' });
      return;
    }
    res.status(204).send();
  } catch (error: any) {
    console.error('[ConfigAPI] Delete custom agent failed:', error.message);
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
