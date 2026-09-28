/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildAgentConfigForRun,
  findConfiguredAgent,
  getBedrockModelId,
} from '@/services/evaluation/runAgentConfig';
import type { BenchmarkRun } from '@/types';

const mockGetCustomAgents = jest.fn().mockReturnValue([]);
jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: (...args: any[]) => mockGetCustomAgents(...args),
}));

const mockConfig = {
  agents: [
    { key: 'test-agent', name: 'Test Agent', endpoint: 'http://test-agent.example.com', headers: { 'X-Agent': 'test' } },
  ],
  models: {
    'claude-sonnet': { model_id: 'anthropic.claude-3-sonnet-20240229-v1:0', display_name: 'Claude Sonnet' },
  },
};

const mockLoadConfigSync = jest.fn(() => mockConfig);
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => mockLoadConfigSync(),
}));
jest.mock('@/lib/constants', () => ({
  get DEFAULT_CONFIG() {
    return { agents: [{ key: 'fallback-agent', name: 'Fallback', endpoint: 'http://fallback', headers: {} }], models: {} };
  },
}));

const run = (overrides: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
  id: 'run-1',
  name: 'Run',
  agentKey: 'test-agent',
  modelId: 'claude-sonnet',
  createdAt: '2024-01-01T00:00:00.000Z',
  results: {},
  ...overrides,
});

describe('runAgentConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCustomAgents.mockReturnValue([]);
    mockLoadConfigSync.mockReturnValue(mockConfig);
  });

  describe('buildAgentConfigForRun', () => {
    it('resolves a configured agent and applies endpoint + header overrides from the run', () => {
      const cfg = buildAgentConfigForRun(run({ agentEndpoint: 'http://override', headers: { 'X-Run': '1' } }));
      expect(cfg.key).toBe('test-agent');
      expect(cfg.endpoint).toBe('http://override');
      expect(cfg.headers).toEqual({ 'X-Agent': 'test', 'X-Run': '1' });
    });

    it('keeps the agent endpoint when the run has no override', () => {
      expect(buildAgentConfigForRun(run()).endpoint).toBe('http://test-agent.example.com');
    });

    it('resolves custom agents from the customAgentStore', () => {
      mockGetCustomAgents.mockReturnValue([{ key: 'custom', name: 'Custom', endpoint: 'http://custom', headers: { A: 'b' } }]);
      const cfg = buildAgentConfigForRun(run({ agentKey: 'custom' }));
      expect(cfg.endpoint).toBe('http://custom');
      expect(cfg.headers).toEqual({ A: 'b' });
    });

    it('throws for an unknown agent', () => {
      expect(() => buildAgentConfigForRun(run({ agentKey: 'nope' }))).toThrow('Agent not found: nope');
    });

    it('falls back to DEFAULT_CONFIG when loadConfigSync throws', () => {
      mockLoadConfigSync.mockImplementation(() => { throw new Error('no config'); });
      expect(buildAgentConfigForRun(run({ agentKey: 'fallback-agent' })).endpoint).toBe('http://fallback');
    });
  });

  describe('findConfiguredAgent', () => {
    it('returns undefined for an unknown key without throwing', () => {
      expect(findConfiguredAgent('missing')).toBeUndefined();
      expect(findConfiguredAgent(undefined)).toBeUndefined();
    });
  });

  describe('getBedrockModelId', () => {
    it('maps a configured model key to its model_id', () => {
      expect(getBedrockModelId('claude-sonnet')).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    });

    it('returns the raw key when it is not in the config', () => {
      expect(getBedrockModelId('unknown-model')).toBe('unknown-model');
    });
  });
});
