/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-run refresh of what a server-executed run reads from the project (#612).
 *
 * A UI-started run executes inside the long-lived server, which loaded
 * `agent-health.config.*` and `.env` once at boot. Editing either used to
 * have no effect until the user found and restarted the server. Every
 * server-executed run now starts by re-reading both:
 *
 *   1. `<cwd>/.env` — applied with shell > `.env` precedence preserved
 *      (lib/config/envReload.ts), BEFORE the config so a config file that
 *      reads `process.env` at import sees the new values;
 *   2. `agent-health.config.*` — `loadConfig(cwd, force)` re-evaluates the
 *      file (edited file → new module), refreshing the process-wide config
 *      cache every `loadConfigSync()` caller reads.
 *
 * Still requires a restart (documented in docs/CONFIGURATION.md): variables
 * exported in the shell that started the server, connectors declared in the
 * config (registered once at boot), and anything a connector or hook cached
 * in module scope.
 */

import { loadConfig } from '@/lib/config/index';
import { reloadDotenv, type ReloadDotenvResult } from '@/lib/config/envReload';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { debug } from '@/lib/debug';
import type { AgentConfig, ModelConfig } from '@/types';

export interface RefreshedRunEnvironment {
  agents: AgentConfig[];
  models: Record<string, ModelConfig>;
  env: ReloadDotenvResult;
}

/**
 * Re-read `.env` and the config file from `cwd`. Throws when the config file
 * no longer loads (the user is editing it and wants to know), never for a
 * missing `.env`.
 */
export async function refreshRunEnvironment(cwd: string = process.cwd()): Promise<RefreshedRunEnvironment> {
  const env = reloadDotenv(cwd);
  if (env.applied.length || env.removed.length) {
    debug('RunEnvironment', `.env re-read: applied=[${env.applied.join(', ')}] removed=[${env.removed.join(', ')}] skipped=[${env.skipped.join(', ')}]`);
  }
  const config = await loadConfig(cwd, true);
  return { agents: [...config.agents, ...getCustomAgents()], models: config.models, env };
}
