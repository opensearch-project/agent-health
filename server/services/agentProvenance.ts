/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves the agent-configuration provenance stamped on a run at creation
 * time: the fingerprint of the agent's resolved config plus where that
 * config came from. One entry point for every run-creation path
 * (`POST /api/storage/evaluation-runs`, its `/rerun`, and the legacy
 * `POST /api/storage/benchmarks/:id/execute`) so they can never disagree
 * on what "the agent's configuration" means.
 *
 * Failure-safe by contract: provenance is metadata, never a reason to
 * refuse a run. Any error (config not loadable, unknown agent, git missing)
 * yields `undefined` and the caller stamps nothing.
 */

import type { AgentConfig, AgentProvenanceFields } from '@/types';
import { loadConfigSync, getConfigFileInfo } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { computeAgentFingerprint, resolveAgentConfigSource } from '@/lib/agentFingerprint';

/** Find an agent by key across the code config and the UI-added custom agents. */
export function findAgentByKey(agentKey: string): AgentConfig | undefined {
  let fromConfig: AgentConfig | undefined;
  try {
    fromConfig = loadConfigSync().agents.find(a => a.key === agentKey);
  } catch { /* fall through to custom agents */ }
  if (fromConfig) return fromConfig;
  try {
    return getCustomAgents().find(a => a.key === agentKey);
  } catch {
    return undefined;
  }
}

/**
 * Compute the provenance fields for `agentKey` as configured RIGHT NOW,
 * honouring a run-level endpoint override. Returns `undefined` when the
 * agent cannot be resolved (the run-creation routes already 400 on unknown
 * agents, so this is a defensive fallback, not the validation path) or
 * when the config cannot be serialized (e.g. a circular reference) — in
 * which case a warning names the agent and the reason, so a run without
 * provenance is never a silent mystery in the logs.
 *
 * Async because the config-source lookup shells out to git (bounded, no
 * shell); the hashing itself is pure and synchronous. No cache: two short
 * `git` spawns per run creation are negligible next to the storage writes
 * the same request performs, and a cache would make the `dirty` flag stale
 * exactly when a user is iterating on the config fastest.
 */
export async function resolveAgentProvenance(
  agentKey: string,
  overrides: { agentEndpoint?: string } = {},
): Promise<AgentProvenanceFields | undefined> {
  try {
    const agent = findAgentByKey(agentKey);
    if (!agent) {
      console.warn(`[agentProvenance] Agent "${agentKey}" not found in config; run proceeds without provenance`);
      return undefined;
    }
    const fp = computeAgentFingerprint(agent, { agentEndpoint: overrides.agentEndpoint });
    const agentConfigSource = agent.isCustom ? undefined : await resolveAgentConfigSource(getConfigFileInfo()?.path);
    return {
      agentFingerprint: fp.agentFingerprint,
      agentFingerprintShort: fp.agentFingerprintShort,
      ...(fp.agentPromptHash ? { agentPromptHash: fp.agentPromptHash } : {}),
      ...(agentConfigSource ? { agentConfigSource } : {}),
    };
  } catch (err: any) {
    console.warn(`[agentProvenance] Fingerprint resolution failed for ${agentKey} (run continues without provenance): ${err?.message}`);
    return undefined;
  }
}

/**
 * The subset of provenance that is mirrored onto every per-test-case REPORT
 * (the config source is run-level only; repeating a path + sha on 62
 * reports adds nothing).
 */
export function reportProvenanceFrom(
  source: AgentProvenanceFields | undefined | null,
): Pick<AgentProvenanceFields, 'agentFingerprint' | 'agentFingerprintShort' | 'agentPromptHash'> {
  if (!source?.agentFingerprint) return {};
  return {
    agentFingerprint: source.agentFingerprint,
    agentFingerprintShort: source.agentFingerprintShort,
    ...(source.agentPromptHash ? { agentPromptHash: source.agentPromptHash } : {}),
  };
}
