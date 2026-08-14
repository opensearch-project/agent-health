/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppConfig, ConnectorProtocol, ModelConfig } from '@/types';
import { ENV_CONFIG } from '@/lib/config';

/**
 * Single source of truth for connector type metadata.
 * Used by Settings UI (dropdown + descriptions), server validation, and browser-safety checks.
 */
export interface ConnectorTypeInfo {
  label: string;
  description: string;
  serverOnly: boolean;
}

export const CONNECTOR_TYPE_INFO: Record<ConnectorProtocol, ConnectorTypeInfo> = {
  'agui-streaming': {
    label: 'AG-UI Streaming',
    description: 'AG-UI protocol over SSE. Use for ML-Commons and AG-UI compatible agents.',
    serverOnly: false,
  },
  'rest': {
    label: 'REST',
    description: 'Standard HTTP POST. Agent receives JSON, returns JSON. No streaming.',
    serverOnly: false,
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    description: 'OpenAI chat completions format (POST /v1/chat/completions). Works with LiteLLM, Ollama, vLLM.',
    serverOnly: false,
  },
  'subprocess': {
    label: 'Subprocess',
    description: 'Runs a CLI command as a child process. Server-only — use the CLI or benchmark runner.',
    serverOnly: true,
  },
  'claude-code': {
    label: 'Claude Code',
    description: 'Invokes the Claude Code CLI. Server-only — use the CLI or benchmark runner.',
    serverOnly: true,
  },
  'pi': {
    label: 'Pi (pi.dev)',
    description: 'Invokes the pi.dev coding agent CLI. Server-only — use the CLI or benchmark runner.',
    serverOnly: true,
  },
  'strands': {
    label: 'Amazon Strands',
    description: 'Amazon Strands agent framework via Bedrock Agent Runtime API. Server-only — requires AWS SDK.',
    serverOnly: true,
  },
  'langgraph': {
    label: 'LangGraph (REST)',
    description: 'LangGraph agent via direct REST API. Use for non-AG-UI LangGraph instances.',
    serverOnly: false,
  },
  'mock': {
    label: 'Mock',
    description: 'Built-in demo agent for testing. No real endpoint needed.',
    serverOnly: false,
  },
};

/** All valid connector protocol types, derived from CONNECTOR_TYPE_INFO. */
export const VALID_CONNECTOR_TYPES = Object.keys(CONNECTOR_TYPE_INFO) as ConnectorProtocol[];

/** Connector types that work in the browser (non-serverOnly). */
export const BROWSER_SAFE_CONNECTORS = (Object.entries(CONNECTOR_TYPE_INFO) as [ConnectorProtocol, ConnectorTypeInfo][])
  .filter(([, info]) => !info.serverOnly)
  .map(([type]) => type);

/** Keys of built-in agents shipped with the tool. */
export const BUILT_IN_AGENT_KEYS = new Set(['demo', 'observio', 'claude-code', 'strands', 'pi', 'langgraph-rest']);

/**
 * True when an agent is one of the tool's shipped built-ins — as opposed to an
 * agent authored in agent-health.config.ts or a UI-added custom endpoint.
 * Prefers the server-computed `builtIn` flag (from /api/agents); falls back to
 * BUILT_IN_AGENT_KEYS for the hardcoded defaults used before refreshConfig().
 */
export function isBuiltInAgent(a: { key: string; builtIn?: boolean; isCustom?: boolean }): boolean {
  return (a.builtIn ?? BUILT_IN_AGENT_KEYS.has(a.key)) && !a.isCustom;
}

/**
 * Ordered list of preferred default agent keys, used when picking an initial
 * agent for popups/forms (e.g. QuickRunModal). The first entry that exists in
 * `DEFAULT_CONFIG.agents` (and is enabled) wins.
 *
 * `observio` is preferred because it's a fully-featured local sample agent
 * users can run end-to-end without external infra.
 */
export const PREFERRED_DEFAULT_AGENT_KEYS = ['observio', 'demo'] as const;

/**
 * Pick a sensible default agent key.
 *
 * Resolution order:
 *  1. First entry in PREFERRED_DEFAULT_AGENT_KEYS that exists and is enabled
 *  2. First enabled agent in DEFAULT_CONFIG.agents
 *  3. First agent in DEFAULT_CONFIG.agents (even if disabled)
 *  4. Empty string
 */
export function getPreferredDefaultAgentKey(): string {
  const agents = DEFAULT_CONFIG.agents || [];
  const isEnabled = (a: { enabled?: boolean }) => a.enabled !== false;
  for (const preferred of PREFERRED_DEFAULT_AGENT_KEYS) {
    const found = agents.find(a => a.key === preferred && isEnabled(a));
    if (found) return found.key;
  }
  const firstEnabled = agents.find(isEnabled);
  if (firstEnabled) return firstEnabled.key;
  return agents[0]?.key || '';
}

/**
 * Get Claude Code connector environment variables at runtime.
 * Evaluated lazily so env vars are read when needed, not at module load time.
 */
