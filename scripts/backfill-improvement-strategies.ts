#!/usr/bin/env -S npx tsx
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-off, idempotent backfill: persist improvement strategies that a judge
 * emitted but that were stored as `[]`.
 *
 * Why
 * ---
 * For a window of time the agentic trace judge returned
 * `improvementStrategies: []` regardless of what the model emitted, while the
 * verbatim model text (with the full `improvement_strategies` array) was still
 * persisted on `llmJudgeResponse.rawResponse`. Every report judged by that
 * provider in the window shows a blank "Improvement Strategies" section in the
 * run report, an empty "How to fix it" on the judge matcher row, and nothing
 * in comparisons / exported reports — even though the data is one field over.
 *
 * What this does
 * --------------
 * For each report it can see, re-parse `llmJudgeResponse.rawResponse` with the
 * same recovery the UI uses (`lib/judgeStrategies.ts`) and, when the stored
 * top-level `improvementStrategies` is empty but the raw text yields ≥1, PATCH
 * the report with:
 *   - `improvementStrategies`                          (top level)
 *   - `llmJudgeResponse.improvementStrategies`          (nested mirror)
 *   - `matcherResults[method=llm-judge].improvementStrategies` (judge row)
 *
 * Idempotent: an applied report has a non-empty top-level array and is skipped
 * on the next run. Reports whose raw text has `"improvement_strategies": []`
 * are never candidates. Nothing else on the report is modified.
 *
 * Guard rails (shared-cluster safety)
 * -----------------------------------
 *   - Provider gate: only reports whose `judgeModelId` matches `--judge`
 *     (default `agent-trace-judge`, the one provider known to have dropped
 *     the array) are candidates. `--judge any` disables the gate; use it only
 *     after reviewing a dry run.
 *   - In-flight reports (`metricsStatus: pending|calculating`) are skipped —
 *     a poller/judge may still be writing them; the PATCH is a whole-document
 *     reindex on the server, so racing a live writer could drop its fields.
 *   - `--apply` refuses to run when the backend's storage is not healthy
 *     (the listing route falls back to bundled sample data on storage errors,
 *     which would otherwise look like a clean zero-candidate pass), and when
 *     a full scan hits OpenSearch's 10 000-doc listing window (`--run` the
 *     remaining runs explicitly instead).
 *
 * Scope
 * -----
 * By default scans every report the backend lists (newest first, projected to
 * the handful of fields needed — no trajectories / raw events are fetched).
 * To target specific runs instead, pass `--run <evaluationRunId>` (repeatable)
 * — only that run's reports are read, via the batch `?ids=` path.
 *
 * Usage
 * -----
 *   npx tsx scripts/backfill-improvement-strategies.ts                 # dry run (default)
 *   npx tsx scripts/backfill-improvement-strategies.ts --apply         # write
 *   npx tsx scripts/backfill-improvement-strategies.ts --run <id> [--run <id>] [--apply]
 *   npx tsx scripts/backfill-improvement-strategies.ts --judge any     # disable the provider gate
 *   npx tsx scripts/backfill-improvement-strategies.ts --base http://localhost:4001
 *   npx tsx scripts/backfill-improvement-strategies.ts --json          # machine-readable summary on stdout
 */

import { buildImprovementStrategiesBackfillPatch } from '../lib/judgeStrategies';
import type { ImprovementStrategy } from '../types';

interface ScannedReport {
  id: string;
  judgeModelId?: string;
  metricsStatus?: string;
  timestamp?: string;
  improvementStrategies?: ImprovementStrategy[];
  llmJudgeResponse?: { rawResponse?: string; improvementStrategies?: ImprovementStrategy[] };
  matcherResults?: Array<{ method?: string; improvementStrategies?: ImprovementStrategy[] }>;
}

