/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Config Loader
 * Loads and resolves agent-health.config.ts files
 */

import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import type { AgentConfig, ModelConfig } from '@/types';
import type { AgentConnector } from '@/services/connectors/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { DEFAULT_BACKEND_PORT, resolveBackendPort } from '@/lib/portConfig';
import type {
  UserConfig,
  UserAgentConfig,
  UserModelConfig,
  ResolvedConfig,
  ResolvedServerConfig,
  ConfigFileInfo,
  ReporterConfig,
  JudgeConfig,
  TelemetryConfig,
} from './types';

/**
 * Default server configuration
 * Follows Playwright's webServer pattern
 */
export const DEFAULT_SERVER_CONFIG: ResolvedServerConfig = {
  port: resolveBackendPort(),
  reuseExistingServer: !process.env.CI,
  startTimeout: 30000,
};

/**
 * Config file names to search for (in priority order)
 */
const CONFIG_FILE_NAMES = [
  'agent-health.config.ts',
  'agent-health.config.js',
  'agent-health.config.mjs',
];

/**
 * Server-side JSON config file. Loaded by the *server services*
 * (configService, customAgentStore, dataSourceConfig, etc.), not by this
 * loader — the schemas are different. We only probe for it here so the
 * startup log can accurately tell the user whether *any* on-disk config
 * was picked up, instead of saying "No config file found" when the JSON
 * file is in fact driving OpenSearch / Bedrock / agents.
 */
const SERVER_JSON_CONFIG_FILENAME = 'agent-health.config.json';

/**
 * Check whether the server-side JSON config exists in the given directory.
 * This file is *not* loaded by this loader — it's a separate config plane
 * for runtime (storage, observability, custom agents) read directly by
 * server services. We only surface its presence in the startup log.
 */
export function hasServerJsonConfig(cwd: string = process.cwd()): boolean {
  return existsSync(resolve(cwd, SERVER_JSON_CONFIG_FILENAME));
}

/**
 * Find config file in the given directory
 */
export function findConfigFile(cwd: string = process.cwd()): ConfigFileInfo | null {
  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = resolve(cwd, fileName);
    if (existsSync(filePath)) {
      const format = fileName.endsWith('.ts') ? 'typescript' : 'javascript';
      return { path: filePath, format, exists: true };
    }
  }
  return null;
}

/**
 * Convert UserAgentConfig to AgentConfig
 */
function toAgentConfig(userAgent: UserAgentConfig): AgentConfig {
  return {
    key: userAgent.key,
    name: userAgent.name,
    endpoint: userAgent.endpoint,
    description: userAgent.description,
    enabled: userAgent.enabled ?? true,
    headers: userAgent.headers ?? {},
    useTraces: userAgent.useTraces ?? false,
    connectorType: userAgent.connectorType,
    connectorConfig: userAgent.connectorConfig,
    hooks: userAgent.hooks,
  };
}

/**
 * Convert UserModelConfig to ModelConfig entry
 */
function toModelConfig(userModel: UserModelConfig): [string, ModelConfig] {
  return [
    userModel.key,
    {
      model_id: userModel.model_id,
      display_name: userModel.display_name,
      provider: userModel.provider ?? 'bedrock',
      context_window: userModel.context_window ?? 200000,
      max_output_tokens: userModel.max_output_tokens ?? 4096,
    },
  ];
}

/**
 * Merge user config with defaults
 */
