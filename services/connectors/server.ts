/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-only Connector Exports
 * These connectors require Node.js and cannot run in the browser
 *
 * Import this file in CLI/server code to get access to subprocess-based connectors
 */

// Re-export everything from the main index (browser-safe connectors)
export * from './index';

// Export server-only connectors
export { SubprocessConnector, subprocessConnector } from './subprocess/SubprocessConnector';
export {
  ClaudeCodeConnector,
  claudeCodeConnector,
  createBedrockClaudeCodeConnector,
} from './claude-code/ClaudeCodeConnector';
export { KiroConnector, kiroConnector } from './kiro/KiroConnector';
export { PiConnector, piConnector, createAgentHealthPiConnector } from './pi/PiConnector';
export { StrandsConnector, strandsConnector } from './strands/StrandsConnector';

// Register server-only connectors
import { connectorRegistry } from './registry';
import { subprocessConnector } from './subprocess/SubprocessConnector';
import { claudeCodeConnector } from './claude-code/ClaudeCodeConnector';
import { kiroConnector } from './kiro/KiroConnector';
import { piConnector } from './pi/PiConnector';
import { strandsConnector } from './strands/StrandsConnector';

// Register server-only connectors on module load
connectorRegistry.register(subprocessConnector);
connectorRegistry.register(claudeCodeConnector);
connectorRegistry.register(kiroConnector);
connectorRegistry.register(piConnector);
connectorRegistry.register(strandsConnector);

console.log('[Connectors] Server connectors registered:', connectorRegistry.getRegisteredTypes().join(', '));
