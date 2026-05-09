/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { evaluateWithLiteLLM, parseLiteLLMError } from '@/server/services/litellmJudgeService';
import { evaluateWithOpenAICompatible, parseOpenAICompatibleError } from '@/server/services/judgeService';

// The litellmJudgeService re-exports from judgeService
describe('litellmJudgeService', () => {
  it('should re-export evaluateWithOpenAICompatible as evaluateWithLiteLLM', () => {
    expect(evaluateWithLiteLLM).toBe(evaluateWithOpenAICompatible);
  });

  it('should re-export parseOpenAICompatibleError as parseLiteLLMError', () => {
    expect(parseLiteLLMError).toBe(parseOpenAICompatibleError);
  });
});