function mergeConfigs(
  userConfig: UserConfig,
  defaultConfig: typeof DEFAULT_CONFIG
): ResolvedConfig {
  const shouldExtend = userConfig.extends !== false;

  // Merge agents
  let agents: AgentConfig[];
  if (shouldExtend) {
    // Start with defaults, override/add user agents
    const agentMap = new Map<string, AgentConfig>();
    for (const agent of defaultConfig.agents) {
      agentMap.set(agent.key, agent);
    }
    for (const userAgent of userConfig.agents ?? []) {
      agentMap.set(userAgent.key, toAgentConfig(userAgent));
    }
    agents = Array.from(agentMap.values());
  } else {
    // Only use user agents
    agents = (userConfig.agents ?? []).map(toAgentConfig);
  }

  // Merge models
  let models: Record<string, ModelConfig>;
  if (shouldExtend) {
    models = { ...defaultConfig.models };
    for (const userModel of userConfig.models ?? []) {
      const [key, config] = toModelConfig(userModel);
      models[key] = config;
    }
  } else {
    models = {};
    for (const userModel of userConfig.models ?? []) {
      const [key, config] = toModelConfig(userModel);
      models[key] = config;
    }
  }

  // Connectors (always additive)
  const connectors: AgentConnector[] = userConfig.connectors ?? [];

  // Test cases
  const testCases: string[] = userConfig.testCases
    ? Array.isArray(userConfig.testCases)
      ? userConfig.testCases
      : [userConfig.testCases]
    : [];

  // Reporters
  const reporters: ReporterConfig[] = userConfig.reporters ?? [['console']];

  // Judge config
  const judge: JudgeConfig = userConfig.judge ?? {
    provider: 'bedrock',
    model: 'claude-sonnet-4',
  };

  // Server config (merge user overrides with defaults)
  const server: ResolvedServerConfig = {
    ...DEFAULT_SERVER_CONFIG,
    ...userConfig.server,
  };

  // Telemetry config (user config overrides env vars, resolved at init time)
  const telemetry: TelemetryConfig = userConfig.telemetry ?? {};

  return {
    server,
    agents,
    models,
    connectors,
    testCases,
    reporters,
    judge,
    telemetry,
  };
}

/**
 * Load user config file
 */
async function loadUserConfig(configPath: string): Promise<UserConfig> {
  try {
    // Use dynamic import with file URL for cross-platform compatibility
    const fileUrl = pathToFileURL(configPath).href;

    // For TypeScript files, we need tsx or ts-node to be available
    // The CLI build process compiles TS, so this works in production
    const module = await import(fileUrl);

    return module.default ?? module;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config file ${configPath}: ${message}`);
  }
}

/**
 * Cached resolved config
 */
let cachedConfig: ResolvedConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load and resolve configuration
 *
 * @param cwd - Working directory to search for config file
 * @param force - Force reload even if cached
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  force: boolean = false
): Promise<ResolvedConfig> {
  const configFile = findConfigFile(cwd);

  // Return cached config if available and unchanged
  if (!force && cachedConfig && cachedConfigPath === configFile?.path) {
    return cachedConfig;
  }

  let userConfig: UserConfig = {};

  if (configFile) {
    console.log(`[Config] Loading ${configFile.path}`);
    userConfig = await loadUserConfig(configFile.path);
  } else if (hasServerJsonConfig(cwd)) {
    // Code config absent, but server-side JSON config present — it's loaded
    // by separate server services (storage / observability / custom agents).
    // Be explicit so the user doesn't think *no* config is in effect.
    console.log(
      `[Config] No code config (agent-health.config.{ts,js,mjs}); ` +
      `server JSON config (${SERVER_JSON_CONFIG_FILENAME}) detected and ` +
      `loaded by server services. Using built-in defaults for agents/models.`,
    );
  } else {
    // Truly no config file — env vars and built-in defaults only.
    console.log('[Config] No config file found, using defaults + environment variables');
  }

  // Merge with defaults
  const resolved = mergeConfigs(userConfig, DEFAULT_CONFIG);

  // Cache the result
  cachedConfig = resolved;
  cachedConfigPath = configFile?.path ?? null;

  console.log(`[Config] Loaded ${resolved.agents.length} agents, ${Object.keys(resolved.models).length} models`);

  return resolved;
}

/**
 * Load config synchronously (for use in module initialization)
 * Returns defaults if no config file or if loading fails
 */
export function loadConfigSync(cwd: string = process.cwd()): ResolvedConfig {
  // Return cached if available
  if (cachedConfig) {
    return cachedConfig;
  }

  // Return defaults - async loading will update later
  return {
    server: DEFAULT_SERVER_CONFIG,
    agents: DEFAULT_CONFIG.agents as AgentConfig[],
    models: DEFAULT_CONFIG.models,
    connectors: [],
    testCases: [],
    reporters: [['console']],
    judge: { provider: 'bedrock', model: 'claude-sonnet-4' },
    telemetry: {},
  };
}

/**
 * Clear config cache (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
}

/**
 * Get config file info without loading
 */
export function getConfigFileInfo(cwd: string = process.cwd()): ConfigFileInfo | null {
  return findConfigFile(cwd);
}
