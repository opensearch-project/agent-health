#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-off, idempotent backfill: recover `report.runId` for REST-connector
 * reports that were persisted WITHOUT one, from the correlation id the agent
 * echoed in its own response body.
 *
 * Why
 * ---
 * `RESTConnector.execute()` only recognizes `runId` / `id` in a response
 * body. An agent that echoes its per-request id under any other field (a
 * session or conversation id, say) — and whose `afterResponse` hook did not
 * (yet) map it onto `runId` — produces reports with `runId: null`. Every
 * downstream consumer that correlates by run id (Strategy B: the trace
 * poller, the trace judge, the comparison page's Cost / Tokens / LLM Calls)
 * then sees nothing for those reports, even though the agent stamped that
 * very id on all of its spans (`gen_ai.conversation.id`) and the id is
 * sitting in `report.rawEvents[last]`. Re-running the benchmark would be the
 * expensive way to recover; this script is the cheap one.
 *
 * What it does (GENERIC — no agent-, service-, run- or date-specific logic)
 * -----------------------------------------------------------------------
 * For every report reachable from the selected evaluation runs whose
 * `connectorProtocol` is `rest` and whose `runId` is empty:
 *
 *   1. Take the raw agent response: `rawEvents[last]` (the REST connector
 *      stores exactly one raw event — the parsed JSON body).
 *   2. Resolve the echoed id with the SAME rule the live path uses, in order:
 *        a. the agent's own `afterResponse` hook from a loadable
 *           `agent-health.config.*` (`--config-dir <dir>`), replayed against
 *           `{ response, trajectory: [], rawEvents }` — if it returns a
 *           non-empty string `runId`, that is authoritative (this is how the
 *           live path derives runId once the hook is in place); else
 *        b. the first non-empty STRING found under one of the candidate field
 *           names (`--id-fields`, default `runId,run_id,session_id,sessionId,
 *           conversation_id,conversationId,id`), read from the response body
 *           top level.
 *   3. Dry-run (default): print what WOULD change. `--apply`: PATCH
 *      `/api/storage/runs/:id { runId }` through the normal storage route.
 *
 * Idempotent: reports that already have a `runId` are skipped, so re-running
 * is a no-op. Reports whose response carries no recognizable id are reported
 * as `unresolved` and left untouched. Nothing is ever deleted.
 *
 * Usage
 * -----
 *   npx tsx scripts/backfill-report-run-ids.ts --run <evaluationRunId> [--run <id> ...]
 *   npx tsx scripts/backfill-report-run-ids.ts --since 2026-01-01T00:00:00Z [--agent-key <key>]
 *   ... --apply                  # write (default is dry-run)
 *   ... --base http://127.0.0.1:4001
 *   ... --id-fields session_id,conversation_id
 *   ... --config-dir /path/with/agent-health.config.ts   # replay afterResponse hooks
 *   ... --json                   # machine-readable summary on stdout
 */

import { pathToFileURL } from 'url';
import { resolve as resolvePath } from 'path';
import { existsSync } from 'fs';

import {
  DEFAULT_ID_FIELDS,
  isCandidate,
  resolveRunId,
  type AfterResponseHook,
  type ReportLike,
} from '../lib/reportRunIdRecovery.js';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface CliOptions {
  base: string;
  apply: boolean;
  runs: string[];
  since?: string;
  agentKey?: string;
  idFields: string[];
  configDir?: string;
  json: boolean;
  pageSize: number;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    base: process.env.AH_BACKEND || process.env.AGENT_HEALTH_BACKEND || 'http://127.0.0.1:4001',
    apply: false,
    runs: [],
    idFields: [...DEFAULT_ID_FIELDS],
    json: false,
    pageSize: 200,
  };
  const known = new Set(['--apply', '--dry-run', '--json', '--run', '--since', '--agent-key', '--base', '--id-fields', '--config-dir', '--page-size', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) throw new Error(`Unknown flag: ${a} (refusing to run a different backfill than you asked for)`);
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--apply': opts.apply = true; break;
      case '--dry-run': opts.apply = false; break;
      case '--json': opts.json = true; break;
      case '--run': opts.runs.push(next()); break;
      case '--since': opts.since = next(); break;
      case '--agent-key': opts.agentKey = next(); break;
      case '--base': opts.base = next().replace(/\/$/, ''); break;
      case '--id-fields': opts.idFields = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--config-dir': opts.configDir = next(); break;
      case '--page-size': opts.pageSize = Math.max(1, parseInt(next(), 10) || 200); break;
      case '--help': case '-h': printHelp(); process.exit(0);
    }
  }
  if (opts.runs.length === 0 && !opts.since) {
    throw new Error('Select reports with --run <evaluationRunId> (repeatable) or --since <ISO timestamp>');
  }
  if (opts.since && Number.isNaN(Date.parse(opts.since))) throw new Error(`--since is not a parseable timestamp: ${opts.since}`);
  if (opts.idFields.length === 0) throw new Error('--id-fields must name at least one field');
  return opts;
}

