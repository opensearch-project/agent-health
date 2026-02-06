/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppConfig } from '@/types';
import { ENV_CONFIG, buildMLCommonsHeaders } from '@/lib/config';

/**
 * Get Claude Code connector environment variables at runtime.
 * This ensures environment variables are evaluated when needed,
 * not at module load time.
 */
function getClaudeCodeConnectorEnv(): Record<string, string> {
  return {
    AWS_PROFILE: process.env.AWS_PROFILE || "Bedrock",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: process.env.AWS_REGION || "us-west-2",
    DISABLE_PROMPT_CACHING: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  };
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
      key: "langgraph",
      name: "Langgraph",
      endpoint: ENV_CONFIG.langgraphEndpoint,
      description: "Langgraph AG-UI agent server",
      connectorType: "agui-streaming",
      models: [
        "claude-sonnet-4.5",
        "claude-sonnet-4",
        "claude-haiku-3.5",
      ],
      headers: {},
      useTraces: true,
    },
    {
      key: "mlcommons-local",
      name: "ML-Commons (Localhost)",
      endpoint: ENV_CONFIG.mlcommonsEndpoint,
      description: "Local OpenSearch ML-Commons conversational agent",
      connectorType: "agui-streaming",
      models: [
        "claude-sonnet-4.5",
        "claude-sonnet-4",
        "claude-haiku-3.5",
      ],
      headers: buildMLCommonsHeaders(),
      useTraces: true,
    },
    {
      key: "holmesgpt",
      name: "HolmesGPT",
      endpoint: ENV_CONFIG.holmesGptEndpoint,
      description: "HolmesGPT AI-powered RCA agent (AG-UI)",
      connectorType: "agui-streaming",
      models: [
        "claude-sonnet-4.5",
        "claude-sonnet-4",
        "claude-haiku-3.5",
      ],
      headers: {},
      useTraces: true
    },
    {
      key: "claude-code",
      name: "Claude Code",
      endpoint: "claude",  // Command name, not URL
      description: "Claude Code CLI agent (requires claude command installed)",
      connectorType: "claude-code",
      models: ["claude-sonnet-4"],
      headers: {},
      useTraces: false,
      // connectorConfig env vars are evaluated at runtime by getClaudeCodeConnectorEnv()
      get connectorConfig() {
        return {
          env: getClaudeCodeConnectorEnv(),
        };
      },
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