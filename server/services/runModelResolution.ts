/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve which model a single-test-case run (`POST /api/evaluate`) records
 * and forwards to the agent.
 *
 * Two kinds of agents exist:
 *
 *   1. **Agent-owned model.** The agent decides its own model — either it
 *      declares one in its config (`connectorConfig.model`,
 *      `connectorConfig.env.ANTHROPIC_MODEL`, a `--model` arg; see
 *      {@link resolveAgentModel}) or its connector never forwards a run-level
 *      model at all ({@link AgentConnector.ownsModel}: subprocess CLIs,
 *      managed agents). The declared value is typically a provider-native id
 *      (e.g. an inference-profile name) that is **never** a key of the
 *      `config.models` catalog, so requiring a catalog key here rejected every
 *      run of such an agent with `Model not found` — and accepting an
 *      unrelated catalog key instead recorded a model the agent never used.
 *      For these agents the client's `modelId` is ignored and the report
 *      records the agent-declared model (or none) as informational.
 *
 *   2. **Catalog model.** HTTP-style agents (AG-UI streaming, REST /
 *      OpenAI-compatible / LangGraph without a declared model, the demo mock)
 *      take the requested model on the wire. The client's `modelId` must be a
 *      catalog key (unchanged behaviour); when the client sends none, a
 *      catalog default is used so raw API callers don't have to know the
 *      catalog. Only when nothing resolves is the request rejected.
 */

import type { AgentConfig, ModelConfig, ModelSource } from '@/types';
import { resolveAgentModel } from '@/lib/resolveAgentModel';
import { AGENT_MODEL_PROVIDERS, DEFAULT_AGENT_MODEL_ID } from '@/lib/agentModelCatalog';
import { connectorRegistry } from '@/services/connectors/server';

export interface AgentModelOwnership {
  /** True when the agent (not the caller) decides which model runs. */
  ownsModel: boolean;
  /** The model the agent declares in its own config, when it does. */
  declaredModelId?: string;
}

export interface ResolvedRunModel {
  /**
   * The id recorded on the run and forwarded to the connector. Empty string
   * when an `ownsModel` connector declares nothing (the agent's default
   * applies and is unknown to us) — callers must tolerate that.
   */
  modelId: string;
  /** Display label; the catalog `display_name` when the id is a catalog key. */
  modelName: string;
  modelSource: ModelSource;
  /** Catalog entry, when `modelId` is a catalog key. Absent for agent-native ids. */
  catalogEntry?: ModelConfig;
}

export interface RunModelResolutionError {
  code: 'MODEL_NOT_FOUND' | 'MODEL_REQUIRED';
  message: string;
}

export interface RunModelResolved {
  ok: true;
  model: ResolvedRunModel;
  /** A caller-sent `modelId` that was ignored because the agent owns its model. */
  ignoredRequestedModelId?: string;
}
export interface RunModelRejected {
  ok: false;
  error: RunModelResolutionError;
}
export type RunModelResolution = RunModelResolved | RunModelRejected;

/**
 * Describe who owns an agent's model. Exposed on `GET /api/agents` so the UI
 * can hide the Agent Model picker (and show the declared model read-only)
 * for agents whose model is not the caller's to choose.
 */
export function getAgentModelOwnership(agent: AgentConfig): AgentModelOwnership {
  const declared = resolveAgentModel(agent);
  if (declared) return { ownsModel: true, declaredModelId: declared };
  let connectorOwns = false;
  try {
    connectorOwns = connectorRegistry.getForAgent(agent as any).ownsModel === true;
  } catch {
    // No connector registered for this type — treat as a catalog agent.
  }
  return { ownsModel: connectorOwns };
}

/** Pick the catalog default for catalog-model agents run without a `modelId`. */
export function pickDefaultAgentModelKey(models: Record<string, ModelConfig>): string | undefined {
  if (models[DEFAULT_AGENT_MODEL_ID]) return DEFAULT_AGENT_MODEL_ID;
  return Object.keys(models).find((key) => AGENT_MODEL_PROVIDERS.has(models[key]?.provider));
}

/**
 * Resolve the run model for `agent`.
 *
 * Order: agent-declared model → connector owns model (no id) → requested
 * catalog key → catalog default → error. A requested `modelId` that is not a
 * catalog key is only an error for catalog-model agents; for agent-owned
 * models it is reported back as `ignoredRequestedModelId` so the route can
 * log it.
 */
export function resolveRunModel(
  agent: AgentConfig,
  requestedModelId: unknown,
  models: Record<string, ModelConfig>,
): RunModelResolution {
  const requested = typeof requestedModelId === 'string' && requestedModelId.trim() ? requestedModelId.trim() : undefined;
  const ownership = getAgentModelOwnership(agent);

  if (ownership.ownsModel) {
    const modelId = ownership.declaredModelId ?? '';
    const catalogEntry = modelId ? models[modelId] : undefined;
    return {
      ok: true,
      model: {
        modelId,
        modelName: catalogEntry?.display_name || modelId,
        modelSource: 'agent',
        catalogEntry,
      },
      ignoredRequestedModelId: requested && requested !== modelId ? requested : undefined,
    };
  }

  if (requested) {
    const catalogEntry = models[requested];
    if (!catalogEntry) {
      return {
        ok: false,
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model not found: ${requested}. Agent '${agent.key}' takes a catalog model; ` +
            `pass one of: ${Object.keys(models).join(', ') || '(catalog is empty)'}`,
        },
      };
    }
    return {
      ok: true,
      model: { modelId: requested, modelName: catalogEntry.display_name || requested, modelSource: 'request', catalogEntry },
    };
  }

  const fallbackKey = pickDefaultAgentModelKey(models);
  if (!fallbackKey) {
    return {
      ok: false,
      error: {
        code: 'MODEL_REQUIRED',
        message: `modelId is required for agent '${agent.key}': it takes a catalog model and the catalog has no agent-capable default`,
      },
    };
  }
  const catalogEntry = models[fallbackKey];
  return {
    ok: true,
    model: { modelId: fallbackKey, modelName: catalogEntry.display_name || fallbackKey, modelSource: 'default', catalogEntry },
  };
}
