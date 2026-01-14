/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppConfig } from '@/types';
import { ENV_CONFIG, buildMLCommonsHeaders } from './config';

// Model pricing per 1M tokens (USD)
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 4.x models
  'anthropic.claude-sonnet-4-20250514-v1:0': { input: 3.0, output: 15.0 },
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3.0, output: 15.0 },
  'anthropic.claude-haiku-4-5-20250514-v1:0': { input: 0.80, output: 4.0 },
  'global.anthropic.claude-opus-4-5-20251101-v1:0': { input: 15.0, output: 75.0 },
  // Claude 3.x models
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3.0, output: 15.0 },
  'anthropic.claude-3-7-sonnet-20250219-v1:0': { input: 3.0, output: 15.0 },
  // Generic model name patterns
  'anthropic.claude-sonnet-4': { input: 3.0, output: 15.0 },
  'anthropic.claude-sonnet-4.5': { input: 3.0, output: 15.0 },
  'anthropic.claude-haiku-4': { input: 0.80, output: 4.0 },
  'anthropic.claude-opus-4.5': { input: 15.0, output: 75.0 },
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
      models: ["demo-model"],
      headers: {},
      useTraces: false,
    },
    {
      key: "langgraph",
      name: "Langgraph",
      endpoint: ENV_CONFIG.langgraphEndpoint,
      description: "Langgraph AG-UI agent server",
      models: [
        "claude-sonnet-4.5",
      ],
      headers: {}, // No headers needed for Langgraph
      useTraces: true, // Use traces instead of logs for evaluation (traces take ~5 min to propagate)
    },
    {
      key: "mlcommons-local",
      name: "ML-Commons (Localhost)",
      endpoint: ENV_CONFIG.mlcommonsEndpoint,
      description: "Local OpenSearch ML-Commons conversational agent",
      models: [
        "claude-sonnet-4",
        "claude-sonnet-4.5",
        "claude-opus-4.5",
        "claude-sonnet-3.5",
        "claude-sonnet-3.7",
        "claude-haiku-4.5"
      ],
      headers: buildMLCommonsHeaders(),
      useTraces: true,
    },
    {
      key: "holmesgpt",
      name: "HolmesGPT",
      endpoint: ENV_CONFIG.holmesGptEndpoint,
      description: "HolmesGPT AI-powered RCA agent (AG-UI)",
      models: [
        "claude-sonnet-4",
        "claude-sonnet-4.5",
        "claude-opus-4.5",
        "claude-sonnet-3.5",
        "claude-sonnet-3.7",
        "claude-haiku-4.5"
      ],
      headers: {},
      useTraces: true
    }
  ],
  judges: [
    {
      key: "demo",
      name: "Demo Judge",
      endpoint: "mock://demo",
      description: "Mock judge for testing (simulated evaluations)",
    },
    {
      key: "bedrock",
      name: "AWS Bedrock",
      endpoint: "bedrock://",
      description: "AWS Bedrock LLM judge for real evaluations",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      region: "us-west-2",
    }
  ],
  models: {
    "demo-model": {
      model_id: "mock://demo-model",
      display_name: "Demo Model",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-sonnet-4": {
      model_id: "anthropic.claude-sonnet-4-20250514-v1:0",
      display_name: "Claude Sonnet 4",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-sonnet-4.5": {
      model_id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      display_name: "Claude Sonnet 4.5",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-haiku-4.5": {
      model_id: "anthropic.claude-haiku-4-5-20250514-v1:0",
      display_name: "Claude Haiku 4.5",
      context_window: 200000,
      max_output_tokens: 4096
    },
    "claude-sonnet-3.5": {
      model_id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      display_name: "Claude Sonnet 3.5",
      context_window: 200000,
      max_output_tokens: 8192
    },
    "claude-sonnet-3.7": {
      model_id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      display_name: "Claude Sonnet 3.7",
      context_window: 200000,
      max_output_tokens: 8192
    },
    "claude-opus-4.5": {
      model_id: "global.anthropic.claude-opus-4-5-20251101-v1:0",
      display_name: "Claude Opus 4.5",
      context_window: 200000,
      max_output_tokens: 32000
    }
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