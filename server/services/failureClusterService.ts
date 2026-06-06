/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Failure Cluster Service
 *
 * Reads judge reasonings + improvement strategies + first-divergent-step
 * extracts across the regressed cases of one run-pair, asks the LLM to
 * group them into a small number of named root-cause clusters, and returns
 * the result. Used by the comparison page's diagnosis section.
 *
 * Uses the same Bedrock client and model as the skill improver — no new
 * model dependency. Result is cached in-process keyed by the regressed-case
 * fingerprint so re-renders / filter changes don't re-pay the LLM cost.
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import config from '../config';
import { debug } from '@/lib/debug';
import type { ImprovementStrategy } from '@/types';

export interface FailureCaseEvidence {
  caseId: string;
  caseName?: string;
  judgeReasoning?: string;
  improvementStrategies?: ImprovementStrategy[];
  firstDivergence?: {
    stepIndex: number;
    type: 'added' | 'removed' | 'modified';
    baselineSummary?: string;
    comparisonSummary?: string;
  };
}

export type ClusterType = 'knowledge' | 'tool_gap' | 'reasoning' | 'other';

export interface FailureCluster {
  /** Stable content-derived id; lookupable via getClusterById() */
  id: string;
  /** Short, human-readable name (e.g. "Wrong region shortcode") */
  name: string;
  /** One-sentence root-cause summary */
  summary: string;
  /** Test case IDs in this cluster */
  caseIds: string[];
  /** One illustrative quote from a failure in this cluster */
  exampleEvidence?: string;
  /**
   * What kind of fix this cluster suggests:
   *   knowledge → can be fixed with a skill / system prompt
   *   tool_gap  → agent needs a missing tool / wrong tool was reachable
   *   reasoning → planning or synthesis weakness
   *   other     → unclear / mixed
   */
  clusterType: ClusterType;
}

export interface ClusterFailuresInput {
  /** Display label for the losing run (e.g. "Claude — run #3") */
  loserLabel: string;
  /** Display label for the winning run (e.g. "Kiro — run #2") */
  winnerLabel: string;
  /** Regressed cases with judge evidence */
  cases: FailureCaseEvidence[];
}

export interface ClusterFailuresResult {
  clusters: FailureCluster[];
  /** Echo of input case count for sanity */
  totalFailures: number;
  /** Model id used */
  modelId: string;
}

const DEFAULT_MODEL_ID =
  process.env.SKILL_IMPROVER_MODEL_ID ||
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const bedrockClient = new BedrockRuntimeClient({
  region: config.AWS_REGION,
});

// ─── In-memory caches ─────────────────────────────────────────────────────
// 1. Result cache — keyed by a content fingerprint of the regressed-case
//    input. Same evidence in → same clusters out without a re-LLM call.
// 2. Cluster-by-id cache — every cluster the LLM returned, keyed by a
//    short stable hash of (cluster name + caseIds + summary). Lets receiving
//    pages (Skills, Settings, etc.) fetch a cluster's context by id when the
//    user clicks a next-step button, without the URL carrying full state.

interface CacheEntry {
  result: ClusterFailuresResult;
  computedAt: number;
}

