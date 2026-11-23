/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The model an agent was OBSERVED running on, read from its OpenTelemetry
 * spans — for agents that own their model (a search service, a hosted
 * agent): Agent Health never picked a model for them, so the only truthful
 * value is what their traces report.
 *
 * Source attributes (OTel Gen AI semantic conventions): `gen_ai.request.model`
 * on the agent's LLM-call spans (`gen_ai.operation.name` = `chat` /
 * `text_completion` / `generate_content`), with `gen_ai.provider.name`
 * (`gen_ai.system` on older instrumentation) as the provider. The FIRST
 * LLM-call span by start time wins (one id, one provider — the value a run is
 * grouped by). Spans without a model, and runs without spans, yield
 * `undefined` — the caller leaves the model blank rather than inventing one.
 */

import type { Span } from '@/types';

export interface ObservedModel {
  /** `gen_ai.request.model` of the first LLM-call span (e.g. `example-model-v1`). */
  modelId: string;
  /** `<provider> · <model>` when a provider is known, else the model. */
  modelName: string;
  /** `gen_ai.provider.name` / `gen_ai.system` of that span, when present. */
  provider?: string;
}

const LLM_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function observeModelFromSpans(spans: ReadonlyArray<Span> | undefined | null): ObservedModel | undefined {
  if (!spans || spans.length === 0) return undefined;
  const llmSpans = spans
    .filter((s) => {
      const a = s.attributes || {};
      return str(a['gen_ai.request.model']) && (LLM_OPERATIONS.has(String(a['gen_ai.operation.name'])) || !a['gen_ai.operation.name']);
    })
    .sort((x, y) => Date.parse(String(x.startTime)) - Date.parse(String(y.startTime)));
  if (llmSpans.length === 0) return undefined;

  const first = llmSpans[0].attributes || {};
  const modelId = str(first['gen_ai.request.model'])!;
  const provider = str(first['gen_ai.provider.name']) ?? str(first['gen_ai.system']);
  return { modelId, modelName: provider ? `${provider} · ${modelId}` : modelId, provider };
}
