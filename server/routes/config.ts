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
import type { AgentConfig, ModelConfig, ConnectorProtocol } from '@/types/index.js';
import { addCustomAgent, removeCustomAgent, getCustomAgents } from '@/server/services/customAgentStore';
import { getRemoteServers } from '@/server/services/codingAgents/remoteConfig';
import fs from 'fs';
import path from 'path';

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

const VALID_CONNECTOR_TYPES: ConnectorProtocol[] = [
  'agui-streaming',
  'rest',
  'openai-compatible',
  'subprocess',
  'claude-code',
  'mock',
];

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

// ============================================================================
// Remote Servers
// ============================================================================

const CONFIG_FILENAME = 'agent-health.config.json';

function readJsonConfig(): Record<string, unknown> {
  const filePath = path.join(process.cwd(), CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(process.cwd(), CONFIG_FILENAME),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );
}

/**
 * GET /api/remote-servers — list configured remote servers (apiKey masked)
 */
router.get('/api/remote-servers', (_req: Request, res: Response) => {
  try {
    const servers = getRemoteServers();
    res.json({
      servers: servers.map(s => ({
        name: s.name,
        url: s.url,
        hasApiKey: Boolean(s.apiKey),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/remote-servers — add a remote server
 * Body: { name, url, apiKey? }
 */
router.post('/api/remote-servers', (req: Request, res: Response) => {
  try {
    const { name, url, apiKey } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!url || typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const urlError = validateEndpointUrl(url.trim());
    if (urlError) {
      res.status(400).json({ error: urlError });
      return;
    }

    const config = readJsonConfig();
    const servers = Array.isArray(config.remoteServers) ? config.remoteServers as any[] : [];

    if (servers.some((s: any) => s.name === name.trim())) {
      res.status(409).json({ error: `Server "${name.trim()}" already exists` });
      return;
    }

    const server: Record<string, string> = { name: name.trim(), url: url.trim().replace(/\/$/, '') };
    if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
      server.apiKey = apiKey.trim();
    }
    servers.push(server);
    config.remoteServers = servers;
    writeJsonConfig(config);

    res.status(201).json({ server: { name: server.name, url: server.url, hasApiKey: Boolean(server.apiKey) } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/remote-servers/:name — remove a remote server
 */
router.delete('/api/remote-servers/:name', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const config = readJsonConfig();
    const servers = Array.isArray(config.remoteServers) ? config.remoteServers as any[] : [];
    const idx = servers.findIndex((s: any) => s.name === name);
    if (idx === -1) {
      res.status(404).json({ error: `Server "${name}" not found` });
      return;
    }
    servers.splice(idx, 1);
    config.remoteServers = servers;
    writeJsonConfig(config);
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/remote-servers/:name/test — test connectivity to a remote server
 */
router.post('/api/remote-servers/:name/test', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const config = readJsonConfig();
    const servers = Array.isArray(config.remoteServers) ? config.remoteServers as any[] : [];
    const server = servers.find((s: any) => s.name === name);
    if (!server) {
      res.status(404).json({ error: `Server "${name}" not found` });
      return;
    }

    const headers: Record<string, string> = {};
    if (server.apiKey) headers['Authorization'] = `Bearer ${server.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${server.url}/api/coding-agents/available`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) {
        const data = await response.json() as { agents?: Array<{ name: string }> };
        res.json({ status: 'ok', agents: data.agents?.length ?? 0 });
      } else {
        res.json({ status: 'error', message: `HTTP ${response.status} ${response.statusText}` });
      }
    } catch (fetchError: any) {
      clearTimeout(timer);
      res.json({ status: 'error', message: fetchError.message || 'Connection failed' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
