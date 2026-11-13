/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Explicit dependencies of `executeEvaluationRun` (services/evaluationRunner.ts).
 *
 * The runner used to reach for process globals at execution time: the config
 * cache (`loadConfigSync()`) for agents/models, the backend URL (`AH_PORT`)
 * for the judge and traces self-calls, and the storage module for every
 * write. Those are now passed in, so the same runner can execute inside the
 * server (this file's `serverRunnerDeps`) or in another process that resolves
 * them from ITS environment and talks to the server over HTTP (#612).
 */

import type { AgentConfig, Evaluator, ModelConfig } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { loadConfigSync } from '@/lib/config/index';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getBackendUrl } from '@/lib/portConfig';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { defaultJudgeTransport, type JudgeTransport } from '@/lib/judge/transport';
import { fetchTracesForRun, type TracesClient } from '@/services/traces/index';
import { LocalRunSink, type RunSink } from './runSink';

export interface RunnerDeps {
  /** Where results are written. */
  sink: RunSink;
  /** Agents the run's `agentKey` is resolved against. */
  agents: AgentConfig[];
  /** Model catalog (`run.modelId` → Bedrock id / display name). */
  models: Record<string, ModelConfig>;
  /** How the LLM judge is reached. */
  judge: JudgeTransport;
  /** Where traces are read from. */
  traces: TracesClient;
  /**
   * Resolve a STORED evaluator by id (system evaluators never reach this).
   * The runner's only read: it must know up front whether the run's
   * evaluator is `kind: 'deterministic'` (scored in code, never sent to an
   * LLM judge — see services/evaluation/deterministicJudgement.ts).
   */
  getEvaluator: (evaluatorId: string) => Promise<Evaluator | null>;
}

/**
 * Agents + models as the server process currently knows them: the resolved
 * config (`agent-health.config.*` merged with defaults, DEFAULT_CONFIG if the
 * loader fails) plus UI-added custom agents.
 */
function processAgentsAndModels(): Pick<RunnerDeps, 'agents' | 'models'> {
  let config: { agents: AgentConfig[]; models: Record<string, ModelConfig> };
  try {
    config = loadConfigSync();
  } catch {
    config = DEFAULT_CONFIG as unknown as typeof config;
  }
  return { agents: [...config.agents, ...getCustomAgents()], models: config.models };
}

/** Traces read from `/api/traces` on the agent-health server at `baseUrl`. */
function httpTracesClient(baseUrl: string): TracesClient {
  return { fetchTracesForRun: (params) => fetchTracesForRun(params, { baseUrl }) };
}

/**
 * Dependencies for a run executed INSIDE the server process: writes go to
 * the server's own storage, agents/models come from the process config, and
 * judge/traces are HTTP self-calls to this server's bound URL.
 *
 * `overrides` lets a route pass what it just reloaded (fresh agents/models
 * after a config re-read) or a test pass stubs.
 */
export function serverRunnerDeps(storage: IStorageModule, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const needsConfig = !overrides.agents || !overrides.models;
  const fromProcess = needsConfig ? processAgentsAndModels() : undefined;
  return {
    sink: overrides.sink ?? new LocalRunSink(storage),
    agents: overrides.agents ?? fromProcess!.agents,
    models: overrides.models ?? fromProcess!.models,
    judge: overrides.judge ?? defaultJudgeTransport(),
    traces: overrides.traces ?? httpTracesClient(getBackendUrl()),
    getEvaluator: overrides.getEvaluator ?? ((id) => storage.evaluators.getById(id)),
  };
}
