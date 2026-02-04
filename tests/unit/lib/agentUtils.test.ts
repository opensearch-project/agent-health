/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBrowserCompatible, getAgentUnavailableReason, getFirstBrowserCompatibleAgent } from '@/lib/agentUtils';
import { AgentConfig } from '@/types';

describe('agentUtils', () => {
  // Mock agent configurations for testing
  const mockAgents: AgentConfig[] = [
    {
      key: 'agui-agent',
      name: 'AG-UI Agent',
      endpoint: 'http://localhost:3000',
      connectorType: 'agui-streaming',
      models: ['claude-sonnet-4'],
    },
    {
      key: 'rest-agent',
      name: 'REST Agent',
      endpoint: 'http://localhost:4000',
      connectorType: 'rest',
      models: ['claude-sonnet-4'],
    },
    {
      key: 'mock-agent',
      name: 'Mock Agent',
      endpoint: 'mock://demo',
      connectorType: 'mock',
      models: ['demo-model'],
    },
    {
      key: 'subprocess-agent',
      name: 'Subprocess Agent',
      endpoint: '/usr/local/bin/agent',
      connectorType: 'subprocess',
      models: ['claude-sonnet-4'],
    },
    {
      key: 'claude-code',
      name: 'Claude Code',
      endpoint: 'claude',
      connectorType: 'claude-code',
      models: ['claude-sonnet-4'],
    },
    {
      key: 'default-agent',
      name: 'Default Agent (no connector type)',
      endpoint: 'http://localhost:5000',
      // No connectorType specified - should default to agui-streaming
      models: ['claude-sonnet-4'],
    },
  ];

  describe('isBrowserCompatible', () => {
    it('should return true for agui-streaming connector', () => {
      const agent = mockAgents.find(a => a.key === 'agui-agent')!;
      expect(isBrowserCompatible(agent)).toBe(true);
    });

    it('should return true for rest connector', () => {
      const agent = mockAgents.find(a => a.key === 'rest-agent')!;
      expect(isBrowserCompatible(agent)).toBe(true);
    });

    it('should return true for mock connector', () => {
      const agent = mockAgents.find(a => a.key === 'mock-agent')!;
      expect(isBrowserCompatible(agent)).toBe(true);
    });

    it('should return false for subprocess connector', () => {
      const agent = mockAgents.find(a => a.key === 'subprocess-agent')!;
      expect(isBrowserCompatible(agent)).toBe(false);
    });

    it('should return false for claude-code connector', () => {
      const agent = mockAgents.find(a => a.key === 'claude-code')!;
      expect(isBrowserCompatible(agent)).toBe(false);
    });

    it('should return true for agents without connectorType (defaults to agui-streaming)', () => {
      const agent = mockAgents.find(a => a.key === 'default-agent')!;
      expect(isBrowserCompatible(agent)).toBe(true);
    });
  });

  describe('getAgentUnavailableReason', () => {
    it('should return null for browser-compatible agents', () => {
      const agent = mockAgents.find(a => a.key === 'agui-agent')!;
      expect(getAgentUnavailableReason(agent)).toBeNull();
    });

    it('should return CLI instruction for subprocess agents', () => {
      const agent = mockAgents.find(a => a.key === 'subprocess-agent')!;
      const reason = getAgentUnavailableReason(agent);
      expect(reason).toContain('CLI');
      expect(reason).toContain('npx @opensearch-project/agent-health run');
      expect(reason).toContain('-a subprocess-agent');
    });

    it('should return CLI instruction for claude-code agent', () => {
      const agent = mockAgents.find(a => a.key === 'claude-code')!;
      const reason = getAgentUnavailableReason(agent);
      expect(reason).toContain('CLI');
      expect(reason).toContain('npx @opensearch-project/agent-health run');
      expect(reason).toContain('-a claude-code');
    });
  });

  describe('getFirstBrowserCompatibleAgent', () => {
    it('should return first browser-compatible agent', () => {
      const result = getFirstBrowserCompatibleAgent(mockAgents);
      expect(result).toBeDefined();
      expect(result!.key).toBe('agui-agent');
    });

    it('should skip CLI-only agents', () => {
      // Put CLI-only agents first
      const agents = [
        mockAgents.find(a => a.key === 'claude-code')!,
        mockAgents.find(a => a.key === 'subprocess-agent')!,
        mockAgents.find(a => a.key === 'rest-agent')!,
      ];
      const result = getFirstBrowserCompatibleAgent(agents);
      expect(result).toBeDefined();
      expect(result!.key).toBe('rest-agent');
    });

    it('should return undefined if no browser-compatible agents exist', () => {
      const cliOnlyAgents = [
        mockAgents.find(a => a.key === 'claude-code')!,
        mockAgents.find(a => a.key === 'subprocess-agent')!,
      ];
      const result = getFirstBrowserCompatibleAgent(cliOnlyAgents);
      expect(result).toBeUndefined();
    });

    it('should return undefined for empty array', () => {
      const result = getFirstBrowserCompatibleAgent([]);
      expect(result).toBeUndefined();
    });
  });
});
