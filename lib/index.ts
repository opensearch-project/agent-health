/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public API for @opensearch-project/agent-health
 *
 * Users can import from this module in their agent-health.config.ts files:
 *
 * @example
 * ```typescript
 * import { defineConfig, RESTConnector } from '@opensearch-project/agent-health';
 *
 * export default defineConfig({
 *   agents: [
 *     {
 *       key: 'my-agent',
 *       name: 'My Agent',
 *       endpoint: 'https://api.example.com/chat',
 *       connectorType: 'rest',
 *       models: ['claude-sonnet-4'],
 *     },
 *   ],
 * });
 * ```
 */

// Config helpers
export { defineConfig } from './config/defineConfig.js';

// Config types
export type {
  UserConfig,
  UserAgentConfig,
  UserModelConfig,
  ResolvedConfig,
  ReporterConfig,
  JudgeConfig,
} from './config/types.js';

// Hook types (for writing typed hooks in agent-health.config.ts)
export type {
  BeforeRequestContext,
  AgentHooks,
} from '../types/index.js';

// Connector types (for custom connector implementations)
export type {
  AgentConnector,
  ConnectorProtocol,
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
} from '../services/connectors/types.js';

// Base connector class (for extending)
export { BaseConnector } from '../services/connectors/base/BaseConnector.js';

// Built-in connectors
export { AGUIStreamingConnector } from '../services/connectors/agui/AGUIStreamingConnector.js';
export { RESTConnector } from '../services/connectors/rest/RESTConnector.js';
export { SubprocessConnector } from '../services/connectors/subprocess/SubprocessConnector.js';
export { ClaudeCodeConnector } from '../services/connectors/claude-code/ClaudeCodeConnector.js';
export { MockConnector } from '../services/connectors/mock/MockConnector.js';

// Connector registry (for programmatic registration)
export { connectorRegistry, registerConnector } from '../services/connectors/registry.js';

// ConnectorRegistry type for custom implementations
export type { ConnectorRegistry } from '../services/connectors/types.js';