function printHelp(): void {
  console.log(`backfill-report-run-ids — recover report.runId for REST-connector reports from the id the agent echoed

  --run <id>            evaluation run to scan (repeatable)
  --since <ISO>         scan all evaluation runs created at/after this time
  --agent-key <key>     with --since: only runs of this agent
  --apply               write changes (default: dry-run)
  --base <url>          backend base URL (default AH_BACKEND or http://127.0.0.1:4001)
  --id-fields a,b,c     response fields to read the id from, in order (default ${DEFAULT_ID_FIELDS.join(',')})
  --config-dir <dir>    load agent-health.config.* from here and replay each agent's afterResponse hook first
  --json                machine-readable summary on stdout`);
}


// ---------------------------------------------------------------------------
// HTTP + orchestration
// ---------------------------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function listEvaluationRuns(opts: CliOptions): Promise<Array<{ id: string; agentKey?: string; createdAt?: string }>> {
  if (opts.runs.length > 0) {
    const out: Array<{ id: string; agentKey?: string; createdAt?: string }> = [];
    for (const id of opts.runs) {
      const d = await getJson<any>(`${opts.base}/api/storage/evaluation-runs/${encodeURIComponent(id)}`);
      const run = d?.evaluationRun ?? d;
      if (!run?.id) throw new Error(`Evaluation run not found: ${id}`);
      out.push(run);
    }
    return out;
  }
  const sinceMs = Date.parse(opts.since!);
  const out: Array<{ id: string; agentKey?: string; createdAt?: string }> = [];
  let from = 0;
  for (;;) {
    const qs = new URLSearchParams({ from: String(from), size: String(opts.pageSize), sort: 'createdAt', order: 'desc' });
    if (opts.agentKey) qs.set('agentKey', opts.agentKey);
    const d = await getJson<any>(`${opts.base}/api/storage/evaluation-runs?${qs}`);
    const page: any[] = d?.evaluationRuns ?? [];
    for (const r of page) {
      const t = Date.parse(r?.createdAt ?? '');
      if (Number.isFinite(t) && t >= sinceMs) out.push(r);
    }
    if (page.length < opts.pageSize) break;
    const oldest = Date.parse(page[page.length - 1]?.createdAt ?? '');
    if (Number.isFinite(oldest) && oldest < sinceMs) break;
    from += page.length;
  }
  return out;
}

function reportIdsOf(run: any): string[] {
  const results = run?.results;
  const ids: string[] = [];
  if (Array.isArray(results)) {
    for (const r of results) if (typeof r?.reportId === 'string') ids.push(r.reportId);
  } else if (results && typeof results === 'object') {
    for (const r of Object.values(results as Record<string, any>)) if (typeof r?.reportId === 'string') ids.push(r.reportId);
  }
  return ids;
}

/** Load `agent-health.config.*` from `dir` and return `agentKey -> afterResponse` hooks. */
async function loadHooks(dir: string): Promise<Map<string, AfterResponseHook>> {
  const hooks = new Map<string, AfterResponseHook>();
  const candidates = ['agent-health.config.ts', 'agent-health.config.mts', 'agent-health.config.js', 'agent-health.config.mjs'];
  const file = candidates.map((f) => resolvePath(dir, f)).find((p) => existsSync(p));
  if (!file) throw new Error(`No agent-health.config.{ts,mts,js,mjs} in ${dir}`);
  const mod = await import(pathToFileURL(file).href);
  const cfg = mod.default ?? mod;
  for (const agent of cfg?.agents ?? []) {
    if (agent?.key && typeof agent?.hooks?.afterResponse === 'function') hooks.set(agent.key, agent.hooks.afterResponse);
  }
  return hooks;
}

