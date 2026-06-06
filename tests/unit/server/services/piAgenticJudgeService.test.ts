/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the agent trace judge's pure helpers. The full
 * `evaluateWithPiAgenticTrace` path drives the in-process pi SDK
 * (`createAgentSession`) + a live model, so it's covered by e2e validation;
 * here we test the deterministic helpers and the tool wiring (see
 * traceJudgeTools.test.ts) that don't need a model.
 */

import { pickJudgeModel, extractFinalAssistantText, findRequestedModel } from '@/server/services/piAgenticJudgeService';

describe('pickJudgeModel', () => {
  const m = (provider: string, id: string) => ({ provider, id });

  it('returns undefined for an empty model list', () => {
    expect(pickJudgeModel([])).toBeUndefined();
  });

  it('prefers sonnet > opus > claude > anything', () => {
    const models = [m('x', 'gpt-4o'), m('a', 'claude-haiku'), m('b', 'claude-opus-4'), m('c', 'claude-sonnet-4-5')];
    expect(pickJudgeModel(models)?.id).toBe('claude-sonnet-4-5');
    expect(pickJudgeModel([m('x', 'gpt-4o'), m('b', 'claude-opus-4'), m('a', 'claude-haiku')])?.id).toBe('claude-opus-4');
    expect(pickJudgeModel([m('x', 'gpt-4o'), m('a', 'claude-haiku')])?.id).toBe('claude-haiku');
  });

  it('falls back to the first model when none are claude', () => {
    expect(pickJudgeModel([m('x', 'gpt-4o'), m('y', 'gemini-2')])?.id).toBe('gpt-4o');
  });
});

describe('findRequestedModel (Bedrock inference profiles)', () => {
  const m = (id: string) => ({ provider: 'amazon-bedrock', id });
  const OLD = process.env.AWS_REGION;
  afterEach(() => { process.env.AWS_REGION = OLD; });

  it('returns undefined when no model id is requested', () => {
    expect(findRequestedModel([m('anthropic.claude-sonnet-4-5')], undefined)).toBeUndefined();
  });

  it('matches the requested model ignoring the region prefix', () => {
    const models = [m('anthropic.claude-3-5-sonnet'), m('global.anthropic.claude-sonnet-4-5')];
    // requested with a us. prefix; only a global. profile exists -> pick it (not the bare/old one)
    const found = findRequestedModel(models, 'us.anthropic.claude-sonnet-4-5');
    expect(found?.id).toBe('global.anthropic.claude-sonnet-4-5');
  });

  it('prefers the region-appropriate inference profile over global/bare', () => {
    process.env.AWS_REGION = 'us-east-1';
    const models = [
      m('anthropic.claude-sonnet-4-5'), // bare (fails on-demand)
      m('global.anthropic.claude-sonnet-4-5'),
      m('us.anthropic.claude-sonnet-4-5'),
    ];
    expect(findRequestedModel(models, 'us.anthropic.claude-sonnet-4-5')?.id).toBe('us.anthropic.claude-sonnet-4-5');
  });

  it('prefers an inference-profile variant over the bare id', () => {
    const models = [m('anthropic.claude-sonnet-4-5'), m('global.anthropic.claude-sonnet-4-5')];
    expect(findRequestedModel(models, 'anthropic.claude-sonnet-4-5')?.id).toBe('global.anthropic.claude-sonnet-4-5');
  });

  it('returns undefined when no model shares the requested base id', () => {
    expect(findRequestedModel([m('amazon.nova-pro')], 'us.anthropic.claude-opus-4')).toBeUndefined();
  });
});

describe('extractFinalAssistantText', () => {
  it('returns the last assistant text content', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'query_spans' }] }, // no text
      { role: 'assistant', content: [{ type: 'text', text: 'Verified.\n{"pass_fail_status":"passed"}' }] },
    ];
    expect(extractFinalAssistantText(messages)).toBe('Verified.\n{"pass_fail_status":"passed"}');
  });

  it('ignores non-assistant roles and concatenates multi-part text', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'ignore me' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ];
    expect(extractFinalAssistantText(messages)).toBe('ab');
  });

  it('returns empty string when there is no assistant text', () => {
    expect(extractFinalAssistantText([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])).toBe('');
    expect(extractFinalAssistantText([])).toBe('');
    expect(extractFinalAssistantText(undefined as any)).toBe('');
  });
});
