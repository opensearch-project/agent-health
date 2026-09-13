/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TestCase, TrajectoryStep, AgentHooks } from '@/types';

// ============ Connector Protocol Types ============

/**
 * Protocol type for agent communication
 * - agui-streaming: AG-UI protocol over SSE (current default)
 * - rest: Non-streaming REST API
 * - openai-compatible: OpenAI chat completions format (LiteLLM, Ollama, vLLM)
 * - subprocess: CLI tools invoked as child processes
 * - claude-code: Claude Code CLI (specialized subprocess)
 * - strands: Amazon Strands via Bedrock Agent Runtime API
 * - langgraph: LangGraph agent via direct REST API
 * - mock: Demo/testing connector
 */
export type WellKnownConnectorProtocol =
  | 'agui-streaming'
  | 'rest'
  | 'openai-compatible'
  | 'subprocess'
  | 'claude-code'
  | 'kiro'
  | 'pi'
  | 'pi-web'
  | 'strands'
  | 'langgraph'
  | 'mock';

/** Well-known names plus third-party names registered through config. */
export type ConnectorProtocol = WellKnownConnectorProtocol | (string & {});

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
  /**
   * Pre-built payload from hook processing.
   * When set, connectors should use this directly instead of calling buildPayload().
   * This ensures that any modifications made by beforeRequest hooks are preserved.
   */
  payload?: any;
  /**
   * Connector-specific configuration from agent config.
   * Threaded from agent.connectorConfig at evaluation time.
   */
  connectorConfig?: Record<string, any>;
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

// ============ Trace Context Propagation ============

/**
 * Per-connector configuration for propagating OTel trace context to the
 * downstream agent, so the agent's spans become children of agent-health's
 * `test_case` eval span (single trace tree).
 *
 * Strategies (see AGENTS.md → "Trace correlation conventions"):
 *   A. propagateEnv     — inject W3C TRACEPARENT env var into subprocess
 *   A. propagateHeader  — inject W3C `traceparent` HTTP header into request
 *   C. serviceName      — OpenSearch `service.name` to look for as a
 *                          time-window fallback when A/B don't apply
 *                          (opt-in via UI toggle on the run report).
 */
export interface TraceContextStrategy {
  /** Inject W3C TRACEPARENT env var into the subprocess (Strategy A). */
  propagateEnv?: boolean;
  /** Inject W3C `traceparent` HTTP header (Strategy A). */
  propagateHeader?: boolean;
  /** Service name this connector's agent emits under in OpenSearch (Strategy C). */
  serviceName?: string;
}

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

  /**
   * Optional trace-context propagation strategy. Defaults provided by each
   * connector class; users may override per-agent via `connectorConfig.traceContext`.
   */
  traceContext?: TraceContextStrategy;
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

  /** Lifecycle hooks for custom setup/transform logic */
  hooks?: AgentHooks;
}

// ============ Registry Types ============

/** A zero-argument constructor used by the built-in name registry. */
export type ConnectorFactory = () => AgentConnector;

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