export interface ClusterContextRecord {
  id: string;
  name: string;
  summary: string;
  clusterType: 'knowledge' | 'tool_gap' | 'reasoning' | 'other';
  caseIds: string[];
  exampleEvidence?: string;
  /** The labels the cluster was producing failures around (e.g. agent names) */
  loserLabel: string;
  winnerLabel: string;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();
const clusterById = new Map<string, ClusterContextRecord>();
const CACHE_MAX_ENTRIES = 200;
const CLUSTER_BY_ID_MAX = 1000;

function fingerprint(input: ClusterFailuresInput): string {
  const ids = input.cases.map(c => c.caseId).sort();
  const reasoningHash = input.cases
    .map(c => `${c.caseId}:${(c.judgeReasoning || '').length}`)
    .sort()
    .join('|');
  return `${input.loserLabel}::${input.winnerLabel}::${ids.join(',')}::${reasoningHash}`;
}

/**
 * Stable id for a cluster — short hash over content. Same cluster content
 * always maps to the same id, so re-runs return identical receiving-page URLs.
 */
export function clusterId(cluster: { name: string; caseIds: string[]; summary: string }): string {
  const seed = `${cluster.name}|${cluster.summary}|${[...cluster.caseIds].sort().join(',')}`;
  // Cheap deterministic FNV-1a 32-bit; we don't need crypto strength here.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `c-${hash.toString(36)}`;
}

/** Look up a cluster by id (in-process cache only). Returns undefined if the
 *  process restarted or the cluster aged out. */
export function getClusterById(id: string): ClusterContextRecord | undefined {
  return clusterById.get(id);
}

// ─── Prompt construction ──────────────────────────────────────────────────

function buildPrompt(input: ClusterFailuresInput): string {
  const { loserLabel, winnerLabel, cases } = input;
  const lines: string[] = [];

  lines.push(`# Failure Pattern Clustering`);
  lines.push('');
  lines.push(
    `You are analyzing why agent **${loserLabel}** failed test cases that ` +
      `agent **${winnerLabel}** passed. Below is the evidence for each ` +
      `failure: the judge's reasoning, suggested improvement strategies, and ` +
      `the first step where ${loserLabel}'s trajectory diverged from ${winnerLabel}'s.`
  );
  lines.push('');
  lines.push(
    `Your job is to group these failures into a small number of named ` +
      `root-cause clusters (typically 2–5). Two failures belong in the same ` +
      `cluster when they share the same underlying root cause — not just the ` +
      `same surface symptom.`
  );
  lines.push('');
  lines.push(`## Failures (${cases.length})`);
  lines.push('');

  for (const c of cases) {
    lines.push(`### ${c.caseId}${c.caseName ? ` — ${c.caseName}` : ''}`);
    if (c.judgeReasoning) {
      const reasoning = c.judgeReasoning.length > 1500
        ? c.judgeReasoning.slice(0, 1500) + '… [truncated]'
        : c.judgeReasoning;
      lines.push(`**Judge reasoning:** ${reasoning}`);
    }
    if (c.improvementStrategies && c.improvementStrategies.length > 0) {
      lines.push(`**Suggested improvements:**`);
      for (const s of c.improvementStrategies) {
        lines.push(`  - [${s.priority}] ${s.category}: ${s.recommendation}`);
      }
    }
    if (c.firstDivergence) {
      const fd = c.firstDivergence;
      lines.push(
        `**First divergence (step ${fd.stepIndex + 1}, ${fd.type}):** ` +
          `${loserLabel} → ${fd.baselineSummary ?? '(none)'} · ` +
          `${winnerLabel} → ${fd.comparisonSummary ?? '(none)'}`
      );
    }
    lines.push('');
  }

  lines.push(`## Output format`);
  lines.push('');
  lines.push(
    `Respond with a JSON object between the markers. No prose outside the ` +
      `markers. Each cluster must reference at least one case ID from the ` +
      `failures above.`
  );
  lines.push('');
  lines.push(`CLUSTERS_JSON_START`);
  lines.push(`{`);
  lines.push(`  "clusters": [`);
  lines.push(`    {`);
  lines.push(`      "name": "Short cluster name (≤6 words)",`);
  lines.push(`      "summary": "One sentence describing the root cause.",`);
  lines.push(`      "caseIds": ["case-id-1", "case-id-2"],`);
  lines.push(`      "exampleEvidence": "One illustrative quote (≤200 chars).",`);
  lines.push(
    `      "clusterType": "knowledge | tool_gap | reasoning | other"`
  );
  lines.push(`    }`);
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push(`CLUSTERS_JSON_END`);

  return lines.join('\n');
}

// ─── Response parsing ─────────────────────────────────────────────────────

function extractJsonBetweenMarkers(text: string): string | null {
  const start = text.indexOf('CLUSTERS_JSON_START');
  const end = text.indexOf('CLUSTERS_JSON_END');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text
    .slice(start + 'CLUSTERS_JSON_START'.length, end)
    .trim();
  // Strip any surrounding code fences the model might add.
  return slice.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function isValidClusterType(v: unknown): v is ClusterType {
  return v === 'knowledge' || v === 'tool_gap' || v === 'reasoning' || v === 'other';
}

function parseClusters(
  responseText: string,
  validCaseIds: Set<string>
): FailureCluster[] {
  const json = extractJsonBetweenMarkers(responseText);
  if (!json) {
    throw new Error('LLM response did not include CLUSTERS_JSON_START/END markers');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`LLM returned invalid JSON between markers: ${(e as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || !('clusters' in parsed)) {
    throw new Error('LLM response missing top-level "clusters" array');
  }

  const rawClusters = (parsed as { clusters: unknown }).clusters;
  if (!Array.isArray(rawClusters)) {
    throw new Error('"clusters" must be an array');
  }

  const result: FailureCluster[] = [];
  for (const raw of rawClusters) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
    const caseIds = Array.isArray(r.caseIds)
      ? r.caseIds.filter((x): x is string => typeof x === 'string' && validCaseIds.has(x))
      : [];
    const exampleEvidence = typeof r.exampleEvidence === 'string' ? r.exampleEvidence : undefined;
    const clusterType: ClusterType = isValidClusterType(r.clusterType) ? r.clusterType : 'other';

    if (!name || !summary || caseIds.length === 0) continue;
    result.push({
      id: clusterId({ name, summary, caseIds }),
      name,
      summary,
      caseIds,
      exampleEvidence,
      clusterType,
    });
  }

  return result;
}

// ─── Public entry point ───────────────────────────────────────────────────

export async function clusterFailures(
  input: ClusterFailuresInput,
  options: { force?: boolean; modelId?: string } = {}
): Promise<ClusterFailuresResult> {
  if (input.cases.length === 0) {
    return { clusters: [], totalFailures: 0, modelId: options.modelId || DEFAULT_MODEL_ID };
  }

  const key = fingerprint(input);
  if (!options.force) {
    const cached = cache.get(key);
    if (cached) {
      debug('FailureCluster', `cache hit for ${key.slice(0, 60)}…`);
      return cached.result;
    }
  }

  const modelId = options.modelId || DEFAULT_MODEL_ID;
  const prompt = buildPrompt(input);

  debug(
    'FailureCluster',
    `Clustering ${input.cases.length} failures via ${modelId}; key=${key.slice(0, 60)}…`
  );

  const command = new ConverseCommand({
    modelId,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    system: [
      {
        text:
          'You are a software-quality analyst. You cluster agent failures by ' +
          'root cause and respond with strictly valid JSON between the ' +
          'specified markers. No prose outside the markers.',
      },
    ],
    inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
  });

  const response = await bedrockClient.send(command);

  let responseText = '';
  if (response.output?.message?.content) {
    for (const block of response.output.message.content) {
      if ('text' in block && block.text) responseText += block.text;
    }
  }
  if (!responseText) {
    throw new Error('Empty response from LLM');
  }

  const validIds = new Set(input.cases.map(c => c.caseId));
  const clusters = parseClusters(responseText, validIds);

  const result: ClusterFailuresResult = {
    clusters,
    totalFailures: input.cases.length,
    modelId,
  };

  // Cap cache size — drop oldest if overflowing.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { result, computedAt: response.$metadata.attempts ?? 0 });

  // Index every cluster by id so receiving pages can fetch it later by URL.
  for (const c of clusters) {
    if (clusterById.size >= CLUSTER_BY_ID_MAX) {
      const oldestKey = clusterById.keys().next().value;
      if (oldestKey) clusterById.delete(oldestKey);
    }
    clusterById.set(c.id, {
      id: c.id,
      name: c.name,
      summary: c.summary,
      clusterType: c.clusterType,
      caseIds: c.caseIds,
      exampleEvidence: c.exampleEvidence,
      loserLabel: input.loserLabel,
      winnerLabel: input.winnerLabel,
      storedAt: response.$metadata.attempts ?? 0,
    });
  }

  return result;
}

/** Test/diagnostic helper. */
export function _resetClusterCache(): void {
  cache.clear();
  clusterById.clear();
}
