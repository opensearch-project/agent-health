/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * lib/judgeIdentity — "which judge KIND ran, and which LLM was behind it".
 *
 * Pins the contract every persistence path relies on:
 *   - a provider pseudo-id (`agent-trace-judge`) is never written as the
 *     underlying model;
 *   - a plain provider's configured id IS the model (trivial judgeModel);
 *   - the provider's resolved id always wins when present;
 *   - old reports (no judgeModel) are described as "model not recorded".
 */

import {
  isJudgeProviderPseudoModelId,
  resolveJudgeModelForReport,
  buildJudgeIdentityPatch,
  buildLlmJudgeResponseIdentity,
  describeJudgeModel,
  shortJudgeModelLabel,
} from '@/lib/judgeIdentity';

const SONNET_45 = 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

describe('isJudgeProviderPseudoModelId', () => {
  it('recognises the judge-kind ids that name a provider, not a model', () => {
    for (const id of ['agent-trace-judge', 'pi-judge', 'agentic-claude-code', 'agentic-custom', 'claude-code-judge']) {
      expect(isJudgeProviderPseudoModelId(id)).toBe(true);
    }
  });
  it('treats real model ids and empty values as non-pseudo', () => {
    expect(isJudgeProviderPseudoModelId('us.anthropic.claude-sonnet-4-6')).toBe(false);
    expect(isJudgeProviderPseudoModelId('claude-sonnet-4.6')).toBe(false);
    expect(isJudgeProviderPseudoModelId(undefined)).toBe(false);
    expect(isJudgeProviderPseudoModelId('')).toBe(false);
  });
});

describe('resolveJudgeModelForReport', () => {
  it('prefers the provider-resolved judgeModel (agent trace judge)', () => {
    expect(resolveJudgeModelForReport({ judgeModel: SONNET_45, judgeProvider: 'agent' }, 'agent-trace-judge')).toBe(SONNET_45);
  });
  it('falls back to the configured id for plain providers (bedrock: judgeModel == judgeModelId)', () => {
    expect(resolveJudgeModelForReport({}, 'us.anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6');
    expect(resolveJudgeModelForReport(undefined, 'us.anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6');
  });
  it('NEVER promotes a provider pseudo-id to judgeModel when nothing was resolved', () => {
    expect(resolveJudgeModelForReport({}, 'agent-trace-judge')).toBeUndefined();
    expect(resolveJudgeModelForReport(undefined, 'pi-judge')).toBeUndefined();
    expect(resolveJudgeModelForReport({ judgeModel: '   ' }, 'agent-trace-judge')).toBeUndefined();
  });
  it('returns undefined with no judge at all', () => {
    expect(resolveJudgeModelForReport(undefined, undefined)).toBeUndefined();
  });
});

describe('buildJudgeIdentityPatch', () => {
  it('emits { judgeModel } when known and an EMPTY object otherwise (no undefined key to clobber a merge)', () => {
    expect(buildJudgeIdentityPatch({ judgeModel: SONNET_45 }, 'agent-trace-judge')).toEqual({ judgeModel: SONNET_45 });
    expect(buildJudgeIdentityPatch({}, 'claude-sonnet-4.6')).toEqual({ judgeModel: 'claude-sonnet-4.6' });
    const patch = buildJudgeIdentityPatch({}, 'agent-trace-judge');
    expect(patch).toEqual({});
    expect('judgeModel' in patch).toBe(false);
  });
});

describe('buildLlmJudgeResponseIdentity', () => {
  it('puts the REAL model on modelId and keeps the provider kind (agent trace judge)', () => {
    expect(buildLlmJudgeResponseIdentity({ judgeModel: SONNET_45, judgeProvider: 'agent' }, 'agent-trace-judge'))
      .toEqual({ modelId: SONNET_45, judgeProvider: 'agent' });
  });
  it('infers the provider kind from a pseudo-id when the service did not say (older /api/judge)', () => {
    expect(buildLlmJudgeResponseIdentity({}, 'agent-trace-judge')).toEqual({ modelId: 'agent-trace-judge', judgeProvider: 'agent' });
    expect(buildLlmJudgeResponseIdentity({}, 'pi-judge')).toEqual({ modelId: 'pi-judge', judgeProvider: 'pi' });
    expect(buildLlmJudgeResponseIdentity({}, 'agentic-claude-code')).toEqual({ modelId: 'agentic-claude-code', judgeProvider: 'agentic' });
  });
  it('bedrock: modelId is the configured id, provider from the service', () => {
    expect(buildLlmJudgeResponseIdentity({ judgeModel: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock' }, 'us.anthropic.claude-sonnet-4-6'))
      .toEqual({ modelId: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock' });
    expect(buildLlmJudgeResponseIdentity(undefined, 'us.anthropic.claude-sonnet-4-6')).toEqual({ modelId: 'us.anthropic.claude-sonnet-4-6' });
  });
  it('never yields an empty-string modelId when a configured id exists; empty only when nothing is known', () => {
    expect(buildLlmJudgeResponseIdentity(undefined, undefined).modelId).toBe('');
  });
});

describe('describeJudgeModel', () => {
  it('flags an agentic judge with no recorded model as modelNotRecorded (old reports)', () => {
    expect(describeJudgeModel({ judgeModelId: 'agent-trace-judge' })).toEqual({
      judgeModelId: 'agent-trace-judge', judgeModel: undefined, modelNotRecorded: true,
    });
  });
  it('does not flag when the model IS recorded, or when the judge is a plain model id', () => {
    expect(describeJudgeModel({ judgeModelId: 'agent-trace-judge', judgeModel: SONNET_45 }).modelNotRecorded).toBe(false);
    expect(describeJudgeModel({ judgeModelId: 'us.anthropic.claude-sonnet-4-6' }).modelNotRecorded).toBe(false);
    expect(describeJudgeModel(undefined).modelNotRecorded).toBe(false);
  });
});

describe('shortJudgeModelLabel', () => {
  it('reduces a provider-qualified Bedrock profile id to the Claude family+version', () => {
    expect(shortJudgeModelLabel(SONNET_45)).toBe('claude-sonnet-4-5');
    expect(shortJudgeModelLabel('amazon-bedrock/us.anthropic.claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(shortJudgeModelLabel('anthropic/claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
  });
  it('strips only the provider prefix for non-Claude ids', () => {
    expect(shortJudgeModelLabel('openai/gpt-4o')).toBe('gpt-4o');
    expect(shortJudgeModelLabel('gpt-4o')).toBe('gpt-4o');
  });
});
