#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Telemetry smoke gate — proves, with ONE ad-hoc evaluation, that a running
 * Agent Health server + one agent produce reports that CORRELATE with their
 * traces. Meant to run after every server restart / agent relaunch, before
 * any real benchmark: the failure it catches (reports silently persisted with
 * no traceId / runId, so the trace judge and the comparison page's Cost /
 * Tokens / LLM Calls come up empty for a whole run) is invisible until
 * someone opens the comparison page hours later.
 *
 * Checks (each PASS / FAIL / SKIP; exit code 1 if any check FAILs):
 *   1. report.traceId is set        — the eval `test_case` span is on
 *                                     (telemetry block present + provider up).
 *   2. report.runId is set for REST — the agent echoed an id agent-health
 *      connectors                     recognized (natively, or via the agent's
 *                                     afterResponse hook).
 *   3. spans found via /api/traces  — Strategy A (traceId) OR B (runId): the
 *                                     observability backend actually received
 *                                     spans for this run.
 *   4. /api/metrics/batch hasSpans  — the metrics reader correlates the same
 *                                     run (SKIP when no observability cluster is
 *                                     configured: the metrics API needs one).
 *
 * Generic: the agent, model, evaluator and prompt are all arguments; nothing
 * here knows any particular agent.
 *
 * Usage
 * -----
 *   npx tsx scripts/smoke-telemetry.ts --base http://127.0.0.1:4001 --agent-key <key>
 *       [--model-id <judge model key>]        default: first model from /api/models
 *       [--prompt "<one-line prompt>"]        default: a trivial question
 *       [--timeout-ms 300000]                 whole-run budget (default 5 min)
 *       [--spans-wait-ms 60000]               how long to poll for spans after the report lands
 *       [--allow-no-run-id]                   downgrade check 2 to a warning (agents that can't echo an id)
 *       [--keep]                              do not delete the report it created
 *       [--json]                              machine-readable result on stdout
 */

import { pathToFileURL } from 'url';
import { resolve as resolvePath } from 'path';

export interface SmokeOptions {
  base: string;
  agentKey: string;
  modelId?: string;
  prompt: string;
  timeoutMs: number;
  spansWaitMs: number;
  allowNoRunId: boolean;
  keep: boolean;
  json: boolean;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';
export interface Check { name: string; status: CheckStatus; detail: string }
export interface SmokeResult {
  ok: boolean;
  reportId?: string;
  traceId?: string;
  runId?: string;
  connectorProtocol?: string;
  spansFound: number;
  checks: Check[];
}

export function parseArgs(argv: string[]): SmokeOptions {
  const o: SmokeOptions = {
    base: process.env.AH_BACKEND || process.env.AGENT_HEALTH_BACKEND || 'http://127.0.0.1:4001',
    agentKey: '',
    prompt: 'Reply with the single word OK.',
    timeoutMs: 300_000,
    spansWaitMs: 60_000,
    allowNoRunId: false,
    keep: false,
    json: false,
  };
  const known = new Set(['--base', '--agent-key', '--model-id', '--prompt', '--timeout-ms', '--spans-wait-ms', '--allow-no-run-id', '--keep', '--json', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) throw new Error(`Unknown flag: ${a}`);
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} requires a value`); return v; };
    switch (a) {
      case '--base': o.base = next().replace(/\/$/, ''); break;
      case '--agent-key': o.agentKey = next(); break;
      case '--model-id': o.modelId = next(); break;
      case '--prompt': o.prompt = next(); break;
      case '--timeout-ms': o.timeoutMs = parseInt(next(), 10); break;
      case '--spans-wait-ms': o.spansWaitMs = parseInt(next(), 10); break;
      case '--allow-no-run-id': o.allowNoRunId = true; break;
      case '--keep': o.keep = true; break;
      case '--json': o.json = true; break;
      case '--help': case '-h':
        console.log('smoke-telemetry --base <url> --agent-key <key> [--model-id k] [--prompt p] [--timeout-ms n] [--spans-wait-ms n] [--allow-no-run-id] [--keep] [--json]');
        process.exit(0);
    }
  }
  if (!o.agentKey) throw new Error('--agent-key is required');
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  if (!Number.isFinite(o.spansWaitMs) || o.spansWaitMs < 0) throw new Error('--spans-wait-ms must be a non-negative integer');
  return o;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T | undefined }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed: T | undefined;
  try { parsed = JSON.parse(text) as T; } catch { parsed = undefined; }
  return { status: r.status, body: parsed };
}

/**
 * Run one ad-hoc case via POST /api/evaluate (SSE) and return the report id
 * from the `completed` event (or `started` if the stream dies early).
 */
async function runAdHocCase(o: SmokeOptions, modelId: string): Promise<{ reportId?: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
  try {
    const res = await fetch(`${o.base}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        agentKey: o.agentKey,
        modelId,
        runName: `smoke-telemetry ${new Date().toISOString()}`,
        testCase: {
          id: `smoke-telemetry-${Date.now()}`,
          name: 'smoke-telemetry',
          description: 'Telemetry smoke gate — ad-hoc case, safe to delete',
          category: 'Smoke',
          difficulty: 'Easy',
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), initialPrompt: o.prompt, context: [], expectedOutcomes: ['Any reply at all.'] }],
          initialPrompt: o.prompt,
          context: [],
          expectedOutcomes: ['Any reply at all.'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    });
    if (!res.ok || !res.body) return { error: `POST /api/evaluate → ${res.status} ${await res.text().catch(() => '')}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let startedReportId: string | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev: any; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'started' && ev.reportId) startedReportId = ev.reportId;
        if (ev.type === 'completed') return { reportId: ev.reportId ?? startedReportId };
        if (ev.type === 'error') return { reportId: startedReportId, error: ev.error ?? 'evaluation error' };
      }
    }
    return { reportId: startedReportId, error: startedReportId ? undefined : 'SSE stream ended without a completed event' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSmoke(o: SmokeOptions): Promise<SmokeResult> {
  const checks: Check[] = [];
  const result: SmokeResult = { ok: false, spansFound: 0, checks };
  const log = (...a: unknown[]) => { if (!o.json) console.log(...a); };

  // Preflight: server + agent + model.
  await getJson(`${o.base}/health`);
  const agents = await getJson<{ agents: Array<{ key: string; connectorType?: string }> }>(`${o.base}/api/agents`);
  const agent = agents.agents.find((a) => a.key === o.agentKey);
  if (!agent) throw new Error(`Agent "${o.agentKey}" not found on ${o.base} (have: ${agents.agents.map((a) => a.key).join(', ')})`);
  let modelId = o.modelId;
  if (!modelId) {
    const models = await getJson<{ models: Array<{ key: string }> }>(`${o.base}/api/models`);
    modelId = models.models[0]?.key;
    if (!modelId) throw new Error('No models configured and --model-id not given');
  }
  log(`smoke-telemetry: ${o.base} agent=${o.agentKey} (${agent.connectorType ?? '?'}) judge=${modelId}`);

  // 0. Run one case.
  const t0 = Date.now();
  const run = await runAdHocCase(o, modelId);
  if (!run.reportId) {
    checks.push({ name: 'evaluation ran', status: 'FAIL', detail: run.error ?? 'no report id' });
    return result;
  }
  result.reportId = run.reportId;
  checks.push({ name: 'evaluation ran', status: run.error ? 'WARN' : 'PASS', detail: `${run.reportId} in ${Date.now() - t0}ms${run.error ? ` (stream error: ${run.error})` : ''}` });

  // Reports are updated in place at the end of the run; give storage a beat.
  let report: any = {};
  for (let i = 0; i < 10; i++) {
    report = await getJson<any>(`${o.base}/api/storage/runs/${encodeURIComponent(run.reportId)}`);
    if (report?.status && report.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  result.traceId = report.traceId ?? undefined;
  result.runId = report.runId ?? undefined;
  result.connectorProtocol = report.connectorProtocol ?? agent.connectorType;

  // 1. traceId
  checks.push(result.traceId
    ? { name: 'report.traceId set (eval span on)', status: 'PASS', detail: result.traceId }
    : { name: 'report.traceId set (eval span on)', status: 'FAIL', detail: 'missing — is the telemetry block present in the config and did the server log "[Telemetry] Evaluation telemetry enabled"?' });

  // 2. runId for REST
  if (result.connectorProtocol === 'rest') {
    checks.push(result.runId
      ? { name: 'report.runId set (REST agent echoed an id)', status: 'PASS', detail: result.runId }
      : { name: 'report.runId set (REST agent echoed an id)', status: o.allowNoRunId ? 'WARN' : 'FAIL', detail: 'missing — the response carried no runId/id and no afterResponse hook mapped the echoed field onto runId' });
  } else {
    checks.push({ name: 'report.runId set (REST agent echoed an id)', status: 'SKIP', detail: `connector is ${result.connectorProtocol}; runId=${result.runId ?? 'none'}` });
  }

  // 3. spans via /api/traces by A OR B
  const ids = { traceId: result.traceId, runIds: result.runId ? [result.runId] : undefined };
  if (!ids.traceId && !ids.runIds) {
    checks.push({ name: 'spans found via /api/traces (A or B)', status: 'FAIL', detail: 'nothing to correlate on (no traceId, no runId)' });
  } else {
    const deadline = Date.now() + o.spansWaitMs;
    let spans = 0; let lastErr = '';
    for (;;) {
      const r = await postJson<any>(`${o.base}/api/traces`, { ...ids, size: 200 });
      if (r.status === 200 && r.body) {
        spans = Array.isArray(r.body.spans) ? r.body.spans.length : 0;
        lastErr = r.body.warning ?? '';
        if (spans > 0) break;
      } else {
        lastErr = `HTTP ${r.status}`;
      }
      if (Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    result.spansFound = spans;
    checks.push(spans > 0
      ? { name: 'spans found via /api/traces (A or B)', status: 'PASS', detail: `${spans} span(s)` }
      : { name: 'spans found via /api/traces (A or B)', status: 'FAIL', detail: `0 spans after ${o.spansWaitMs}ms${lastErr ? ` (${lastErr})` : ''}` });
  }

  // 4. metrics batch hasSpans
  if (result.runId || result.traceId) {
    const key = result.runId ?? result.traceId!;
    const r = await postJson<any>(`${o.base}/api/metrics/batch`, { runIds: [key], ...(result.traceId ? { traceIds: { [key]: result.traceId } } : {}) });
    if (r.status === 503 || (r.body?.metrics?.[0]?.error && /not configured/i.test(r.body.metrics[0].error))) {
      checks.push({ name: '/api/metrics/batch hasSpans', status: 'SKIP', detail: 'no observability cluster configured (metrics need one)' });
    } else if (r.status !== 200 || !r.body?.metrics?.[0]) {
      checks.push({ name: '/api/metrics/batch hasSpans', status: 'FAIL', detail: `HTTP ${r.status}` });
    } else {
      const m = r.body.metrics[0];
      checks.push(m.hasSpans
        ? { name: '/api/metrics/batch hasSpans', status: 'PASS', detail: `tokens=${m.totalTokens} llmCalls=${m.llmCalls} cost=$${Number(m.costUsd ?? 0).toFixed(4)}` }
        : { name: '/api/metrics/batch hasSpans', status: 'FAIL', detail: m.error ?? 'hasSpans=false' });
    }
  } else {
    checks.push({ name: '/api/metrics/batch hasSpans', status: 'FAIL', detail: 'nothing to correlate on' });
  }

  // Cleanup the ad-hoc report (its id is the only thing we created).
  if (!o.keep) {
    await fetch(`${o.base}/api/storage/runs/${encodeURIComponent(run.reportId)}`, { method: 'DELETE' }).catch(() => undefined);
  }

  result.ok = checks.every((c) => c.status !== 'FAIL');
  return result;
}

function printResult(r: SmokeResult): void {
  for (const c of r.checks) console.log(`  [${c.status}] ${c.name} — ${c.detail}`);
  console.log(r.ok ? '\nTELEMETRY SMOKE: PASS' : '\nTELEMETRY SMOKE: FAIL');
}

const isDirectRun = (() => {
  try { return process.argv[1] ? pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url : false; } catch { return false; }
})();

if (isDirectRun) {
  (async () => {
    const o = parseArgs(process.argv.slice(2));
    const r = await runSmoke(o);
    if (o.json) console.log(JSON.stringify(r, null, 2)); else printResult(r);
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
