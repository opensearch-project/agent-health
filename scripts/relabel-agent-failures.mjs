/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Re-label historical reports whose AGENT request failed but which were
 * recorded as JUDGE failures.
 *
 * Background: before agent-error surfacing landed, a REST agent whose HTTP
 * call never returned (undici's silent 300 s `headersTimeout` → the opaque
 * `TypeError: fetch failed`) produced a report with `trajectory: []`,
 * `rawEvents: []` and NO recorded cause — and the runner then judged the
 * empty case anyway, so the report ended up tagged
 * `traceError: "Judge evaluation failed (kind=judge_failed): … Failed to parse
 * Pi judge response …"`. The UI therefore said "evaluator could not run" when
 * the truth was "the agent produced no output".
 *
 * This script finds exactly that shape and rewrites the stage:
 *
 *   MATCH  = trajectory is empty AND rawEvents is empty AND
 *            traceError contains 'kind=judge_failed' AND
 *            failureStage is not already 'agent'
 *   PATCH  = { failureStage: 'agent',
 *              error: 'agent request produced no output (likely timeout; cause not recorded at the time)',
 *              agentError: { kind: 'unknown', message: <same>, endpoint? },
 *              traceError: 'Agent request failed (kind=agent_failed): <same>',
 *              llmJudgeReasoning: <agent-stage prose>,
 *              relabeledFrom: <previous traceError>,
 *              relabeledAt: <ISO> }
 *
 * Idempotent: an already-relabeled report (failureStage 'agent') never matches
 * again. DRY-RUN BY DEFAULT — `--apply` is required to write. Scoped to ONE
 * evaluation run (`--run <id>`) or explicit report ids (`--report <id>`,
 * repeatable) — never the whole index. Only PATCHes the fields above; nothing
 * is deleted.
 *
 * Usage:
 *   node scripts/relabel-agent-failures.mjs --run eval-run-…            # dry run
 *   node scripts/relabel-agent-failures.mjs --run eval-run-… --apply
 *   node scripts/relabel-agent-failures.mjs --report report-a --report report-b
 *   node scripts/relabel-agent-failures.mjs --run … --url http://localhost:4001 --json
 */

const KNOWN = new Set(['--run', '--report', '--apply', '--url', '--json', '--help', '-h']);

function usage(code = 0) {
  console.log(`Usage: node scripts/relabel-agent-failures.mjs (--run <evalRunId> | --report <reportId> [--report …]) [--apply] [--url <base>] [--json]`);
  process.exit(code);
}

/** Parse CLI args (only invoked when run directly — importing this module for tests is side-effect free). */
export function parseArgs(argv) {
  const opts = { runId: undefined, reportIds: [], apply: false, url: process.env.AH_BASE_URL || `http://localhost:${process.env.AH_PORT || 4001}`, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN.has(a)) { console.error(`Unknown flag: ${a}`); usage(2); }
    if (a === '--help' || a === '-h') usage(0);
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--run') opts.runId = argv[++i];
    else if (a === '--report') opts.reportIds.push(argv[++i]);
    else if (a === '--url') opts.url = argv[++i];
  }
  if (!opts.runId && opts.reportIds.length === 0) { console.error('Scope required: --run <id> or --report <id>'); usage(2); }
  return opts;
}

const RELABEL_CAUSE = 'agent request produced no output (likely timeout; cause not recorded at the time)';

/** Pure: decide whether a report is a mislabeled agent failure. Exported for tests via `--selftest`. */
export function isMislabeledAgentFailure(report) {
  if (!report) return false;
  if (report.failureStage === 'agent') return false;
  const traj = Array.isArray(report.trajectory) ? report.trajectory.length : 0;
  const raw = Array.isArray(report.rawEvents) ? report.rawEvents.length : 0;
  if (traj !== 0 || raw !== 0) return false;
  return typeof report.traceError === 'string' && report.traceError.includes('kind=judge_failed');
}

