/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Kiro workspace features — reads settings, MCP servers, agents, powers,
 * extensions, and recent CLI history from ~/.kiro/.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const KIRO_DIR = path.join(os.homedir(), '.kiro');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KiroMcpServer {
  name: string;
  command: string;
  args: string[];
  disabled: boolean;
  disabledToolCount: number;
}

export interface KiroAgent {
  name: string;
  description: string;
  hasMcpServers: boolean;
  hasHooks: boolean;
  resourceCount: number;
}

export interface KiroPower {
  name: string;
  registryId: string;
}

export interface KiroExtensionInfo {
  id: string;
  name: string;
  version: string;
}

export interface KiroWorkspaceData {
  settings: AnyObj;
  mcpServers: KiroMcpServer[];
  agents: KiroAgent[];
  powers: KiroPower[];
  extensions: KiroExtensionInfo[];
  recentCommands: string[];
}

// ─── Settings ───────────────────────────────────────────────────────────────

async function readJsonSafe(filePath: string): Promise<AnyObj> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── MCP Servers ────────────────────────────────────────────────────────────

async function getMcpServers(): Promise<KiroMcpServer[]> {
  const servers: KiroMcpServer[] = [];
  try {
    const data = await readJsonSafe(path.join(KIRO_DIR, 'settings', 'mcp.json'));
    if (data.mcpServers) {
      for (const [name, config] of Object.entries(data.mcpServers as Record<string, AnyObj>)) {
        servers.push({
          name,
          command: config.command ?? '',
          args: config.args ?? [],
          disabled: config.disabled === true,
          disabledToolCount: Array.isArray(config.disabledTools) ? config.disabledTools.length : 0,
        });
      }
    }
  } catch { /* no mcp config */ }
  return servers;
}

// ─── Agents ─────────────────────────────────────────────────────────────────

async function getAgents(): Promise<KiroAgent[]> {
  const agents: KiroAgent[] = [];
  try {
    const agentsDir = path.join(KIRO_DIR, 'agents');
    const files = await fs.readdir(agentsDir);
    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('example')) continue;
      try {
        const data = await readJsonSafe(path.join(agentsDir, file));
        agents.push({
          name: data.name || file.replace('.json', ''),
          description: typeof data.description === 'string' ? data.description.slice(0, 200) : '',
          hasMcpServers: !!(data.mcpServers && Object.keys(data.mcpServers).length > 0),
          hasHooks: !!(data.hooks && Object.keys(data.hooks).length > 0),
          resourceCount: Array.isArray(data.resources) ? data.resources.length : 0,
        });
      } catch { /* skip */ }
    }
  } catch { /* no agents dir */ }
  return agents;
}

// ─── Powers (Plugins) ───────────────────────────────────────────────────────

async function getPowers(): Promise<KiroPower[]> {
  const powers: KiroPower[] = [];
  try {
    const data = await readJsonSafe(path.join(KIRO_DIR, 'powers', 'installed.json'));
    if (Array.isArray(data.installedPowers)) {
      for (const p of data.installedPowers) {
        powers.push({
          name: p.name ?? 'unknown',
          registryId: p.registryId ?? '',
        });
      }
    }
  } catch { /* no powers */ }
  return powers;
}

// ─── Extensions ─────────────────────────────────────────────────────────────

async function getExtensions(): Promise<KiroExtensionInfo[]> {
  const extensions: KiroExtensionInfo[] = [];
  try {
    const extDir = path.join(KIRO_DIR, 'extensions');
    const entries = await fs.readdir(extDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Extension directory format: publisher.name-version-platform
      const match = entry.name.match(/^(.+?)-(\d+\.\d+\.\d+)/);
      if (match) {
        extensions.push({
          id: match[1],
          name: match[1].split('.').pop() ?? match[1],
          version: match[2],
        });
      }
    }
  } catch { /* no extensions */ }
  return extensions;
}

// ─── Recent Commands ────────────────────────────────────────────────────────

async function getRecentCommands(): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(KIRO_DIR, '.cli_bash_history'), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    // Return last 20 unique commands
    const seen = new Set<string>();
    const recent: string[] = [];
    for (let i = lines.length - 1; i >= 0 && recent.length < 20; i--) {
      const cmd = lines[i].trim();
      if (cmd && !seen.has(cmd)) {
        seen.add(cmd);
        recent.push(cmd);
      }
    }
    return recent;
  } catch {
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getKiroWorkspace(): Promise<KiroWorkspaceData> {
  const [settings, mcpServers, agents, powers, extensions, recentCommands] = await Promise.all([
    readJsonSafe(path.join(KIRO_DIR, 'settings', 'cli.json')),
    getMcpServers(),
    getAgents(),
    getPowers(),
    getExtensions(),
    getRecentCommands(),
  ]);

  return { settings, mcpServers, agents, powers, extensions, recentCommands };
}