interface Summary {
  mode: 'dry-run' | 'apply';
  scanned: number;
  /** Reports whose stored array is empty but raw text has strategies, yet were excluded by a guard rail. */
  skippedByJudgeGate: number;
  skippedInFlight: number;
  candidates: number;
  applied: number;
  failed: number;
  windowCapHit: boolean;
  byJudge: Record<string, number>;
  byDay: Record<string, number>;
  strategiesRecovered: number;
  sampleIds: string[];
  errors: Array<{ id: string; error: string }>;
}

const FIELDS = 'id,judgeModelId,metricsStatus,timestamp,improvementStrategies,llmJudgeResponse,matcherResults';
const DEFAULT_JUDGE_GATE = 'agent-trace-judge';
const IN_FLIGHT = new Set(['pending', 'calculating']);
const PAGE_SIZE = 500;
/** OpenSearch `index.max_result_window` default — a plain from/size listing cannot see past it. */
const RESULT_WINDOW = 10_000;

export function parseArgs(argv: string[]) {
  const known = new Set(['--apply', '--dry-run', '--json', '--base', '--run', '--judge']);
  const opts = { apply: false, json: false, base: '', runs: [] as string[], judge: DEFAULT_JUDGE_GATE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) throw new Error(`Unknown flag: ${a}`);
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--base') opts.base = argv[++i] ?? '';
    else if (a === '--judge') {
      const v = argv[++i];
      if (!v) throw new Error('--judge requires a judgeModelId (or "any")');
      opts.judge = v;
    }
    else if (a === '--run') {
      const v = argv[++i];
      if (!v) throw new Error('--run requires an evaluation run id');
      opts.runs.push(v);
    }
  }
  opts.base = opts.base || process.env.AH_BACKEND || process.env.AGENT_HEALTH_BACKEND || 'http://localhost:4001';
  return opts;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/** Real report docs only — the listing appends bundled demo sample runs. */
const isSample = (id: string) => id.startsWith('demo-');

async function* scanAll(base: string, onCap: () => void): AsyncGenerator<ScannedReport> {
  let from = 0;
  while (true) {
    if (from >= RESULT_WINDOW) { onCap(); return; }
    const size = Math.min(PAGE_SIZE, RESULT_WINDOW - from);
    const data = await getJson(`${base}/api/storage/runs?size=${size}&from=${from}&fields=${FIELDS}`);
    const page: ScannedReport[] = (data.runs || []).filter((r: ScannedReport) => !isSample(r.id));
    for (const r of page) yield r;
    if (page.length < size) return;
    from += page.length;
  }
}

