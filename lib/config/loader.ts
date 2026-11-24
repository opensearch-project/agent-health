/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Config Loader
 * Loads and resolves agent-health.config.ts files
 */

import { existsSync, readFileSync, realpathSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { resolve, join, dirname, sep } from 'path';
import { projectStatePath, userStatePath } from './statePaths.js';
import { logStartupDiagnostic } from '@/lib/diagnostics';
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
 * Runtime state file (config v2: `.agent-health/state.json`, user or project
 * scope). Loaded by the *server services* (configService, customAgentStore,
 * dataSourceConfig), not by this loader. We only probe for it so the startup
 * log can tell the user whether on-disk runtime state is in effect (ui-first
 * mode) instead of saying "No config file found".
 */
export function hasServerJsonConfig(cwd: string = process.cwd()): boolean {
  return existsSync(projectStatePath(cwd)) || existsSync(userStatePath());
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
    // Trace-correlation fields — dropping these silently broke per-agent
    // service-window correlation (fell back to protocol defaults, colliding
    // with other emitters) and per-agent poll budgets (fell back to 60×10s).
    traceServiceName: userAgent.traceServiceName,
    tracePolling: userAgent.tracePolling,
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
    // Cluster config authored in TS. Passed through verbatim; the server
    // resolves it against JSON/env at startup (see resolveStorageConfig).
    storage: userConfig.storage,
    observability: userConfig.observability,
    observabilitySources: userConfig.observabilitySources,
    evalRoots: userConfig.evalRoots,
    assistant: userConfig.assistant,
  };
}

/**
 * Load user config file.
 *
 * The file is imported with a query string keyed on the content hash of the
 * file (and of `.env` next to it, which the file may read at import) — Node
 * caches ES modules by URL for the life of the process, so a plain re-import
 * of an edited `agent-health.config.ts` would return the OLD module. An
 * edited file is a new URL, an unchanged file the same, cached one: the cache
 * grows by one module graph per distinct config version, not per run, and an
 * unchanged file is evaluated exactly once per process.
 *
 * The query only works for ES modules. A config that Node loads as CommonJS
 * (a `.js`/`.ts` file in a project whose package.json says
 * `"type": "commonjs"`, or has no `type`) is cached by FILENAME in
 * `require.cache`, where the query is ignored and the module loaded first is
 * returned (#655). So when the digest changed since this process last
 * imported the file, its stale entry — and the local modules it required —
 * is evicted first (`evictLocalCjsModules`). Consequence: in a CommonJS
 * project the config's own local imports are re-evaluated with it — when
 * Node loaded them through its CommonJS loader (tsx; built-in type stripping
 * from Node 24 on; Node 22 requires them through the ESM loader's cache,
 * where `module.children` stays empty and nothing can be evicted).
 * Limitation: for an ES-module config (and the Node 22 case above) only the
 * config file itself is re-evaluated; modules it imports are still served
 * from Node's ESM cache (restart after editing those).
 */
async function loadUserConfig(configPath: string): Promise<UserConfig> {
  // Keyed on the config file AND `<cwd>/.env`: a config that reads
  // `process.env` at import must be re-evaluated after a `.env` edit too.
  const hash = createHash('sha1').update(readFileSync(configPath));
  const envFile = join(dirname(configPath), '.env');
  if (existsSync(envFile)) hash.update(readFileSync(envFile));
  const digest = hash.digest('hex').slice(0, 16);
  // Use dynamic import with file URL for cross-platform compatibility
  const fileUrl = `${pathToFileURL(configPath).href}?reload=${digest}`;

  const previous = lastImport.get(configPath);
  if (previous?.digest !== digest) {
    // Also the local modules recorded last time: a config that threw at
    // import after requiring them left them cached (Node drops only the
    // throwing module), so they are not reachable from the entry any more.
    const evicted = evictLocalCjsModules(configPath, previous?.localModules);
    if (evicted.length) {
      logStartupDiagnostic(`[Config] Re-evaluating ${evicted.length} CommonJS module(s) of ${configPath}`);
    }
    lastImport.set(configPath, { digest, localModules: evicted });
  }

  try {
    // For TypeScript files, we need tsx or ts-node to be available
    // The CLI build process compiles TS, so this works in production
    const module = await import(fileUrl);

    return module.default ?? module;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let helpText = '';

    // Improved error messages for common issues. Deliberately checks the
    // literal word 'tsconfig' below (not a bare 'TS' substring, which would
    // false-positive on unrelated messages containing those two letters).
    if (message.includes('ERR_MODULE_NOT_FOUND') || message.includes('Cannot find')) {
      helpText = `\n\n  Ensure your cwd package.json has: {\"type\":\"module\"}`;
    }
    if (message.includes('tsconfig')) {
      helpText = `\n\n  Set TSX_TSCONFIG_PATH to your tsconfig.json location, e.g.:\n  TSX_TSCONFIG_PATH=/path/to/agent-health/tsconfig.json npx @opensearch-project/agent-health`;
    }

    throw new Error(`Failed to load config file ${configPath}: ${message}${helpText}`);
  }
}

