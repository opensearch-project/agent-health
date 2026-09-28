/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve the agent + judge-model configuration a run refers to.
 *
 * Shared by the single-test-case runner (`runSingleUseCase.ts`) and the
 * trace-mode polled judge (`tracePolling.ts`). Custom agents added through
 * the Settings UI (JSON-backed store) are resolved alongside the ones from
 * `agent-health.config.ts`.
 */

import type { AgentConfig, BenchmarkRun } from '@/types';
import { loadConfigSync } from '@/lib/config/index';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getCustomAgents } from '@/server/services/customAgentStore';

/**
 * Safely load config with fallback to defaults.
 * Matches the defensive pattern used in services/evaluation/index.ts.
 */
function getConfig() {
  try {
    return loadConfigSync();
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Find a configured agent (built-in or custom) by key. Returns `undefined`
 * when no agent with that key exists.
 */
export function findConfiguredAgent(agentKey: string | undefined): AgentConfig | undefined {
  const config = getConfig();
  const allAgents = [...config.agents, ...getCustomAgents()];
  return allAgents.find(a => a.key === agentKey);
}

/**
 * Build an agent config from a run's configuration
 */
export function buildAgentConfigForRun(run: BenchmarkRun): AgentConfig {
  // Find the base agent config (includes custom agents from JSON-backed store)
  const baseAgent = findConfiguredAgent(run.agentKey);

  if (!baseAgent) {
    throw new Error(`Agent not found: ${run.agentKey}`);
  }

  // Apply run overrides
  return {
    ...baseAgent,
    endpoint: run.agentEndpoint || baseAgent.endpoint,
    headers: {
      ...baseAgent.headers,
      ...run.headers,
    },
  };
}

/**
 * Get the Bedrock model ID from a model key
 */
export function getBedrockModelId(modelKey: string): string {
  const config = getConfig();
  const modelConfig = config.models[modelKey];
  return modelConfig?.model_id || modelKey;
}
