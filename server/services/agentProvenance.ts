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
import {
  computeAgentFingerprint,
  resolveAgentConfigSource,
  type AgentConfigSource,
} from '@/lib/agentFingerprint';

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
 * Config-source lookup is per config FILE, not per agent, and `git
 * rev-parse` + `git status` cost two subprocess spawns. Cache by path with a
 * short TTL so a 62-case benchmark started via the legacy path (which
 * creates one run) and a burst of CLI runs don't fork git on every call,
 * while an edit-then-rerun within a session still sees the new sha promptly.
 */
const CONFIG_SOURCE_TTL_MS = 5_000;
let cachedSource: { path: string; at: number; value: AgentConfigSource | undefined } | null = null;

export function resolveConfigSourceCached(now = Date.now()): AgentConfigSource | undefined {
  const info = getConfigFileInfo();
  const path = info?.path;
  if (!path) return undefined;
  if (cachedSource && cachedSource.path === path && now - cachedSource.at < CONFIG_SOURCE_TTL_MS) {
    return cachedSource.value;
  }
  const value = resolveAgentConfigSource(path);
  cachedSource = { path, at: now, value };
  return value;
}

/** Test hook. */
export function clearConfigSourceCache(): void {
  cachedSource = null;
}

/**
 * Compute the provenance fields for `agentKey` as configured RIGHT NOW,
 * honouring a run-level endpoint override. Returns `undefined` when the
 * agent cannot be resolved (the run-creation routes already 400 on unknown
 * agents, so this is a defensive fallback, not the validation path).
 */
export function resolveAgentProvenance(
  agentKey: string,
  overrides: { agentEndpoint?: string } = {},
): AgentProvenanceFields | undefined {
  try {
    const agent = findAgentByKey(agentKey);
    if (!agent) return undefined;
    const fp = computeAgentFingerprint(agent, { agentEndpoint: overrides.agentEndpoint });
    const agentConfigSource = agent.isCustom ? undefined : resolveConfigSourceCached();
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
