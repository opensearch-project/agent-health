// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import type { AgentConfig } from '@/types';

/**
 * Resolve the LLM an agent runs on.
 *
 * The agent's model is owned by the agent's OWN config (`agent-health.config.ts`),
 * NOT a user-facing "agent model" selector. There is intentionally no run-level
 * or UI/CLI way to override it — picking a model separately from the agent is a
 * leaky abstraction (subprocess agents like Claude Code / pi ignore it and run
 * on whatever their connector is configured with). Claude-like agents that DO
 * accept a model take it via their connector config.
 *
 * Resolution order (all from the agent's `connectorConfig`):
 *   1. `connectorConfig.model`              — pi / streaming / openai-compatible
 *   2. `connectorConfig.env.ANTHROPIC_MODEL` — claude-code
 *   3. `connectorConfig.args` `--model <id>` — any subprocess agent passing a flag
 *
 * `fallback` exists only for backward compatibility with runs/agents created
 * before the agent-model concept was removed (where the run carried a
 * user-selected `modelId`). New code should not rely on it.
 */
export function resolveAgentModel(
  agent: AgentConfig | undefined | null,
  fallback?: string,
): string {
  const cc = (agent?.connectorConfig || {}) as Record<string, any>;
  if (typeof cc.model === 'string' && cc.model) return cc.model;
  const envModel = cc.env?.ANTHROPIC_MODEL;
  if (typeof envModel === 'string' && envModel) return envModel;
  const args: unknown = cc.args;
  if (Array.isArray(args)) {
    const i = args.indexOf('--model');
    if (i >= 0 && typeof args[i + 1] === 'string' && args[i + 1]) return args[i + 1] as string;
  }
  return fallback || '';
}
