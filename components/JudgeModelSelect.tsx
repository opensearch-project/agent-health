/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared model dropdown for run-config dialogs.
 *
 * Used in TWO ROLES across the app:
 *
 *   1. **Agent Model** — the LLM the AGENT uses to think. Filtered to
 *      providers the agent connector can actually invoke
 *      (`bedrock`, `openai-compatible`, `litellm`). Pass
 *      `filterToAgentLLMs={true}`. Pre-fix the unfiltered dropdown let
 *      users pick judge-only pseudo-models (`pi-judge`, `agent-trace-judge`,
 *      `claude-code-judge`, `agentic-claude-code`, etc.) as the agent's
 *      model and the agent broke at Bedrock with `400 The provided model
 *      identifier is invalid`.
 *
 *   2. **Judge Model** — the LLM the LLM judge uses to grade the
 *      trajectory. Lists every provider plus a "Use evaluator default"
 *      sentinel that maps to `undefined`. Pass `allowDefault={true}`
 *      AND `value` of type `string | undefined`.
 *
 * Same component, two roles — keeps the dropdown shape consistent across
 * QuickRunModal, NewRunPage, TestCaseDetailPage, BenchmarkRunsPage,
 * BenchmarkEditor without forking the implementation.
 */

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { useAgentJudgeResolvedModel, judgeModelOptionLabel } from '@/services/client/judgeModelsApi';

const PROVIDER_LABELS: Record<string, string> = {
  demo: 'Demo',
  bedrock: 'AWS Bedrock',
  'openai-compatible': 'OpenAI-compatible',
  'claude-code': 'Claude Code',
  litellm: 'LiteLLM',
  agentic: 'Agentic Judge',
  pi: 'Pi (Judge)',
  agent: 'Agent Trace Judge',
};

/** Order in which provider groups appear in the dropdown */
const PROVIDER_ORDER = ['bedrock', 'openai-compatible', 'litellm', 'agent', 'agentic', 'claude-code', 'pi', 'demo'];

/** Providers the AGENT (not the judge) can actually be invoked through. */
const AGENT_LLM_PROVIDERS = new Set(['bedrock', 'openai-compatible', 'litellm']);

const DEFAULT_SENTINEL = '__default__';

interface JudgeModelSelectProps {
  /**
   * Selected model id. `''` (empty string) is the "use evaluator default"
   * sentinel when `allowDefault` is set — the public API is always a plain
   * `string` (never `undefined`) so existing call sites that store the model
   * id as a required `string` (benchmark dialogs etc.) don't have to handle
   * `undefined`. Internally this maps to a Radix-safe non-empty sentinel
   * because Radix `<SelectItem value="">` is disallowed.
   */
  value: string;
  onValueChange: (value: string) => void;
  /** Additional dynamically discovered models to merge in */
  extraModels?: Array<{ key: string; display_name: string; provider: string }>;
  className?: string;
  triggerClassName?: string;
  /**
   * When true, restrict the dropdown to providers the AGENT connector can
   * invoke (bedrock / openai-compatible / litellm). Use this for the
   * "Agent Model" role so users can't accidentally pick a judge-only
   * pseudo-model as the agent's model.
   */
  filterToAgentLLMs?: boolean;
  /**
   * When true, render a "Use evaluator default" item at the top that maps to
   * `''` (empty string). Use this for the "Judge Model" role so the customer
   * can defer to the evaluator's `inferenceConfig` (resolved server-side,
   * falling back to `BEDROCK_MODEL_ID` env). The caller maps `''` ↔
   * `undefined` at its own state boundary if it stores an optional field.
   */
  allowDefault?: boolean;
  /** Label for the default sentinel. Default: "Use evaluator default". */
  defaultLabel?: string;
}

/**
 * Group DEFAULT_CONFIG.models by provider, merge extras, and render as a grouped Select.
 */
export function JudgeModelSelect({
  value,
  onValueChange,
  extraModels = [],
  className,
  triggerClassName,
  filterToAgentLLMs = false,
  allowDefault = false,
  defaultLabel = 'Use evaluator default',
}: JudgeModelSelectProps) {
  // For `provider: 'agent'` entries the model_id (`agent-trace-judge`) names
  // a judge KIND whose LLM is picked at run time -- GET /api/judge/models
  // tells us which one, so the option reads "Agent Trace Judge -- Claude
  // Sonnet 4.5" instead of leaving the user to guess. Empty until fetched.
  const resolvedAgentModels = useAgentJudgeResolvedModel();
  // Group static models by provider, applying the agent-LLM filter when
  // requested so judge-only pseudo-models are hidden from the agent role.
  const modelsByProvider = Object.entries(DEFAULT_CONFIG.models).reduce((acc, [key, model]) => {
    const provider = model.provider || 'bedrock';
    if (filterToAgentLLMs && !AGENT_LLM_PROVIDERS.has(provider)) return acc;
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push({ key, display_name: model.display_name, provider });
    return acc;
  }, {} as Record<string, Array<{ key: string; display_name: string; provider: string }>>);

  // Merge extra models (deduplicating by key) — same filter applies.
  for (const model of extraModels) {
    const provider = model.provider || 'bedrock';
    if (filterToAgentLLMs && !AGENT_LLM_PROVIDERS.has(provider)) continue;
    if (!modelsByProvider[provider]) modelsByProvider[provider] = [];
    const existing = modelsByProvider[provider].find(m => m.key === model.key);
    if (!existing) {
      modelsByProvider[provider].push(model);
    }
  }

  // Sort providers by defined order
  const sortedProviders = Object.keys(modelsByProvider).sort((a, b) => {
    const ai = PROVIDER_ORDER.indexOf(a);
    const bi = PROVIDER_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  // Radix treats `''` as "no value" and disallows `<SelectItem value="">`,
  // so we round-trip the empty-string "default" through a non-empty internal
  // sentinel. The PUBLIC contract stays `string` in both directions: the
  // trigger shows the placeholder for `''`, and the change event emits `''`
  // (never `undefined`) when the default item is chosen.
  const renderedValue = value === '' ? (allowDefault ? DEFAULT_SENTINEL : '') : value;
  const handleChange = (val: string) => {
    onValueChange(val === DEFAULT_SENTINEL ? '' : val);
  };

  return (
    <Select value={renderedValue} onValueChange={handleChange}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder={allowDefault ? defaultLabel : undefined} />
      </SelectTrigger>
      <SelectContent className={className}>
        {allowDefault && (
          <SelectItem value={DEFAULT_SENTINEL}>{defaultLabel}</SelectItem>
        )}
        {sortedProviders.map(provider => (
          <SelectGroup key={provider}>
            <SelectLabel>{PROVIDER_LABELS[provider] || provider}</SelectLabel>
            {modelsByProvider[provider].map(model => (
              <SelectItem
                key={model.key}
                value={model.key}
                title={resolvedAgentModels[model.key] ? `Underlying LLM (${resolvedAgentModels[model.key].source}): ${resolvedAgentModels[model.key].id}` : undefined}
                data-resolved-judge-model={resolvedAgentModels[model.key]?.id}
              >
                {judgeModelOptionLabel(model.display_name, model.key, resolvedAgentModels)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

export { PROVIDER_LABELS };
