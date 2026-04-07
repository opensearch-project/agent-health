/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentConfig, ConnectorProtocol } from '@/types';

/**
 * Browser-safe connector types that work via HTTP/fetch APIs.
 * These connectors can run evaluations directly from the UI.
 */
const BROWSER_SAFE_CONNECTORS: ConnectorProtocol[] = ['agui-streaming', 'rest', 'mock'];

/**
 * Determines if an agent can be run from the browser UI.
 *
 * Some agents (like Claude Code) require CLI execution because they:
 * - Spawn local processes via child_process.spawn() (Node.js only)
 * - Access local filesystem or environment variables
 * - Cannot operate within browser sandbox security constraints
 *
 * @param agent - The agent configuration to check
 * @returns true if the agent can be run from the browser, false if CLI-only
 */
export function isBrowserCompatible(agent: AgentConfig): boolean {
  const connectorType = agent.connectorType || 'agui-streaming';
  return BROWSER_SAFE_CONNECTORS.includes(connectorType);
}

/**
 * Gets a user-friendly explanation for why an agent cannot run from the UI.
 *
 * @param agent - The agent configuration to check
 * @returns Error message if agent requires CLI, null if browser-compatible
 */
export function getAgentUnavailableReason(agent: AgentConfig): string | null {
  if (isBrowserCompatible(agent)) {
    return null;
  }

  return `This agent requires the CLI. Run with: npx @opensearch-project/agent-health run -t <test-case> -a ${agent.key}`;
}

/**
 * Gets the first browser-compatible agent from a list.
 * Useful for setting default selection in UI components.
 *
 * @param agents - List of agent configurations
 * @returns The first browser-compatible agent, or undefined if none found
 */
export function getFirstBrowserCompatibleAgent(agents: AgentConfig[]): AgentConfig | undefined {
  return agents.find(agent => isBrowserCompatible(agent));
}