/**
 * Per config path: the `?reload=` digest of the version imported last and the
 * CommonJS modules evicted for it — so the cache is evicted once per edit,
 * not on every run, and the modules a failed import left behind are known.
 */
const lastImport = new Map<string, { digest: string; localModules: string[] }>();

/**
 * Remove `entryPath` and, transitively, the LOCAL modules it required from
 * Node's CommonJS module cache (`require.cache`), so the next `require` /
 * `import` of it evaluates the files on disk again. Local = under the entry
 * file's directory and not under a `node_modules` directory; dependencies
 * from `node_modules` and modules outside the project keep their cached
 * (possibly stateful) instance. `alsoEvict` names further local modules to
 * evict (with their local children) when still cached. No-op for a module
 * Node loaded as ESM (not in `require.cache`). Returns the evicted filenames.
 */
export function evictLocalCjsModules(entryPath: string, alsoEvict: string[] = []): string[] {
  // require.cache is keyed by the real path (Node resolves symlinks) — or by
  // the path as given under --preserve-symlinks, so both are tried.
  let realEntry = entryPath;
  try { realEntry = realpathSync(entryPath); } catch { /* keep as given */ }
  const cache = createRequire(realEntry).cache;
  const root = dirname(realEntry) + sep;
  const isLocal = (file: string) => file.startsWith(root) && !file.includes(`${sep}node_modules${sep}`);
  const evicted = new Set<string>();
  const visit = (file: string) => {
    const entry = cache[file];
    if (!entry || evicted.has(file)) return;
    evicted.add(file);
    for (const child of entry.children ?? []) {
      if (isLocal(child.filename)) visit(child.filename);
    }
    delete cache[file];
  };
  for (const file of [realEntry, entryPath, ...alsoEvict]) visit(file);
  return [...evicted];
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
    logStartupDiagnostic(`[Config] Loading ${configFile.path}`);
    userConfig = await loadUserConfig(configFile.path);
  } else if (hasServerJsonConfig(cwd)) {
    // Code config absent, but server-side JSON config present — it's loaded
    // by separate server services (storage / observability / custom agents).
    // Be explicit so the user doesn't think *no* config is in effect.
    logStartupDiagnostic(
      `[Config] No code config (agent-health.config.{ts,js,mjs}); ` +
      `runtime state (.agent-health/state.json) detected and loaded by server ` +
      `services (ui-first mode). Using built-in defaults for agents/models.`,
    );
  } else {
    // Truly no config file — env vars and built-in defaults only.
    logStartupDiagnostic('[Config] No config file found, using defaults + environment variables');
  }

  // Merge with defaults
  const resolved = mergeConfigs(userConfig, DEFAULT_CONFIG);

  // Cache the result
  cachedConfig = resolved;
  cachedConfigPath = configFile?.path ?? null;

  logStartupDiagnostic(`[Config] Loaded ${resolved.agents.length} agents, ${Object.keys(resolved.models).length} models`);

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
    storage: undefined,
    observability: undefined,
    observabilitySources: undefined,
    evalRoots: undefined,
    assistant: undefined,
  };
}

/**
 * Clear config cache (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
  lastImport.clear();
}

/**
 * Get config file info without loading
 */
export function getConfigFileInfo(cwd: string = process.cwd()): ConfigFileInfo | null {
  return findConfigFile(cwd);
}