/** Pure: build the PATCH body for a matched report. */
export function buildRelabelPatch(report, now = new Date().toISOString()) {
  const endpoint = report.agentEndpoint || undefined;
  return {
    failureStage: 'agent',
    error: RELABEL_CAUSE,
    agentError: { kind: 'unknown', message: RELABEL_CAUSE, ...(endpoint ? { endpoint } : {}) },
    traceError: `Agent request failed (kind=agent_failed): ${RELABEL_CAUSE}`,
    llmJudgeReasoning:
      `**Agent request failed — not judged.**\n\n` +
      `The agent produced no output (request timed out, connection failed, or the agent returned an error) ` +
      `so there is no trajectory to judge. This run is excluded from pass-rate aggregation; ` +
      `re-run the case to retry the agent.\n\n` +
      `**Cause:** ${RELABEL_CAUSE}\n\n` +
      `_Re-labeled from a judge failure on ${now}; the original judge error is kept in \`relabeledFrom\`._`,
    relabeledFrom: report.traceError,
    relabeledAt: now,
  };
}

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${url} → ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function collectReports(opts) {
  const ids = new Set(opts.reportIds);
  if (opts.runId) {
    const run = await getJson(`${opts.url}/api/storage/evaluation-runs/${encodeURIComponent(opts.runId)}`);
    const doc = run.evaluationRun || run.run || run;
    for (const r of Object.values(doc.results || {})) if (r?.reportId) ids.add(r.reportId);
  }
  const reports = [];
  for (const id of ids) {
    try {
      const body = await getJson(`${opts.url}/api/storage/runs/${encodeURIComponent(id)}`);
      reports.push(body.run || body.report || body);
    } catch (e) {
      reports.push({ id, __fetchError: String(e.message || e) });
    }
  }
  return reports;
}

async function main(opts) {
  const reports = await collectReports(opts);
  const matched = [];
  const skipped = [];
  const fetchErrors = [];
  for (const r of reports) {
    if (r.__fetchError) { fetchErrors.push({ id: r.id, error: r.__fetchError }); continue; }
    if (isMislabeledAgentFailure(r)) matched.push(r); else skipped.push(r);
  }

  const results = [];
  for (const r of matched) {
    const patch = buildRelabelPatch(r);
    if (opts.apply) {
      await getJson(`${opts.url}/api/storage/runs/${encodeURIComponent(r.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
      });
    }
    results.push({ id: r.id, testCaseId: r.testCaseId, previousTraceError: r.traceError, patch: opts.apply ? 'applied' : 'dry-run' });
  }

  const summary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    scope: opts.runId ? { runId: opts.runId } : { reportIds: opts.reportIds },
    scanned: reports.length,
    matched: matched.length,
    skipped: skipped.length,
    fetchErrors: fetchErrors.length,
    relabeled: opts.apply ? matched.length : 0,
    results,
    ...(fetchErrors.length ? { fetchErrorDetails: fetchErrors } : {}),
  };

  if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`[relabel-agent-failures] mode=${summary.mode} scanned=${summary.scanned} matched=${summary.matched} skipped=${summary.skipped} fetchErrors=${summary.fetchErrors} relabeled=${summary.relabeled}`);
  for (const r of results) {
    console.log(`  ${r.patch.padEnd(8)} ${r.id}  (tc=${r.testCaseId})\n           was: ${String(r.previousTraceError).slice(0, 140)}`);
  }
  for (const e of fetchErrors) console.log(`  fetch-err ${e.id}: ${e.error}`);
  if (!opts.apply && matched.length > 0) console.log(`Dry run — re-run with --apply to write ${matched.length} patch(es).`);
}

// Allow `import` for unit tests without executing the CLI.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(parseArgs(process.argv.slice(2))).catch((e) => { console.error(`[relabel-agent-failures] ${e.message || e}`); process.exit(1); });
}
