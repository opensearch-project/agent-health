/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for server/services/runModelResolution.ts — the per-agent
 * resolution of the model a `POST /api/evaluate` run records and forwards.
 *
 * Resolution table:
 *   agent declares a model            → 'agent'  (caller's modelId ignored)
 *   connector owns the model          → 'agent'  (no id; caller's modelId ignored)
 *   catalog agent + catalog modelId   → 'request'
 *   catalog agent + unknown modelId   → MODEL_NOT_FOUND
 *   catalog agent + no modelId        → 'default' (catalog default)
 *   catalog agent + empty catalog     → MODEL_REQUIRED
 */

import type { AgentConfig, ModelConfig } from '@/types';
import { resolveRunModel, getAgentModelOwnership, pickDefaultAgentModelKey } from '@/server/services/runModelResolution';
import { DEFAULT_AGENT_MODEL_ID } from '@/lib/agentModelCatalog';

const CATALOG: Record<string, ModelConfig> = {
  'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo Model', provider: 'demo', context_window: 1, max_output_tokens: 1 },
  'claude-sonnet-4.5': { model_id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', display_name: 'Claude Sonnet 4.5', provider: 'bedrock', context_window: 1, max_output_tokens: 1 },
  'gpt-4o': { model_id: 'gpt-4o', display_name: 'GPT-4o', provider: 'openai-compatible', context_window: 1, max_output_tokens: 1 },
  'agentic-custom': { model_id: 'agentic-custom', display_name: 'Custom Agentic Judge', provider: 'agentic' as any, context_window: 1, max_output_tokens: 1 },
};

function agent(overrides: Partial<AgentConfig>): AgentConfig {
  return { key: 'a', name: 'A', endpoint: 'http://localhost:9000/run', ...overrides } as AgentConfig;
}

describe('getAgentModelOwnership', () => {
  it('declared connectorConfig.model → owns, with the declared id (any string, not a catalog key)', () => {
    expect(getAgentModelOwnership(agent({ connectorType: 'rest', connectorConfig: { model: 'provider.deployment-x' } })))
      .toEqual({ ownsModel: true, declaredModelId: 'provider.deployment-x' });
  });

  it('declared via env.ANTHROPIC_MODEL or a --model arg → owns', () => {
    expect(getAgentModelOwnership(agent({ connectorType: 'claude-code', connectorConfig: { env: { ANTHROPIC_MODEL: 'm-env' } } })))
      .toEqual({ ownsModel: true, declaredModelId: 'm-env' });
    expect(getAgentModelOwnership(agent({ connectorType: 'pi', connectorConfig: { args: ['--model', 'm-arg'] } })))
      .toEqual({ ownsModel: true, declaredModelId: 'm-arg' });
  });

  it('model-owning connectors (subprocess CLIs, strands) own even without a declared model', () => {
    for (const connectorType of ['subprocess', 'claude-code', 'kiro', 'strands'] as const) {
      expect(getAgentModelOwnership(agent({ connectorType }))).toEqual({ ownsModel: true });
    }
  });

  it('connectors that put the requested model on the wire do not own it', () => {
    for (const connectorType of ['agui-streaming', 'rest', 'openai-compatible', 'langgraph', 'pi', 'mock'] as const) {
      expect(getAgentModelOwnership(agent({ connectorType }))).toEqual({ ownsModel: false });
    }
    // default connector type (undefined → agui-streaming)
    expect(getAgentModelOwnership(agent({}))).toEqual({ ownsModel: false });
  });

  it('mock:// endpoints resolve to the mock connector (catalog model), regardless of connectorType', () => {
    expect(getAgentModelOwnership(agent({ endpoint: 'mock://demo', connectorType: 'claude-code' }))).toEqual({ ownsModel: false });
  });
});

describe('resolveRunModel', () => {
  describe('agent-owned model', () => {
    it('records the declared model as informational and ignores the caller modelId', () => {
      const res = resolveRunModel(
        agent({ key: 'retrieval-agent', connectorType: 'rest', connectorConfig: { model: 'provider.deployment-x' } }),
        'claude-sonnet-4.5',
        CATALOG,
      );
      expect(res).toEqual({
        ok: true,
        model: { modelId: 'provider.deployment-x', modelName: 'provider.deployment-x', modelSource: 'agent', catalogEntry: undefined },
        ignoredRequestedModelId: 'claude-sonnet-4.5',
      });
    });

    it('does not report an ignored id when the caller sent the declared model or nothing', () => {
      const a = agent({ connectorType: 'rest', connectorConfig: { model: 'provider.deployment-x' } });
      expect((resolveRunModel(a, 'provider.deployment-x', CATALOG) as any).ignoredRequestedModelId).toBeUndefined();
      expect((resolveRunModel(a, undefined, CATALOG) as any).ignoredRequestedModelId).toBeUndefined();
      expect((resolveRunModel(a, '   ', CATALOG) as any).ignoredRequestedModelId).toBeUndefined();
    });

    it('uses the catalog display name when the declared model happens to be a catalog key', () => {
      const res = resolveRunModel(agent({ connectorType: 'openai-compatible', connectorConfig: { model: 'gpt-4o' } }), undefined, CATALOG);
      expect(res.ok && res.model).toMatchObject({ modelId: 'gpt-4o', modelName: 'GPT-4o', modelSource: 'agent', catalogEntry: CATALOG['gpt-4o'] });
    });

    it('connector-owned with nothing declared → empty id, source agent, caller modelId ignored', () => {
      const res = resolveRunModel(agent({ connectorType: 'claude-code' }), 'claude-sonnet-4.5', CATALOG);
      expect(res).toEqual({
        ok: true,
        model: { modelId: '', modelName: '', modelSource: 'agent', catalogEntry: undefined },
        ignoredRequestedModelId: 'claude-sonnet-4.5',
      });
    });
  });

  describe('catalog-model agent', () => {
    const catalogAgent = agent({ key: 'streaming', connectorType: 'agui-streaming' });

    it('honours a catalog modelId (existing behaviour)', () => {
      expect(resolveRunModel(catalogAgent, 'gpt-4o', CATALOG)).toEqual({
        ok: true,
        model: { modelId: 'gpt-4o', modelName: 'GPT-4o', modelSource: 'request', catalogEntry: CATALOG['gpt-4o'] },
      });
    });

    it('rejects a non-catalog modelId with MODEL_NOT_FOUND naming the agent and the catalog', () => {
      const res = resolveRunModel(catalogAgent, 'provider.deployment-x', CATALOG);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.error.code).toBe('MODEL_NOT_FOUND');
      expect(res.error.message).toContain('Model not found: provider.deployment-x');
      expect(res.error.message).toContain("'streaming'");
      expect(res.error.message).toContain('claude-sonnet-4.5');
    });

    it('falls back to the catalog default when no modelId is sent', () => {
      expect(resolveRunModel(catalogAgent, undefined, CATALOG)).toEqual({
        ok: true,
        model: {
          modelId: DEFAULT_AGENT_MODEL_ID,
          modelName: 'Claude Sonnet 4.5',
          modelSource: 'default',
          catalogEntry: CATALOG[DEFAULT_AGENT_MODEL_ID],
        },
      });
    });

    it('treats a non-string / blank modelId as absent', () => {
      expect((resolveRunModel(catalogAgent, 42, CATALOG) as any).model.modelSource).toBe('default');
      expect((resolveRunModel(catalogAgent, '  ', CATALOG) as any).model.modelSource).toBe('default');
    });

    it('returns MODEL_REQUIRED when nothing resolves (no modelId, no agent-capable catalog entry)', () => {
      const judgeOnly = { 'demo-model': CATALOG['demo-model'], 'agentic-custom': CATALOG['agentic-custom'] };
      const res = resolveRunModel(catalogAgent, undefined, judgeOnly);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.error.code).toBe('MODEL_REQUIRED');
      expect(res.error.message).toContain('streaming');
    });
  });
});

describe('pickDefaultAgentModelKey', () => {
  it('prefers the long-standing UI default when present', () => {
    expect(pickDefaultAgentModelKey(CATALOG)).toBe('claude-sonnet-4.5');
  });

  it('otherwise picks the first agent-capable provider entry, skipping judge-only / demo providers', () => {
    const { 'claude-sonnet-4.5': _omit, ...rest } = CATALOG;
    expect(pickDefaultAgentModelKey(rest)).toBe('gpt-4o');
  });

  it('returns undefined when no entry can serve as an agent model', () => {
    expect(pickDefaultAgentModelKey({ 'demo-model': CATALOG['demo-model'] })).toBeUndefined();
    expect(pickDefaultAgentModelKey({})).toBeUndefined();
  });
});
