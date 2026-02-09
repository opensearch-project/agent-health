/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Lifecycle Hook Utilities
 * Executes user-defined hooks from agent-health.config.ts
 */

import type { AgentHooks, BeforeRequestContext } from '@/types';

/**
 * Execute the beforeRequest hook if defined on the agent.
 *
 * - Returns the original context unchanged if no hook is defined
 * - Validates the hook return value has required fields
 * - Wraps errors with a descriptive message including the agent key
 */
export async function executeBeforeRequestHook(
  hooks: AgentHooks | undefined,
  context: BeforeRequestContext,
  agentKey: string
): Promise<BeforeRequestContext> {
  if (!hooks?.beforeRequest) {
    return context;
  }

  try {
    const result = await hooks.beforeRequest(context);

    // Validate hook return value
    if (!result || typeof result !== 'object') {
      throw new Error('beforeRequest hook must return an object with endpoint, payload, and headers');
    }
    if (typeof result.endpoint !== 'string') {
      throw new Error('beforeRequest hook must return an object with a string "endpoint" field');
    }
    if (!('payload' in result)) {
      throw new Error('beforeRequest hook must return an object with a "payload" field');
    }
    if (!result.headers || typeof result.headers !== 'object') {
      throw new Error('beforeRequest hook must return an object with an object "headers" field');
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`beforeRequest hook failed for agent "${agentKey}": ${message}`);
  }
}
