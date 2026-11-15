/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The evaluation-run document as every creator mints it — the UI route
 * (`POST /api/storage/evaluation-runs`) and the CLI executor (#612) build the
 * same shape from the same inputs through this one function, so defaults,
 * snapshots and model resolution cannot drift between the two.
 */

import type { AgentConfig, AgentProvenanceFields, EvaluationRun, TestCase, TestCaseSnapshot, TestCaseSource } from '@/types';
import { resolveAgentModel } from '@/lib/resolveAgentModel';

export interface EvaluationRunDocumentInput {
  name?: string;
  description?: string;
  /** The sources AFTER resolution (file/code imports carry their test case ids). */
  sources: TestCaseSource[];
  agentKey: string;
  /** Legacy client-supplied agent model id; the agent's own config wins. */
  modelId?: string;
  judgeModelId?: unknown;
  evaluatorId?: string;
  concurrency?: number;
  benchmarkId?: string;
  trigger?: EvaluationRun['trigger'];
  agentEndpoint?: string;
  headers?: Record<string, string>;
  /** The resolved test cases (latest stored versions). */
  testCases: TestCase[];
  /** Agents the run's `agentKey` is resolved against (the creator's config). */
  agents: AgentConfig[];
  /** Agent-configuration provenance, already resolved by the creator (optional). */
  provenance?: AgentProvenanceFields;
  now?: Date;
}

export function mintEvaluationRunId(): string {
  return `eval-run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function snapshotTestCases(testCases: TestCase[]): TestCaseSnapshot[] {
  return testCases.map((tc) => ({ id: tc.id, version: (tc as any).version || 1, name: tc.name }));
}

/**
 * Resolve the agent's model from its own config (connectorConfig) so the run
 * records which model the agent ran on — there is no user-selected agent
 * model. Falls back to the client-supplied id (legacy) then empty.
 */
export function resolveRunModelId(agents: AgentConfig[], agentKey: string, modelId?: string): string {
  try {
    return resolveAgentModel(agents.find((a) => a.key === agentKey), modelId);
  } catch {
    return modelId || '';
  }
}

export function buildEvaluationRunDocument(input: EvaluationRunDocumentInput): EvaluationRun {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: mintEvaluationRunId(),
    name: input.name || `Evaluation Run ${new Date().toLocaleDateString()}`,
    description: input.description,
    sources: input.sources,
    agentKey: input.agentKey,
    modelId: resolveRunModelId(input.agents, input.agentKey, input.modelId),
    agentEndpoint: input.agentEndpoint,
    headers: input.headers,
    // Customer-supplied judge model id (separate from the agent's `modelId`),
    // kept on the run so the runner reads it and the UI can show which judge
    // model graded each case.
    judgeModelId: typeof input.judgeModelId === 'string' && input.judgeModelId ? input.judgeModelId : undefined,
    evaluatorId: input.evaluatorId,
    concurrency: input.concurrency,
    benchmarkId: input.benchmarkId,
    trigger: input.trigger || 'manual',
    status: 'running',
    testCaseSnapshots: snapshotTestCases(input.testCases),
    results: {},
    createdAt: now,
    // Spread of `undefined` is a no-op.
    ...(input.provenance ?? {}),
  } as EvaluationRun;
}
