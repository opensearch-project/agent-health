/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** Server registry: browser-safe entries plus connectors requiring Node.js. */
export * from './index';

export { SubprocessConnector, subprocessConnector } from './subprocess';
export {
  ClaudeCodeConnector,
  claudeCodeConnector,
  createBedrockClaudeCodeConnector,
} from './claude-code';
export { KiroConnector, kiroConnector } from './kiro';
export { PiConnector, piConnector, createAgentHealthPiConnector } from './pi';
export { StrandsConnector, strandsConnector } from './strands';
export { PiWebConnector, piWebConnector } from './pi-web';
export type { PiWebConnectorConfig } from './pi-web';

import type { ConnectorFactory } from './types';
import { connectorRegistry, registerConnectorFactories } from './registry';
import { connectorFactories } from './index';
import { logStartupDiagnostic } from '@/lib/diagnostics';
import { SubprocessConnector } from './subprocess';
import { ClaudeCodeConnector } from './claude-code';
import { KiroConnector } from './kiro';
import { PiConnector } from './pi';
import { StrandsConnector } from './strands';
import { PiWebConnector } from './pi-web';

const serverOnlyConnectorFactories = {
  subprocess: () => new SubprocessConnector(),
  'claude-code': () => new ClaudeCodeConnector(),
  kiro: () => new KiroConnector(),
  pi: () => new PiConnector(),
  strands: () => new StrandsConnector(),
  'pi-web': () => new PiWebConnector(),
} satisfies Record<string, ConnectorFactory>;

/** Complete name → factory registry for server/CLI execution. */
export const serverConnectorFactories = {
  ...connectorFactories,
  ...serverOnlyConnectorFactories,
} satisfies Record<string, ConnectorFactory>;

registerConnectorFactories(serverOnlyConnectorFactories);

logStartupDiagnostic(
  '[Connectors] Server connectors registered:',
  connectorRegistry.getRegisteredTypes().join(', '),
);
