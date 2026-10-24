/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { toJudgeModelKey } from '@/lib/judgeModelKey';

const models = {
  'demo-model': { model_id: 'mock://demo-model' },
  'claude-sonnet-4.5': { model_id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
};

describe('toJudgeModelKey', () => {
  it('keeps a known key as-is', () => {
    expect(toJudgeModelKey('claude-sonnet-4.5', models)).toBe('claude-sonnet-4.5');
  });
  it('maps a full provider model id (what classic/CLI runs store) back to its picker key', () => {
    expect(toJudgeModelKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0', models)).toBe('claude-sonnet-4.5');
  });
  it('returns an unknown id unchanged (the server still resolves it) and "" for none', () => {
    expect(toJudgeModelKey('arn:aws:bedrock:custom', models)).toBe('arn:aws:bedrock:custom');
    expect(toJudgeModelKey(null, models)).toBe('');
    expect(toJudgeModelKey(undefined, models)).toBe('');
    expect(toJudgeModelKey('', models)).toBe('');
  });
});
