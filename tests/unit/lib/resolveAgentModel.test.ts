// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { resolveAgentModel } from '@/lib/resolveAgentModel';
import type { AgentConfig } from '@/types';

const agent = (connectorConfig: any): AgentConfig => ({ connectorConfig } as AgentConfig);

describe('resolveAgentModel — agent owns its model (no user-facing agent-model)', () => {
  it('resolves model from connectorConfig in priority order: model > env.ANTHROPIC_MODEL > args[--model]', () => {
    // Each source individually + priority when more than one is present.
    expect(resolveAgentModel(agent({ model: 'm1' }))).toBe('m1');
    expect(resolveAgentModel(agent({ env: { ANTHROPIC_MODEL: 'm2' } }))).toBe('m2');
    expect(resolveAgentModel(agent({ args: ['--foo', '--model', 'm3', '--bar'] }))).toBe('m3');
    expect(resolveAgentModel(agent({ model: 'm1', env: { ANTHROPIC_MODEL: 'm2' }, args: ['--model', 'm3'] }))).toBe('m1');
    expect(resolveAgentModel(agent({ env: { ANTHROPIC_MODEL: 'm2' }, args: ['--model', 'm3'] }))).toBe('m2');
  });

  it('uses the legacy fallback only when no source on the agent provides a model', () => {
    expect(resolveAgentModel(agent({}), 'legacy')).toBe('legacy');
    expect(resolveAgentModel(undefined, 'legacy')).toBe('legacy');
    expect(resolveAgentModel(agent({ model: 'configured' }), 'legacy')).toBe('configured');
  });

  it('returns empty string when neither a configured model nor a fallback is present', () => {
    expect(resolveAgentModel(agent({}))).toBe('');
    expect(resolveAgentModel(undefined)).toBe('');
    expect(resolveAgentModel(agent({ args: ['--no-model-here'] }))).toBe('');
  });
});
