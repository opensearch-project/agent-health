/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Connector System
 * Provides a pluggable abstraction for different agent communication protocols
 */

// ============ Type Exports ============
export type {
  ConnectorProtocol,
  ConnectorAuthType,
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
  AgentConnector,
  SubprocessInputMode,
  SubprocessOutputParser,
  SubprocessConfig,
  AgentConfigWithConnector,
  ConnectorRegistry,
  ConnectorExecuteOptions,
} from './types';

// ============ Registry Exports ============
export {
  connectorRegistry,
  getConnectorForAgent,
  registerConnector,
} from './registry';

// ============ Base Class Export ============
export { BaseConnector } from './base/BaseConnector';

// ============ Browser-safe Connector Exports ============
// These connectors work in browser environments (no Node.js dependencies)
export { AGUIStreamingConnector, aguiStreamingConnector } from './agui/AGUIStreamingConnector';
export { MockConnector, mockConnector } from './mock/MockConnector';
export { RESTConnector, restConnector } from './rest/RESTConnector';

// ============ Auto-register Browser-safe Connectors ============
import { connectorRegistry } from './registry';
import { aguiStreamingConnector } from './agui/AGUIStreamingConnector';
import { mockConnector } from './mock/MockConnector';
import { restConnector } from './rest/RESTConnector';

// Register browser-compatible connectors on module load
// Server-only connectors (subprocess, claude-code) are registered via server.ts
connectorRegistry.register(aguiStreamingConnector);
connectorRegistry.register(mockConnector);
connectorRegistry.register(restConnector);

console.log('[Connectors] Browser-safe connectors registered:', connectorRegistry.getRegisteredTypes().join(', '));
