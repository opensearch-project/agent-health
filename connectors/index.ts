/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-safe connector registry.
 *
 * Every built-in lives in its own directory and contributes one factory here.
 * Server-only factories are added by `./server` so browser bundles never pull
 * in Node.js modules.
 */

export type {
  ConnectorProtocol,
  ConnectorAuthType,
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
  AgentConnector,
  ConnectorFactory,
  SubprocessInputMode,
  SubprocessOutputParser,
  SubprocessConfig,
  AgentConfigWithConnector,
  ConnectorRegistry,
  ConnectorExecuteOptions,
} from './types';

export {
  connectorRegistry,
  getConnectorForAgent,
  registerConnector,
  registerConnectorFactories,
} from './registry';

export { BaseConnector } from './base';
export { AGUIStreamingConnector, aguiStreamingConnector } from './agui';
export { MockConnector, mockConnector } from './mock';
export { RESTConnector, restConnector } from './rest';
export { OpenAICompatibleConnector, openaiCompatibleConnector } from './openai-compatible';
export { LangGraphConnector, langgraphConnector } from './langgraph';

import type { ConnectorFactory } from './types';
import { connectorRegistry, registerConnectorFactories } from './registry';
import { logStartupDiagnostic } from '@/lib/diagnostics';
import { AGUIStreamingConnector } from './agui';
import { MockConnector } from './mock';
import { RESTConnector } from './rest';
import { OpenAICompatibleConnector } from './openai-compatible';
import { LangGraphConnector } from './langgraph';

/** Name → factory entries safe to load in browsers. */
export const connectorFactories = {
  'agui-streaming': () => new AGUIStreamingConnector(),
  mock: () => new MockConnector(),
  rest: () => new RESTConnector(),
  'openai-compatible': () => new OpenAICompatibleConnector(),
  langgraph: () => new LangGraphConnector(),
} satisfies Record<string, ConnectorFactory>;

registerConnectorFactories(connectorFactories);

logStartupDiagnostic(
  '[Connectors] Browser-safe connectors registered:',
  connectorRegistry.getRegisteredTypes().join(', '),
);
