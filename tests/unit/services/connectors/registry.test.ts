/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { connectorRegistry, getConnectorForAgent, registerConnector } from '@/services/connectors/registry';
import type { AgentConnector, ConnectorProtocol, AgentConfigWithConnector } from '@/services/connectors/types';

describe('ConnectorRegistry', () => {
  // Create a mock connector for testing
  const createMockConnector = (type: ConnectorProtocol, name: string): AgentConnector => ({
    type,
    name,
    supportsStreaming: true,
    buildPayload: jest.fn(),
    execute: jest.fn(),
    parseResponse: jest.fn(),
  });

  beforeEach(() => {
    // Clear registry before each test
    connectorRegistry.clear();
  });

  describe('register', () => {
    it('should register a connector', () => {
      const connector = createMockConnector('mock', 'Test Mock');
      connectorRegistry.register(connector);

      expect(connectorRegistry.has('mock')).toBe(true);
      expect(connectorRegistry.get('mock')).toBe(connector);
    });

    it('should overwrite existing connector with warning', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const connector1 = createMockConnector('mock', 'Mock 1');
      const connector2 = createMockConnector('mock', 'Mock 2');

      connectorRegistry.register(connector1);
      connectorRegistry.register(connector2);

      expect(connectorRegistry.get('mock')).toBe(connector2);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Overwriting existing connector')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('get', () => {
    it('should return undefined for unregistered connector', () => {
      expect(connectorRegistry.get('mock')).toBeUndefined();
    });

    it('should return registered connector', () => {
      const connector = createMockConnector('rest', 'Test REST');
      connectorRegistry.register(connector);

      expect(connectorRegistry.get('rest')).toBe(connector);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no connectors registered', () => {
      expect(connectorRegistry.getAll()).toEqual([]);
    });

    it('should return all registered connectors', () => {
      const mock = createMockConnector('mock', 'Mock');
      const rest = createMockConnector('rest', 'REST');

      connectorRegistry.register(mock);
      connectorRegistry.register(rest);

      const all = connectorRegistry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(mock);
      expect(all).toContain(rest);
    });
  });

  describe('has', () => {
    it('should return false for unregistered connector', () => {
      expect(connectorRegistry.has('mock')).toBe(false);
    });

    it('should return true for registered connector', () => {
      connectorRegistry.register(createMockConnector('mock', 'Mock'));
      expect(connectorRegistry.has('mock')).toBe(true);
    });
  });

  describe('getForAgent', () => {
    beforeEach(() => {
      // Register default connectors for these tests
      connectorRegistry.register(createMockConnector('mock', 'Mock'));
      connectorRegistry.register(createMockConnector('agui-streaming', 'AG-UI'));
      connectorRegistry.register(createMockConnector('rest', 'REST'));
    });

    it('should return mock connector for mock:// endpoint', () => {
      const agent: AgentConfigWithConnector = {
        key: 'demo',
        name: 'Demo',
        endpoint: 'mock://demo',
        models: ['test-model'],
      };

      const connector = connectorRegistry.getForAgent(agent);
      expect(connector.type).toBe('mock');
    });

    it('should return specified connector type', () => {
      const agent: AgentConfigWithConnector = {
        key: 'test',
        name: 'Test',
        endpoint: 'http://localhost:8080',
        models: ['test-model'],
        connectorType: 'rest',
      };

      const connector = connectorRegistry.getForAgent(agent);
      expect(connector.type).toBe('rest');
    });

    it('should default to agui-streaming when no connector type specified', () => {
      const agent: AgentConfigWithConnector = {
        key: 'test',
        name: 'Test',
        endpoint: 'http://localhost:8080',
        models: ['test-model'],
      };

      const connector = connectorRegistry.getForAgent(agent);
      expect(connector.type).toBe('agui-streaming');
    });

    it('should fall back to default when specified connector not found', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const agent: AgentConfigWithConnector = {
        key: 'test',
        name: 'Test',
        endpoint: 'http://localhost:8080',
        models: ['test-model'],
        connectorType: 'subprocess',
      };

      const connector = connectorRegistry.getForAgent(agent);
      expect(connector.type).toBe('agui-streaming');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should throw when no connector available', () => {
      connectorRegistry.clear();
      const agent: AgentConfigWithConnector = {
        key: 'test',
        name: 'Test',
        endpoint: 'http://localhost:8080',
        models: ['test-model'],
      };

      expect(() => connectorRegistry.getForAgent(agent)).toThrow(
        'No connector registered'
      );
    });
  });

  describe('getRegisteredTypes', () => {
    it('should return empty array when no connectors registered', () => {
      expect(connectorRegistry.getRegisteredTypes()).toEqual([]);
    });

    it('should return all registered types', () => {
      connectorRegistry.register(createMockConnector('mock', 'Mock'));
      connectorRegistry.register(createMockConnector('rest', 'REST'));

      const types = connectorRegistry.getRegisteredTypes();
      expect(types).toContain('mock');
      expect(types).toContain('rest');
    });
  });

  describe('clear', () => {
    it('should remove all registered connectors', () => {
      connectorRegistry.register(createMockConnector('mock', 'Mock'));
      connectorRegistry.register(createMockConnector('rest', 'REST'));

      connectorRegistry.clear();

      expect(connectorRegistry.getAll()).toEqual([]);
      expect(connectorRegistry.has('mock')).toBe(false);
      expect(connectorRegistry.has('rest')).toBe(false);
    });
  });

  describe('helper functions', () => {
    it('getConnectorForAgent should delegate to registry', () => {
      connectorRegistry.register(createMockConnector('mock', 'Mock'));
      const agent: AgentConfigWithConnector = {
        key: 'demo',
        name: 'Demo',
        endpoint: 'mock://demo',
        models: ['test-model'],
      };

      const connector = getConnectorForAgent(agent);
      expect(connector.type).toBe('mock');
    });

    it('registerConnector should delegate to registry', () => {
      const connector = createMockConnector('mock', 'Mock');
      registerConnector(connector);

      expect(connectorRegistry.has('mock')).toBe(true);
    });
  });
});
