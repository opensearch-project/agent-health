/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration Types
 * Type definitions for agent-health.config.ts files
 */

import type { AgentConfig, ModelConfig, ConnectorProtocol, AgentHooks } from '@/types/index.js';
import type { AgentConnector } from '@/services/connectors/types.js';

/**
 * Agent configuration for user config files
 * Extends AgentConfig with optional fields that have defaults
 */
export interface UserAgentConfig {
  key: string;
  name: string;
  endpoint: string;
  description?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  useTraces?: boolean;
  connectorType?: ConnectorProtocol;
  connectorConfig?: Record<string, any>;
  hooks?: AgentHooks;
}

/**
 * Model configuration for user config files
 */
export interface UserModelConfig {
  key: string;
  model_id: string;
  display_name: string;
  provider?: 'bedrock' | 'demo' | 'openai-compatible';
  context_window?: number;
  max_output_tokens?: number;
}

/**
 * Reporter configuration
 */
export type ReporterConfig =
  | 'console'
  | ['console']
  | ['json', { output: string }]
  | ['html', { output: string }];

/**
 * Judge configuration
 */
export interface JudgeConfig {
  provider?: 'bedrock' | 'demo' | 'openai-compatible';
  model?: string;
  region?: string;
}

/**
 * Server configuration for CLI lifecycle management
 * Follows Playwright's webServer pattern
 */
export interface ServerConfig {
  /**
   * Port to run server on
   * @default 4001
   */
  port?: number;

  /**
   * Whether to reuse an existing server if one is running
   * - true: Reuse existing server (default in dev)
   * - false: Error if server already running (default in CI)
   * @default !process.env.CI
   */
  reuseExistingServer?: boolean;

  /**
   * Timeout in ms to wait for server to start
   * @default 30000
   */
  startTimeout?: number;
}

/**
 * Resolved server configuration with all defaults applied
 */
export interface ResolvedServerConfig {
  port: number;
  reuseExistingServer: boolean;
  startTimeout: number;
}

/**
 * User configuration file structure
 * This is what users define in agent-health.config.ts
 */
export interface UserConfig {
  /**
   * Server lifecycle configuration (Playwright-style)
   * Controls how CLI starts/reuses the Agent Health server
   */
  server?: ServerConfig;

  /**
   * Custom connectors to register
   * Users can provide instances of custom connector classes
   */
  connectors?: AgentConnector[];

  /**
   * Agent configurations
   * Can include custom agents or override built-in agents
   */
  agents?: UserAgentConfig[];

  /**
   * Model configurations
   * Can include custom models or override built-in models
   */
  models?: UserModelConfig[];

  /**
   * Test case file patterns (glob)
   * e.g., './test-cases/*.yaml'
   */
  testCases?: string | string[];

  /**
   * Output reporters
   */
  reporters?: ReporterConfig[];

  /**
   * Judge configuration
   */
  judge?: JudgeConfig;

  /**
   * Remote servers for aggregating coding agent data from multiple machines.
   * Each remote runs `agent-health serve --headless` and this dashboard
   * fetches + merges their session data into a unified view.
   */
  remoteServers?: RemoteServerConfig[];

  /**
   * Enable or disable the Coding Agent Analytics feature.
   * When false, no coding agent routes are mounted, no background timers
   * run, and the "Coding Agents" nav tab is hidden.
   * Can also be disabled via AGENT_HEALTH_DISABLE_CODING_ANALYTICS=true env var.
   * @default true
   */
  codingAgentAnalytics?: boolean;

  /**
   * Whether to extend default config or replace entirely
   * Default: true (extends)
   */
  extends?: boolean;
}

/**
 * Remote server connection configuration
 */
export interface RemoteServerConfig {
  /** Display name (e.g. "ec2-build-1") */
  name: string;
  /** Server URL (e.g. "http://10.0.1.50:4001") */
  url: string;
  /** Bearer token for API key auth (matches --api-key on remote) */
  apiKey?: string;
}

/**
 * Resolved configuration after loading and merging
 */
export interface ResolvedConfig {
  server: ResolvedServerConfig;
  agents: AgentConfig[];
  models: Record<string, ModelConfig>;
  connectors: AgentConnector[];
  testCases: string[];
  reporters: ReporterConfig[];
  judge: JudgeConfig;
}

/**
 * Config file metadata
 */
export interface ConfigFileInfo {
  path: string;
  format: 'typescript' | 'javascript';
  exists: boolean;
}
