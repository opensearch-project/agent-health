/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client for `GET /api/judge/models` — the judge-model catalog annotated with
 * what each entry ACTUALLY judges with. Today the only annotated entries are
 * the agent (trace) judge's (`provider: 'agent'`), whose `model_id`
 * (`agent-trace-judge`) names a judge KIND: the LLM behind it is picked at
 * run time from the pi registry, so the server reports `resolvedModel` — the
 * exact provider-qualified id a run started now would be judged by.
 *
 * Consumed by the run-config dialogs (via {@link useAgentJudgeResolvedModel})
 * to label the dropdown entry "Agent Trace Judge — Claude Sonnet 4.5" so a
 * user knows which LLM is behind the judge before starting a run.
 */

import { useEffect, useState } from 'react';
import { shortJudgeModelLabel } from '@/lib/judgeIdentity';

export interface JudgeModelCatalogEntry {
  key: string;
  model_id?: string;
  display_name?: string;
  provider?: string;
  /** Provider-qualified id the agent judge would run on right now (agent entries only). */
  resolvedModel?: string;
  /** Registry display name for `resolvedModel` (e.g. "Claude Sonnet 4.5 (Global)"). */
  resolvedModelName?: string;
  /** How `resolvedModel` was chosen: 'auto' | 'env-pin' | 'evaluator-pin'. */
  resolvedSource?: string;
  /** Env var that pins the agent judge's model server-wide. */
  pinEnv?: string;
  /** Why resolution failed (pi SDK missing, no credentialed model) — entry still listed. */
  resolveError?: string;
}

export async function fetchJudgeModelCatalog(): Promise<JudgeModelCatalogEntry[]> {
  const res = await fetch('/api/judge/models');
  if (!res.ok) throw new Error(`GET /api/judge/models failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.models) ? (data.models as JudgeModelCatalogEntry[]) : [];
}

/** What the run dialogs need per agent-judge entry: a short model label + provenance. */
export interface AgentJudgeResolvedModel {
  /** Provider-qualified id, e.g. `amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0`. */
  id: string;
  /** Short label for the dropdown, e.g. `Claude Sonnet 4.5 (Global)` or `claude-sonnet-4-5`. */
  label: string;
  source?: string;
  pinEnv?: string;
}

/**
 * Resolved-model info keyed by catalog `key` for every `provider: 'agent'`
 * entry. Empty until the fetch completes (or on failure) — dropdowns render
 * the plain display name meanwhile, so nothing blocks on the pi registry.
 */
export function useAgentJudgeResolvedModel(): Record<string, AgentJudgeResolvedModel> {
  const [byKey, setByKey] = useState<Record<string, AgentJudgeResolvedModel>>({});
  useEffect(() => {
    let cancelled = false;
    fetchJudgeModelCatalog()
      .then((models) => {
        if (cancelled) return;
        const next: Record<string, AgentJudgeResolvedModel> = {};
        for (const m of models) {
          if (m.provider !== 'agent' || !m.resolvedModel) continue;
          next[m.key] = {
            id: m.resolvedModel,
            label: m.resolvedModelName || shortJudgeModelLabel(m.resolvedModel),
            source: m.resolvedSource,
            pinEnv: m.pinEnv,
          };
        }
        setByKey(next);
      })
      .catch(() => {
        /* catalog unavailable — dropdowns keep their plain labels */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return byKey;
}

/**
 * Dropdown label for a judge-model entry: the display name, plus
 * " — <resolved model>" for agent-judge entries once resolution is known.
 * `Agent Trace Judge (pi SDK + query_spans) — Claude Sonnet 4.5 (Global)`.
 */
export function judgeModelOptionLabel(
  displayName: string,
  key: string,
  resolved: Record<string, AgentJudgeResolvedModel>
): string {
  const r = resolved[key];
  return r ? `${displayName} — ${r.label}` : displayName;
}