export interface Summary {
  mode: 'dry-run' | 'apply';
  runs: number;
  reportsScanned: number;
  alreadyHadRunId: number;
  notRest: number;
  resolved: number;
  unresolved: number;
  applied: number;
  failed: number;
  bySource: Record<string, number>;
  changes: Array<{ reportId: string; evaluationRunId: string; runId: string; source: string }>;
  unresolvedReports: Array<{ reportId: string; evaluationRunId: string; reason: string }>;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const hooks = opts.configDir ? await loadHooks(opts.configDir) : new Map<string, AfterResponseHook>();
  const log = (...a: unknown[]) => { if (!opts.json) console.log(...a); };

  const runs = await listEvaluationRuns(opts);
  log(`${opts.apply ? 'APPLY' : 'DRY-RUN'} against ${opts.base}: ${runs.length} evaluation run(s), id fields [${opts.idFields.join(', ')}]${hooks.size ? `, ${hooks.size} afterResponse hook(s) loaded` : ''}`);

  const summary: Summary = {
    mode: opts.apply ? 'apply' : 'dry-run', runs: runs.length, reportsScanned: 0, alreadyHadRunId: 0, notRest: 0,
    resolved: 0, unresolved: 0, applied: 0, failed: 0, bySource: {}, changes: [], unresolvedReports: [],
  };

  for (const run of runs) {
    const ids = reportIdsOf(run);
    log(`\n${run.id} (${run.agentKey ?? '?'}, ${run.createdAt ?? '?'}): ${ids.length} report(s)`);
    for (const reportId of ids) {
      let report: ReportLike;
      try {
        const d = await getJson<any>(`${opts.base}/api/storage/runs/${encodeURIComponent(reportId)}`);
        report = (d?.report ?? d?.run ?? d) as ReportLike;
      } catch (e) {
        summary.failed++;
        log(`  ${reportId}: FETCH FAILED ${e instanceof Error ? e.message : e}`);
        continue;
      }
      summary.reportsScanned++;
      if (report.connectorProtocol !== 'rest') { summary.notRest++; continue; }
      if (!isCandidate(report)) { summary.alreadyHadRunId++; continue; }

      const agentKey = (report.agentKey ?? report.agentId ?? run.agentKey ?? undefined) as string | undefined;
      const res = await resolveRunId(report, { idFields: opts.idFields, hook: agentKey ? hooks.get(agentKey) : undefined });
      if (!res.runId) {
        summary.unresolved++;
        summary.unresolvedReports.push({ reportId, evaluationRunId: run.id, reason: res.reason ?? 'unknown' });
        log(`  ${reportId}: unresolved — ${res.reason}`);
        continue;
      }
      summary.resolved++;
      summary.bySource[res.source!] = (summary.bySource[res.source!] ?? 0) + 1;
      summary.changes.push({ reportId, evaluationRunId: run.id, runId: res.runId, source: res.source! });
      if (!opts.apply) { log(`  ${reportId}: would set runId=${res.runId} (${res.source})`); continue; }
      try {
        const r = await fetch(`${opts.base}/api/storage/runs/${encodeURIComponent(reportId)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: res.runId }),
        });
        if (!r.ok) throw new Error(`PATCH → ${r.status} ${await r.text().catch(() => '')}`);
        summary.applied++;
        log(`  ${reportId}: set runId=${res.runId} (${res.source})`);
      } catch (e) {
        summary.failed++;
        log(`  ${reportId}: APPLY FAILED ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  log(`\nSummary (${summary.mode}): runs=${summary.runs} scanned=${summary.reportsScanned} alreadyHadRunId=${summary.alreadyHadRunId} notRest=${summary.notRest} resolved=${summary.resolved} unresolved=${summary.unresolved} applied=${summary.applied} failed=${summary.failed} bySource=${JSON.stringify(summary.bySource)}`);
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] ? pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url : false;
  } catch { return false; }
})();

if (isDirectRun) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
