/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Lifecycle Hook Utilities
 * Executes user-defined hooks from agent-health.config.ts
 */

import type { AgentHooks, BeforeRequestContext, AfterResponseContext, BuildTrajectoryContext, TrajectoryStep } from '@/types';
import { debug } from '@/lib/debug';

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

  debug('Hooks', `Executing beforeRequest hook for agent "${agentKey}"`);
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

    debug('Hooks', `beforeRequest hook for "${agentKey}" completed, endpoint:`, result.endpoint);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`beforeRequest hook failed for agent "${agentKey}": ${message}`);
  }
}

/**
 * Execute the afterResponse hook if defined on the agent.
 *
 * Use this hook to extract custom runId formats from agent responses
 * (e.g., PER agent's memory_id).
 *
 * - Returns the original context unchanged if no hook is defined
 * - Validates the hook return value has required fields
 * - Wraps errors with a descriptive message including the agent key
 */
export async function executeAfterResponseHook(
  hooks: AgentHooks | undefined,
  context: AfterResponseContext,
  agentKey: string
): Promise<AfterResponseContext> {
  if (!hooks?.afterResponse) {
    return context;
  }

  try {
    const result = await hooks.afterResponse(context);

    // Validate hook return value
    if (!result || typeof result !== 'object') {
      throw new Error('afterResponse hook must return an object with response, trajectory, and optional runId');
    }
    if (!('response' in result)) {
      throw new Error('afterResponse hook must return an object with a "response" field');
    }
    if (!Array.isArray(result.trajectory)) {
      throw new Error('afterResponse hook must return an object with a "trajectory" array field');
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`afterResponse hook failed for agent "${agentKey}": ${message}`);
  }
}

/**
 * Execute the buildTrajectory hook if defined on the agent.
 *
 * Use this hook to customize trajectory extraction from OTEL traces
 * for agents with custom span formats.
 *
 * - Returns null if no hook is defined
 * - Validates the hook return value is an array
 * - Wraps errors with a descriptive message including the agent key
 */
export async function executeBuildTrajectoryHook(
  hooks: AgentHooks | undefined,
  context: BuildTrajectoryContext,
  agentKey: string
): Promise<TrajectoryStep[] | null> {
  if (!hooks?.buildTrajectory) {
    return null;
  }

  try {
    const result = await hooks.buildTrajectory(context);

    // Validate hook return value
    if (result !== null && !Array.isArray(result)) {
      throw new Error('buildTrajectory hook must return an array of TrajectoryStep objects or null');
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`buildTrajectory hook failed for agent "${agentKey}": ${message}`);
  }
}
