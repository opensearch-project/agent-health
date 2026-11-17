/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { observeModelFromSpans } from '@/lib/observedModel';
import type { Span } from '@/types';

const at = (offsetMs: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetMs).toISOString();
const span = (id: string, attributes: Record<string, unknown>, offsetMs = 0): Span =>
  ({ spanId: id, traceId: 't', name: id, status: 'OK', attributes, startTime: at(offsetMs), endTime: at(offsetMs + 5) } as unknown as Span);

describe('observeModelFromSpans — the model an agent was observed running on', () => {
  it('reads gen_ai.request.model + gen_ai.provider.name from the chat spans (a hosted search service\'s trace shape)', () => {
    const observed = observeModelFromSpans([
      span('invoke_agent', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'aws.sagemaker' }, 0),
      span('chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': '/opt/ml/model', 'gen_ai.provider.name': 'aws.sagemaker' }, 10),
      span('execute_tool', { 'gen_ai.operation.name': 'execute_tool' }, 20),
      span('POST /_search', { 'http.request.method': 'POST' }, 30),
    ]);
    expect(observed).toEqual({ modelId: '/opt/ml/model', modelName: 'aws.sagemaker · /opt/ml/model', provider: 'aws.sagemaker' });
  });

  it('no spans / no model attribute → undefined (the caller leaves the model blank, never invents one)', () => {
    expect(observeModelFromSpans(undefined)).toBeUndefined();
    expect(observeModelFromSpans([])).toBeUndefined();
    expect(observeModelFromSpans([span('invoke_agent', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'aws.sagemaker' })])).toBeUndefined();
    expect(observeModelFromSpans([span('chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': '   ' })])).toBeUndefined();
  });

  it('first LLM-call span by start time wins; several distinct models are listed in the name', () => {
    const observed = observeModelFromSpans([
      span('chat-late', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-b', 'gen_ai.provider.name': 'p' }, 50),
      span('chat-early', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-a', 'gen_ai.provider.name': 'p' }, 5),
      span('chat-again', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-a', 'gen_ai.provider.name': 'p' }, 60),
    ]);
    expect(observed).toEqual({ modelId: 'model-a', modelName: 'p · model-a + model-b', provider: 'p' });
  });

  it('falls back to gen_ai.system for the provider and accepts a model on spans without an operation name', () => {
    expect(observeModelFromSpans([span('llm', { 'gen_ai.request.model': 'claude-3', 'gen_ai.system': 'anthropic' })]))
      .toEqual({ modelId: 'claude-3', modelName: 'anthropic · claude-3', provider: 'anthropic' });
    expect(observeModelFromSpans([span('chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm' })]))
      .toEqual({ modelId: 'm', modelName: 'm', provider: undefined });
  });

  it('ignores a model stamped on non-LLM operations (a tool span echoing the model is not an LLM call)', () => {
    expect(observeModelFromSpans([span('tool', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.request.model': 'x' })])).toBeUndefined();
  });
});
