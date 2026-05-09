/* Copyright OpenSearch Contributors
   SPDX-License-Identifier: Apache-2.0 */

/**
 * LiteLLM Judge Service — delegates to the OpenAI-compatible judge service
 * since LiteLLM exposes an OpenAI-compatible API.
 */
export { evaluateWithOpenAICompatible as evaluateWithLiteLLM, parseOpenAICompatibleError as parseLiteLLMError } from './judgeService';
