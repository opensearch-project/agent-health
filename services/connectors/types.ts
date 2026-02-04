/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TestCase, TrajectoryStep } from '@/types';

// ============ Connector Protocol Types ============

/**
 * Protocol type for agent communication
 * - agui-streaming: AG-UI protocol over SSE (current default)
 * - rest: Non-streaming REST API
 * - subprocess: CLI tools invoked as child processes
 * - claude-code: Claude Code CLI (specialized subprocess)
 * - mock: Demo/testing connector
 */
export type ConnectorProtocol = 'agui-streaming' | 'rest' | 'subprocess' | 'claude-code' | 'mock';

// ============ Authentication Types ============

/**
 * Authentication type for connectors
 */
export type ConnectorAuthType = 'none' | 'basic' | 'bearer' | 'api-key' | 'aws-sigv4';

/**
 * Authentication configuration for connectors
 * Each connector handles its own auth strategy
 */
export interface ConnectorAuth {
  type: ConnectorAuthType;

  // Basic auth
  username?: string;
  password?: string;

  // Bearer token / API key
  token?: string;

  // AWS SigV4
  awsRegion?: string;
  awsService?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;

  // Custom headers (always applied)
  headers?: Record<string, string>;
}

// ============ Request/Response Types ============

/**
 * Standard request format that connectors transform to agent-specific format
 */
export interface ConnectorRequest {
  testCase: TestCase;
  modelId: string;
  threadId?: string;
  runId?: string;
}

/**
 * Response from connector execution
 */
export interface ConnectorResponse {
  trajectory: TrajectoryStep[];
  runId: string | null;
  rawEvents?: any[]; // Protocol-specific raw events for debugging
  metadata?: Record<string, any>; // Additional connector-specific data
}

/**
 * Progress callback for streaming connectors
 */
export type ConnectorProgressCallback = (step: TrajectoryStep) => void;

/**
 * Raw event callback for debugging
 */
export type ConnectorRawEventCallback = (event: any) => void;

// ============ Connector Interface ============

/**
 * Base connector interface - all connectors must implement this
 */
export interface AgentConnector {
  /** Unique identifier for this connector type */
  readonly type: ConnectorProtocol;

  /** Human-readable name */
  readonly name: string;

  /** Whether this connector supports streaming */
  readonly supportsStreaming: boolean;

  /**
   * Transform standard request to agent-specific payload
   */
  buildPayload(request: ConnectorRequest): any;

  /**
   * Execute the request and return trajectory
   * @param endpoint - Agent endpoint URL or command
   * @param request - Standard request format
   * @param auth - Authentication configuration
   * @param onProgress - Optional callback for streaming progress
   * @param onRawEvent - Optional callback for raw events (debugging)
   */
  execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse>;

  /**
   * Parse raw response into TrajectoryStep array
   * Used internally by execute() and for re-processing stored raw events
   */
  parseResponse(rawResponse: any): TrajectoryStep[];

  /**
   * Optional health check for the connector
   */
  healthCheck?(endpoint: string, auth: ConnectorAuth): Promise<boolean>;
}

// ============ Subprocess Connector Types ============

/**
 * Input mode for subprocess connectors
 */
export type SubprocessInputMode = 'stdin' | 'arg';

/**
 * Output parser type for subprocess connectors
 */
export type SubprocessOutputParser = 'json' | 'text' | 'streaming';

/**
 * Configuration for subprocess-based connectors
 */
export interface SubprocessConfig {
  command: string; // e.g., "claude"
  args?: string[]; // Command arguments
  env?: Record<string, string>; // Environment variables
  inputMode: SubprocessInputMode; // How to pass the prompt
  outputParser: SubprocessOutputParser; // How to parse output
  timeout?: number; // Timeout in milliseconds (default: 300000 = 5 min)
  workingDir?: string; // Working directory for the process
}

// ============ Extended Agent Config ============

/**
 * Extended AgentConfig with connector specification
 * Extends the base AgentConfig from types/index.ts
 */
export interface AgentConfigWithConnector {
  key: string;
  name: string;
  endpoint: string;
  description?: string;
  enabled?: boolean;
  models: string[];
  headers?: Record<string, string>;
  useTraces?: boolean;

  /** Connector type to use (defaults to 'agui-streaming' for backwards compat) */
  connectorType?: ConnectorProtocol;

  /** Connector-specific configuration */
  connectorConfig?: SubprocessConfig | Record<string, any>;

  /** Authentication configuration */
  auth?: ConnectorAuth;
}

// ============ Registry Types ============

/**
 * Registry for connector implementations
 * Allows code-level registration of new connectors
 */
export interface ConnectorRegistry {
  /**
   * Register a connector implementation
   */
  register(connector: AgentConnector): void;

  /**
   * Get a connector by protocol type
   */
  get(type: ConnectorProtocol): AgentConnector | undefined;

  /**
   * Get all registered connectors
   */
  getAll(): AgentConnector[];

  /**
   * Check if a connector is registered
   */
  has(type: ConnectorProtocol): boolean;

  /**
   * Get connector for an agent config (with fallback to default)
   */
  getForAgent(agent: AgentConfigWithConnector): AgentConnector;

  /**
   * Get list of registered connector types
   */
  getRegisteredTypes(): ConnectorProtocol[];

  /**
   * Clear all registered connectors (useful for testing)
   */
  clear(): void;
}

// ============ Execution Options ============

/**
 * Options for connector execution
 */
export interface ConnectorExecuteOptions {
  timeout?: number; // Overall timeout in milliseconds
  retries?: number; // Number of retries on failure
  retryDelay?: number; // Delay between retries in milliseconds
}