async function* scanRuns(base: string, runIds: string[]): AsyncGenerator<ScannedReport> {
  for (const runId of runIds) {
    const data = await getJson(`${base}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
    const run = data.evaluationRun ?? data;
    const reportIds = Object.values(run.results ?? {})
      .map((r: any) => r?.reportId)
      .filter((id: unknown): id is string => typeof id === 'string');
    for (let i = 0; i < reportIds.length; i += 100) {
      const ids = reportIds.slice(i, i + 100).map(encodeURIComponent).join(',');
      const batch = await getJson(`${base}/api/storage/runs?ids=${ids}&fields=${FIELDS}`);
      for (const r of batch.runs || []) yield r as ScannedReport;
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<Summary> {
  const opts = parseArgs(argv);
  const log = (msg: string) => { if (!opts.json) console.log(msg); };
  const summary: Summary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    scanned: 0, skippedByJudgeGate: 0, skippedInFlight: 0, candidates: 0, applied: 0, failed: 0,
    windowCapHit: false, byJudge: {}, byDay: {}, strategiesRecovered: 0, sampleIds: [], errors: [],
  };

  log(`[backfill-improvement-strategies] ${summary.mode.toUpperCase()} against ${opts.base}` +
      (opts.runs.length ? ` (runs: ${opts.runs.join(', ')})` : ' (all reports)') +
      ` — judge gate: ${opts.judge}`);

  // The listing route degrades to bundled sample data when storage is down,
  // which would read as "nothing to do". Never write against that.
  const health = await getJson(`${opts.base}/api/storage/health`).catch((e) => ({ status: `unreachable (${e.message})` }));
  if (health.status !== 'ok') {
    throw new Error(`storage is not healthy (${health.status}); refusing to scan`);
  }

  const source = opts.runs.length
    ? scanRuns(opts.base, opts.runs)
    : scanAll(opts.base, () => { summary.windowCapHit = true; });

  const pending: Array<{ id: string; patch: ReturnType<typeof buildImprovementStrategiesBackfillPatch> }> = [];
  for await (const report of source) {
    summary.scanned++;
    const patch = buildImprovementStrategiesBackfillPatch(report);
    if (!patch) continue;
    if (opts.judge !== 'any' && report.judgeModelId !== opts.judge) { summary.skippedByJudgeGate++; continue; }
    if (report.metricsStatus && IN_FLIGHT.has(report.metricsStatus)) { summary.skippedInFlight++; continue; }
    summary.candidates++;
    summary.strategiesRecovered += patch.improvementStrategies.length;
    const judge = report.judgeModelId ?? '(none)';
    summary.byJudge[judge] = (summary.byJudge[judge] ?? 0) + 1;
    const day = (report.timestamp ?? '').slice(0, 10) || '(no timestamp)';
    summary.byDay[day] = (summary.byDay[day] ?? 0) + 1;
    if (summary.sampleIds.length < 10) summary.sampleIds.push(report.id);
    pending.push({ id: report.id, patch });
  }

  // Writes happen only after the whole scan succeeded, so a scan that hit the
  // listing window (incomplete) never half-applies.
  if (opts.apply && summary.windowCapHit) {
    throw new Error(`scan hit the ${RESULT_WINDOW}-doc listing window — an --apply over an incomplete scan is refused; ` +
      `target the remaining runs with --run <evaluationRunId>`);
  }
  if (opts.apply) {
    for (const { id, patch } of pending) {
      try {
        const res = await fetch(`${opts.base}/api/storage/runs/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`PATCH → ${res.status}`);
        summary.applied++;
      } catch (err: any) {
        summary.failed++;
        summary.errors.push({ id, error: err?.message ?? String(err) });
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    log(`scanned ${summary.scanned} report(s); ${summary.candidates} candidate(s) with recoverable strategies` +
        ` (${summary.strategiesRecovered} strategies total)`);
    if (summary.skippedByJudgeGate) log(`  skipped ${summary.skippedByJudgeGate} recoverable report(s) judged by another provider (gate: ${opts.judge}; use --judge any to include)`);
    if (summary.skippedInFlight) log(`  skipped ${summary.skippedInFlight} in-flight report(s) (metricsStatus pending/calculating)`);
    for (const [k, v] of Object.entries(summary.byJudge).sort((a, b) => b[1] - a[1])) log(`  judge ${k}: ${v}`);
    for (const [k, v] of Object.entries(summary.byDay).sort()) log(`  day ${k}: ${v}`);
    if (summary.sampleIds.length) log(`  sample ids: ${summary.sampleIds.join(', ')}`);
    if (summary.windowCapHit) {
      log(`  WARNING: hit the ${RESULT_WINDOW}-doc listing window; older reports were not scanned.` +
          ` Target them with --run <evaluationRunId> (an --apply over a capped scan is refused).`);
    }
    if (opts.apply) {
      log(`applied ${summary.applied}, failed ${summary.failed}`);
      for (const e of summary.errors) log(`  ${e.id}: ${e.error}`);
    } else if (summary.candidates > 0) {
      log(`dry run — nothing written. Re-run with --apply to persist.`);
    }
  }
  return summary;
}

// Run only when executed directly (not when imported by tests).
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? '';
  return /backfill-improvement-strategies\.(ts|js|mjs)$/.test(entry);
})();
if (invokedDirectly) {
  main().then((s) => { process.exitCode = s.failed > 0 ? 1 : 0; }).catch((err) => {
    console.error(`[backfill-improvement-strategies] ${err?.message ?? err}`);
    process.exit(1);
  });
}
