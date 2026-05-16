/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Judge Model dropdown component.
 * Groups models by provider (Bedrock, OpenAI-compatible, Claude Code, Agentic Judge, etc.)
 */

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DEFAULT_CONFIG } from '@/lib/constants';

const PROVIDER_LABELS: Record<string, string> = {
  demo: 'Demo',
  bedrock: 'AWS Bedrock',
  'openai-compatible': 'OpenAI-compatible',
  'claude-code': 'Claude Code',
  litellm: 'LiteLLM',
  agentic: 'Agentic Judge',
};

/** Order in which provider groups appear in the dropdown */
const PROVIDER_ORDER = ['bedrock', 'agentic', 'claude-code', 'openai-compatible', 'litellm', 'demo'];

interface JudgeModelSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Additional dynamically discovered models to merge in */
  extraModels?: Array<{ key: string; display_name: string; provider: string }>;
  className?: string;
  triggerClassName?: string;
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
}: JudgeModelSelectProps) {
  // Group static models by provider
  const modelsByProvider = Object.entries(DEFAULT_CONFIG.models).reduce((acc, [key, model]) => {
    const provider = model.provider || 'bedrock';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push({ key, display_name: model.display_name, provider });
    return acc;
  }, {} as Record<string, Array<{ key: string; display_name: string; provider: string }>>);

  // Merge extra models (deduplicating by key)
  for (const model of extraModels) {
    const provider = model.provider || 'bedrock';
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

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={className}>
        {sortedProviders.map(provider => (
          <SelectGroup key={provider}>
            <SelectLabel>{PROVIDER_LABELS[provider] || provider}</SelectLabel>
            {modelsByProvider[provider].map(model => (
              <SelectItem key={model.key} value={model.key}>
                {model.display_name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

export { PROVIDER_LABELS };
