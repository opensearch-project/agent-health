/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppConfig, ModelConfig } from '@/types';
import { ENV_CONFIG, buildMLCommonsHeaders } from '@/lib/config';

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
  // Claude 4.x models (with inference profile prefix)
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { input: 3.0, output: 15.0 },
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3.0, output: 15.0 },
  // Claude 3.x models
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
      models: ["demo-model"],
      headers: {},
      useTraces: false,
    },
    {
      key: "mlcommons-local",
      name: "ML-Commons (Localhost)",
      endpoint: ENV_CONFIG.mlcommonsEndpoint,
      description: "Local OpenSearch ML-Commons conversational agent",
      connectorType: "agui-streaming",
      models: ["claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-3.5"],
      headers: buildMLCommonsHeaders(),
      useTraces: true,
    },
    {
      key: "travel-planner",
      name: "Travel Planner",
      endpoint: ENV_CONFIG.travelPlannerEndpoint,
      description: "Multi-agent Travel Planner demo (requires OTel Demo running via Docker)",
      connectorType: "agui-streaming",
      models: ["claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-3.5"],
      headers: {},
      useTraces: true,
    },
    {
      key: "claude-code",
      name: "Claude Code",
      endpoint: "claude",
      description: "Claude Code CLI agent (requires claude command installed)",
      connectorType: "claude-code",
      models: ["claude-sonnet-4"],
      headers: {},
      useTraces: ENV_CONFIG.claudeCodeTelemetryEnabled && !!ENV_CONFIG.otelExporterEndpoint,
      connectorConfig: { env: getClaudeCodeConnectorEnv() },
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
    "claude-sonnet-4.5": {
      model_id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      display_name: "Claude Sonnet 4.5",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-sonnet-4": {
      model_id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      display_name: "Claude Sonnet 4",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-haiku-3.5": {
      model_id: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
      display_name: "Claude Haiku 3.5",
      provider: "bedrock",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "gpt-4o": {
      model_id: "gpt-4o",
      display_name: "GPT-4o (via LiteLLM)",
      provider: "litellm",
      context_window: 128000,
      max_output_tokens: 4096
    },
    "deepseek-r1:8b": {
      model_id: "deepseek-r1:8b",
      display_name: "DeepSeek R1 8B (Ollama)",
      provider: "litellm",
      context_window: 128000,
      max_output_tokens: 8192
    },
    "gemma3:12b": {
      model_id: "gemma3:12b",
      display_name: "Gemma 3 12B (Ollama)",
      provider: "litellm",
      context_window: 128000,
      max_output_tokens: 8192
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
      const { agents } = await agentsRes.json();
      DEFAULT_CONFIG.agents = agents;
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