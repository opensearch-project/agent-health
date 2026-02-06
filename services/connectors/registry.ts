/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentConnector,
  ConnectorProtocol,
  ConnectorRegistry,
  AgentConfigWithConnector,
} from '@/services/connectors/types';

/**
 * Default connector protocol for agents without explicit connector type
 */
const DEFAULT_CONNECTOR_TYPE: ConnectorProtocol = 'agui-streaming';

/**
 * Implementation of ConnectorRegistry
 * Manages registration and lookup of connector implementations
 */
class ConnectorRegistryImpl implements ConnectorRegistry {
  private connectors: Map<ConnectorProtocol, AgentConnector> = new Map();

  /**
   * Register a connector implementation
   * @throws Error if connector with same type is already registered
   */
  register(connector: AgentConnector): void {
    if (this.connectors.has(connector.type)) {
      console.warn(
        `[ConnectorRegistry] Overwriting existing connector for type: ${connector.type}`
      );
    }
    this.connectors.set(connector.type, connector);
  }

  /**
   * Get a connector by protocol type
   */
  get(type: ConnectorProtocol): AgentConnector | undefined {
    return this.connectors.get(type);
  }

  /**
   * Get all registered connectors
   */
  getAll(): AgentConnector[] {
    return Array.from(this.connectors.values());
  }

  /**
   * Check if a connector is registered
   */
  has(type: ConnectorProtocol): boolean {
    return this.connectors.has(type);
  }

  /**
   * Get connector for an agent config
   * Handles backwards compatibility with legacy configs
   *
   * Resolution order:
   * 1. If endpoint starts with 'mock://', use mock connector
   * 2. If connectorType is specified, use that
   * 3. Default to 'agui-streaming'
   */
  getForAgent(agent: AgentConfigWithConnector): AgentConnector {
    // Handle mock:// endpoint prefix (legacy pattern)
    if (agent.endpoint.startsWith('mock://')) {
      const mockConnector = this.get('mock');
      if (mockConnector) {
        return mockConnector;
      }
      console.warn('[ConnectorRegistry] Mock connector not registered, falling back to default');
    }

    // Use explicit connector type if specified
    const connectorType = agent.connectorType ?? DEFAULT_CONNECTOR_TYPE;
    const connector = this.get(connectorType);

    if (!connector) {
      console.error(
        `[ConnectorRegistry] Connector not found for type: ${connectorType}, ` +
        `falling back to ${DEFAULT_CONNECTOR_TYPE}`
      );
      const defaultConnector = this.get(DEFAULT_CONNECTOR_TYPE);
      if (!defaultConnector) {
        throw new Error(
          `No connector registered for type '${connectorType}' and no default connector available`
        );
      }
      return defaultConnector;
    }

    return connector;
  }

  /**
   * Clear all registered connectors (useful for testing)
   */
  clear(): void {
    this.connectors.clear();
  }

  /**
   * Get list of registered connector types
   */
  getRegisteredTypes(): ConnectorProtocol[] {
    return Array.from(this.connectors.keys());
  }
}

/**
 * Singleton instance of the connector registry
 */
export const connectorRegistry = new ConnectorRegistryImpl();

/**
 * Helper function to get connector for an agent
 */
export function getConnectorForAgent(agent: AgentConfigWithConnector): AgentConnector {
  return connectorRegistry.getForAgent(agent);
}

/**
 * Helper function to register a connector
 */
export function registerConnector(connector: AgentConnector): void {
  connectorRegistry.register(connector);
}
