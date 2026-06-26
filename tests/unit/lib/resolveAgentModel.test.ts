// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { resolveAgentModel } from '@/lib/resolveAgentModel';
import type { AgentConfig } from '@/types';

const agent = (connectorConfig: any): Pick<AgentConfig, 'connectorConfig'> => ({ connectorConfig });

describe('resolveAgentModel — agent owns its model (no user-facing agent-model)', () => {
  it('reads connectorConfig.model (pi / streaming / openai-compatible)', () => {
    expect(resolveAgentModel(agent({ model: 'amazon-bedrock/us.anthropic.claude-opus-4-8' })))
      .toBe('amazon-bedrock/us.anthropic.claude-opus-4-8');
  });

  it('reads connectorConfig.env.ANTHROPIC_MODEL (claude-code)', () => {
    expect(resolveAgentModel(agent({ env: { ANTHROPIC_MODEL: 'us.anthropic.claude-opus-4-8-v1' } })))
      .toBe('us.anthropic.claude-opus-4-8-v1');
  });

  it('reads a --model flag from connectorConfig.args', () => {
    expect(resolveAgentModel(agent({ args: ['--foo', '--model', 'sonnet-4-5', '--bar'] })))
      .toBe('sonnet-4-5');
  });

  it('prefers connectorConfig.model over env over args', () => {
    expect(resolveAgentModel(agent({ model: 'm1', env: { ANTHROPIC_MODEL: 'm2' }, args: ['--model', 'm3'] })))
      .toBe('m1');
    expect(resolveAgentModel(agent({ env: { ANTHROPIC_MODEL: 'm2' }, args: ['--model', 'm3'] })))
      .toBe('m2');
  });

  it('falls back to the legacy run.modelId only when the agent configures no model', () => {
    expect(resolveAgentModel(agent({}), 'legacy-run-model')).toBe('legacy-run-model');
    expect(resolveAgentModel(undefined, 'legacy-run-model')).toBe('legacy-run-model');
    // A configured agent model wins over any legacy fallback.
    expect(resolveAgentModel(agent({ model: 'configured' }), 'legacy-run-model')).toBe('configured');
  });

  it('returns empty string when there is neither a configured model nor a fallback', () => {
    expect(resolveAgentModel(agent({}))).toBe('');
    expect(resolveAgentModel(undefined)).toBe('');
    expect(resolveAgentModel(agent({ args: ['--no-model-here'] }))).toBe('');
  });
});
