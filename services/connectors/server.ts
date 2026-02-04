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

// Register server-only connectors
import { connectorRegistry } from './registry';
import { subprocessConnector } from './subprocess/SubprocessConnector';
import { claudeCodeConnector } from './claude-code/ClaudeCodeConnector';

// Register server-only connectors on module load
connectorRegistry.register(subprocessConnector);
connectorRegistry.register(claudeCodeConnector);

console.log('[Connectors] Server connectors registered:', connectorRegistry.getRegisteredTypes().join(', '));
