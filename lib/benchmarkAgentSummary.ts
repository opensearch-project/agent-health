/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-agent view of a benchmark's runs.
 *
 * A benchmark is the container; each agent (or agent endpoint) that ran it
 * has its OWN latest result, trend and history. The Benchmarks list page used
 * to collapse every agent into one "latest run" per benchmark, so running the
 * same benchmark with two agents produced one row whose latest/trend/sparkline
 * silently mixed them ("Improving" because the previous run was a different,
 * weaker agent). Nothing in this module ever compares a run with a run of
 * another agent.
 *
 * Agent identity on these pages = `agentKey` + `agentEndpoint` (when the run
 * overrode the endpoint). See {@link agentIdentityKey}.
 *
 * Pure (no React/DOM) so the list page and the Runs tab share one definition
 * of "which agent is this run" and the arithmetic is unit-testable.
 */

import type { BenchmarkRun } from '@/types';

// ─── Agent identity ──────────────────────────────────────────────────────────

export interface AgentIdentityRun {
  agentKey?: string;
  agentEndpoint?: string;
}

/**
 * Stable identity of the agent behind a run: the bare `agentKey` when the run
 * used the configured endpoint, `agentKey@endpoint` when it overrode it. Two
 * runs of the same key against different hosts are different agents for
 * latest/trend/series purposes.
 */
export function agentIdentityKey(run: AgentIdentityRun): string {
  const key = run.agentKey || '';
  return run.agentEndpoint ? `${key}@${run.agentEndpoint}` : key;
}

/** `https://a.example.com:8443/v1/chat` → `a.example.com:8443`; non-URLs pass through. */
export function endpointHost(endpoint: string): string {
  try {
    const host = new URL(endpoint).host;
    return host || endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * Labels per agent identity. The label is the agent's name alone unless the
 * same `agentKey` appears with ≥2 distinct endpoints among `runs`, in which
 * case each identity is suffixed with its host — `Name (host)` — and the
 * configured-endpoint variant with `(default endpoint)`, so the lines can be
 * told apart.
 */
export function agentIdentityLabels(
  runs: AgentIdentityRun[],
  nameFor: (agentKey: string) => string,
): Map<string, string> {
  const identitiesByKey = new Map<string, Set<string>>();
  for (const run of runs) {
    const key = run.agentKey || '';
    if (!identitiesByKey.has(key)) identitiesByKey.set(key, new Set());
    identitiesByKey.get(key)!.add(agentIdentityKey(run));
  }
  const labels = new Map<string, string>();
  for (const run of runs) {
    const id = agentIdentityKey(run);
    if (labels.has(id)) continue;
    const key = run.agentKey || '';
    const name = nameFor(key);
    const ambiguous = (identitiesByKey.get(key)?.size ?? 0) >= 2;
    labels.set(id, ambiguous
      ? `${name} (${run.agentEndpoint ? endpointHost(run.agentEndpoint) : 'default endpoint'})`
      : name);
  }
  return labels;
}

// ─── Scores / trend ──────────────────────────────────────────────────────────

/**
 * Pass rate (0–100) of a run, or null when nothing is evaluable. Errored
 * cases (evaluator produced no verdict, #242) are excluded from both sides.
 */
export function computeRunScore(run: BenchmarkRun): number | null {
  if (run.stats && run.stats.total > 0) {
    const errored = run.stats.errored ?? 0;
    const evaluable = Math.max(0, run.stats.total - errored);
    if (evaluable === 0) return null;
    return Math.round((run.stats.passed / evaluable) * 100);
  }
  const results = Object.values(run.results || {});
  if (results.length === 0) return null;
  const completed = results.filter(r => r.status === 'completed').length;
  return Math.round((completed / results.length) * 100);
}

export type TrendDir = 'improving' | 'stable' | 'regressing' | 'unknown';

/** Latest vs previous score of the SAME agent; ±5 points is "stable". */
export function trendBetween(latest: number | null, prev: number | null | undefined): TrendDir {
  if (latest === null || prev === null || prev === undefined) return 'unknown';
  const diff = latest - prev;
  if (diff > 5) return 'improving';
  if (diff < -5) return 'regressing';
  return 'stable';
}

// ─── Per-agent summary ───────────────────────────────────────────────────────

export interface AgentRunSummary {
  /** {@link agentIdentityKey} of the runs in this summary. */
  agentId: string;
  agentKey: string;
  agentEndpoint?: string;
  /** Display label (name, or `Name (host)` when the key has several endpoints). */
  label: string;
  runCount: number;
  latestRun: BenchmarkRun;
  /** Epoch ms of `latestRun.createdAt`. */
  latestAt: number;
  latestScore: number | null;
  passed: number;
  failed: number;
  total: number;
  /** Latest vs previous run of THIS agent only. */
  trend: TrendDir;
  /** Scores of this agent's last 10 runs, oldest first (null scores → 0). */
  passRateHistory: number[];
}

const createdAtMs = (run: BenchmarkRun): number => {
  const t = new Date(run.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * One summary per agent identity present in `runs`, most recently active
 * first. Each summary's latest/trend/history are computed from that agent's
 * runs alone.
 */
export function summarizeRunsByAgent(
  runs: BenchmarkRun[],
  nameFor: (agentKey: string) => string,
): AgentRunSummary[] {
  const labels = agentIdentityLabels(runs, nameFor);
  const byAgent = new Map<string, BenchmarkRun[]>();
  for (const run of runs) {
    const id = agentIdentityKey(run);
    if (!byAgent.has(id)) byAgent.set(id, []);
    byAgent.get(id)!.push(run);
  }
  const out: AgentRunSummary[] = [];
  for (const [agentId, agentRuns] of byAgent) {
    const sorted = [...agentRuns].sort((a, b) => createdAtMs(b) - createdAtMs(a));
    const latestRun = sorted[0];
    const latestScore = computeRunScore(latestRun);
    const prevScore = sorted.length > 1 ? computeRunScore(sorted[1]) : undefined;
    out.push({
      agentId,
      agentKey: latestRun.agentKey || '',
      agentEndpoint: latestRun.agentEndpoint,
      label: labels.get(agentId) ?? (latestRun.agentKey || ''),
      runCount: agentRuns.length,
      latestRun,
      latestAt: createdAtMs(latestRun),
      latestScore,
      passed: latestRun.stats?.passed ?? 0,
      failed: latestRun.stats?.failed ?? 0,
      total: latestRun.stats?.total ?? Object.keys(latestRun.results || {}).length,
      trend: trendBetween(latestScore, prevScore),
      passRateHistory: sorted.slice(0, 10).reverse().map(r => computeRunScore(r) ?? 0),
    });
  }
  out.sort((a, b) => b.latestAt - a.latestAt || a.label.localeCompare(b.label));
  return out;
}