function getClaudeCodeConnectorEnv(): Record<string, string> {
  const env: Record<string, string> = {
    AWS_PROFILE: ENV_CONFIG.awsProfile || 'Bedrock',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: ENV_CONFIG.awsRegion || 'us-west-2',
    DISABLE_PROMPT_CACHING: '1',
    DISABLE_ERROR_REPORTING: '1',
  };

  if (ENV_CONFIG.claudeCodeTelemetryEnabled && ENV_CONFIG.otelExporterEndpoint) {
    env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    env.OTEL_EXPORTER_OTLP_ENDPOINT = ENV_CONFIG.otelExporterEndpoint;
    env.OTEL_SERVICE_NAME = ENV_CONFIG.otelServiceName;
    if (ENV_CONFIG.otelExporterProtocol) {
      env.OTEL_EXPORTER_OTLP_PROTOCOL = ENV_CONFIG.otelExporterProtocol;
    }
    if (ENV_CONFIG.otelExporterHeaders) {
      env.OTEL_EXPORTER_OTLP_HEADERS = ENV_CONFIG.otelExporterHeaders;
    }
  } else {
    env.DISABLE_TELEMETRY = '1';
  }

  return env;
}

// Model pricing per 1M tokens (USD)
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude Opus models
  'us.anthropic.claude-opus-4-6-v1': { input: 5.0, output: 25.0 },
  'us.anthropic.claude-opus-4-5-20251101-v1:0': { input: 5.0, output: 25.0 },
  'us.anthropic.claude-opus-4-1-20250805-v1:0': { input: 15.0, output: 75.0 },
  'us.anthropic.claude-opus-4-20250514-v1:0': { input: 15.0, output: 75.0 },
  // Claude Sonnet models
  'us.anthropic.claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { input: 3.0, output: 15.0 },
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3.0, output: 15.0 },
  // Claude Haiku models
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.0, output: 5.0 },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': { input: 0.80, output: 4.0 },
  // Default fallback
  'default': { input: 3.0, output: 15.0 },
};

export const DEFAULT_CONFIG: AppConfig = {
  agents: [
    {
      key: "demo",
      name: "Demo Agent",
      endpoint: "mock://demo",
      description: "Mock agent for testing (simulated responses)",
      connectorType: "mock",
      headers: {},
      useTraces: false,
    },
    {
      key: "observio",
      name: "Observio Sample Agent",
      endpoint: ENV_CONFIG.observioEndpoint || "http://localhost:3001/run-agent",
      description: "Observio sample agent — ReAct pattern with LangGraph and Bedrock. Start with: cd observio-sample-agent && npm run start:ag-ui",
      connectorType: "agui-streaming",
      headers: {},
      useTraces: true,
      // OTel `service.name` differs from the agent key for the observio sample
      // agent (see observio-sample-agent/src/telemetry/provider.ts), so the
      // Agent Traces page translates `prefs:agentFilter == 'observio'` to a
      // service-name filter of 'observio-sample-agent' at query time.
      traceServiceName: "observio-sample-agent",
    },
    {
      key: "claude-code",
      name: "Claude Code",
      endpoint: "claude",
      description: "Claude Code CLI agent (requires claude command installed)",
      connectorType: "claude-code",
      headers: {},
      // OTel `service.name` for claude-code is OTEL_SERVICE_NAME (default
      // 'claude-code-agent'), which differs from the agent key — so the Agent
      // Traces filter must translate key 'claude-code' to this service name,
      // otherwise filtering by Claude Code matches no spans.
      traceServiceName: ENV_CONFIG.otelServiceName,
      useTraces: ENV_CONFIG.claudeCodeTelemetryEnabled && !!ENV_CONFIG.otelExporterEndpoint,
      connectorConfig: { env: getClaudeCodeConnectorEnv() },
    },
    {
      key: "strands",
      name: "Amazon Strands",
      endpoint: "${STRANDS_AGENT_ID}",
      description: "Amazon Strands agent framework (Bedrock Agent Runtime)",
      connectorType: "strands",
      headers: {},
      useTraces: false,
      connectorConfig: {
        agentAliasId: "${STRANDS_ALIAS_ID:-TSTALIASID}",
        region: "${AWS_REGION:-us-east-1}",
      },
      enabled: false,
    },
    {
      key: "pi",
      name: "Pi (pi.dev)",
      endpoint: "pi",
      description: "Pi.dev coding agent with Agent Health package (requires pi CLI installed)",
      connectorType: "pi",
      headers: {},
      useTraces: false,
      connectorConfig: {
        packagePath: './observio-sample-agent/pi-package',
      },
      enabled: false,
    },
    {
      key: "langgraph-rest",
      name: "LangGraph (REST)",
      endpoint: "${LANGGRAPH_API_ENDPOINT:-http://localhost:8000}",
      description: "LangGraph agent via direct REST API",
      connectorType: "langgraph",
      headers: {},
      useTraces: false,
      enabled: false,
    },
  ],
  models: {
    "demo-model": {
      model_id: "mock://demo-model",
      display_name: "Demo Model",
      provider: "demo",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-opus-4.8": {
      // Real Bedrock inference profile id is `us.anthropic.claude-opus-4-8`. The
      // `-v1` suffix does not exist for 4.7+ (verified via
      // `aws bedrock list-inference-profiles --region us-west-2`); Bedrock
      // returns `ValidationException: The provided model identifier is invalid`
      // for `us.anthropic.claude-opus-4-8-v1`. 4.6 keeps the `-v1` suffix.
      model_id: "us.anthropic.claude-opus-4-8",
      display_name: "Claude Opus 4.8",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 128000
    },
    "claude-opus-4.7": {
      // `-v1` does not exist for 4.7 either (verified via list-inference-profiles
      // — real id is `us.anthropic.claude-opus-4-7`). PR #347 fixed only 4.8.
      model_id: "us.anthropic.claude-opus-4-7",
      display_name: "Claude Opus 4.7",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 128000
    },
    "claude-opus-4.6": {
      model_id: "us.anthropic.claude-opus-4-6-v1",
      display_name: "Claude Opus 4.6",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 128000
    },
    "claude-sonnet-4.6": {
      model_id: "us.anthropic.claude-sonnet-4-6",
      display_name: "Claude Sonnet 4.6",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 64000
    },
    "claude-sonnet-4.5": {
      model_id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      display_name: "Claude Sonnet 4.5",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-haiku-4.5": {
      model_id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      display_name: "Claude Haiku 4.5",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 64000
    },
    "claude-code-judge": {
      model_id: "claude-code-judge",
      display_name: "Claude Code (Judge)",
      provider: "claude-code",
      context_window: 200000,
      max_output_tokens: 16384
    },
    "agentic-claude-code": {
      model_id: "agentic-claude-code",
      display_name: "Claude Code (Agentic)",
      provider: "agentic",
      context_window: 200000,
      max_output_tokens: 16384
    },
    "agentic-custom": {
      model_id: "agentic-custom",
      display_name: "Custom Agentic Judge",
      provider: "agentic",
      context_window: 200000,
      max_output_tokens: 16384
    },
    "gpt-4o": {
      model_id: "gpt-4o",
      display_name: "GPT-4o",
      provider: "openai-compatible",
      context_window: 128000,
      max_output_tokens: 4096
    },
  },
  defaults: {
    retry_attempts: 2,
    retry_delay_ms: 1000
  }
};

