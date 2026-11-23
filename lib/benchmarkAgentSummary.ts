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
import { computeRunStats, passRateOverJudged } from '@/lib/runStats';

// ─── Agent identity ──────────────────────────────────────────────────────────

export interface AgentIdentityRun {
  agentKey?: string;
  agentEndpoint?: string;
}

/**
 * Stable identity of the agent behind a run: `encodeURIComponent(agentKey)`
 * when the run used the configured endpoint, `encodeURIComponent(agentKey)@
 * endpoint` when it overrode it. The key is URI-encoded so a literal `@` in a
 * key can never make two different (key, endpoint) pairs collide — the first
 * `@` always delimits. Opaque: compare it, don't parse it (ordinary keys such
 * as `demo` or `claude-code` encode to themselves). Two runs of the same key
 * against different endpoints are different agents for latest/trend/series
 * purposes.
 */
export function agentIdentityKey(run: AgentIdentityRun): string {
  const key = encodeURIComponent(run.agentKey || '');
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
 * told apart. When two endpoints of one key share a host (same host, different
 * scheme or path) the full endpoint is used instead of the host.
 */
export function agentIdentityLabels(
  runs: AgentIdentityRun[],
  nameFor: (agentKey: string) => string,
): Map<string, string> {
  // agentKey → distinct identities (one per endpoint variant) seen in runs.
  const byKey = new Map<string, Map<string, AgentIdentityRun>>();
  for (const run of runs) {
    const key = run.agentKey || '';
    if (!byKey.has(key)) byKey.set(key, new Map());
    const ids = byKey.get(key)!;
    const id = agentIdentityKey(run);
    if (!ids.has(id)) ids.set(id, run);
  }
  const labels = new Map<string, string>();
  for (const [key, ids] of byKey) {
    const name = nameFor(key);
    if (ids.size < 2) {
      for (const id of ids.keys()) labels.set(id, name);
      continue;
    }
    const suffix = (r: AgentIdentityRun, full: boolean) =>
      r.agentEndpoint ? (full ? r.agentEndpoint : endpointHost(r.agentEndpoint)) : 'default endpoint';
    const hosts = [...ids.values()].map(r => suffix(r, false));
    const hostsCollide = new Set(hosts).size < hosts.length;
    for (const [id, r] of ids) labels.set(id, `${name} (${suffix(r, hostsCollide)})`);
  }
  return labels;
}

// ─── Scores / trend ──────────────────────────────────────────────────────────

/**
 * Pass rate (0–100) over the JUDGED cases of a run, or null when nothing has
 * been judged. Counts come from {@link computeRunStats} — the app-wide single
 * source of truth (results first, denormalized `run.stats` as fallback) — so
 * the number can't disagree with the pass/fail counts shown next to it.
 */
export function computeRunScore(run: BenchmarkRun): number | null {
  return passRateOverJudged(computeRunStats(run));
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
  /** Scores of this agent's last 10 runs, oldest first; runs with nothing judged are omitted. */
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
    const latestStats = computeRunStats(latestRun);
    const latestScore = passRateOverJudged(latestStats);
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
      passed: latestStats.passed,
      failed: latestStats.failed,
      total: latestStats.total,
      trend: trendBetween(latestScore, prevScore),
      passRateHistory: sorted.slice(0, 10).reverse().map(computeRunScore).filter((x): x is number => x !== null),
    });
  }
  out.sort((a, b) => b.latestAt - a.latestAt || a.label.localeCompare(b.label));
  return out;
}