export const MOCK_TOOLS = [
  { name: 'opensearch_cluster_health', description: 'Get cluster health status' },
  { name: 'opensearch_cat_nodes', description: 'List nodes and their metrics' },
  { name: 'opensearch_nodes_stats', description: 'Get extensive node statistics' },
  { name: 'opensearch_nodes_hot_threads', description: 'Get hot threads for nodes' },
  { name: 'opensearch_cat_indices', description: 'List indices' },
  { name: 'opensearch_cat_shards', description: 'List shard information' },
  { name: 'opensearch_cluster_allocation_explain', description: 'Explain shard allocation' },
  { name: 'opensearch_list_indices', description: 'List all indices with detailed information' },
];

/**
 * Metadata about agents, updated when refreshConfig() succeeds.
 */
export let agentsMeta: { hasCustomAgents: boolean; customCount: number; builtInCount: number } = {
  hasCustomAgents: false, customCount: 0, builtInCount: 0,
};

/**
 * Config change listeners.
 * App.tsx subscribes so that any refreshConfig() call triggers a
 * React re-render, making updated agents/models visible in all components.
 */
type ConfigChangeListener = () => void;
const configListeners = new Set<ConfigChangeListener>();

/**
 * Subscribe to config changes. Returns an unsubscribe function.
 */
export function subscribeConfigChange(listener: ConfigChangeListener): () => void {
  configListeners.add(listener);
  return () => { configListeners.delete(listener); };
}

/**
 * Fetch agent and model config from the server and update DEFAULT_CONFIG in place.
 * Notifies subscribers so React trees re-render with the new values.
 */
export async function refreshConfig(): Promise<void> {
  try {
    const [agentsRes, modelsRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/models'),
    ]);
    if (agentsRes.ok) {
      const { agents, meta } = await agentsRes.json();
      DEFAULT_CONFIG.agents = agents;
      if (meta) {
        agentsMeta = {
          hasCustomAgents: meta.hasCustomAgents ?? false,
          customCount: meta.customCount ?? 0,
          builtInCount: meta.builtInCount ?? 0,
        };
      }
    }
    if (modelsRes.ok) {
      const { models: modelsArray } = await modelsRes.json();
      const modelsRecord: Record<string, ModelConfig> = {};
      for (const { key, ...cfg } of modelsArray) {
        modelsRecord[key] = cfg;
      }
      DEFAULT_CONFIG.models = modelsRecord;
    }
  } catch {
    // Server unreachable — keep hardcoded defaults
  }
  configListeners.forEach(fn => fn());
}