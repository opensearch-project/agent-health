/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contract tests for scripts/backfill-improvement-strategies.ts.
 *
 * Runs the real script as a child process (via tsx) against an in-process mock
 * backend so the HTTP contract is what's under test:
 *   - dry-run (default) issues no writes;
 *   - --apply PATCHes exactly the candidate reports, with the top-level array,
 *     the llmJudgeResponse mirror and the llm-judge matcher row filled in;
 *   - a second --apply pass is a no-op (idempotent);
 *   - --run <id> reads only that evaluation run's reports via the batch path;
 *   - the provider gate (default agent-trace-judge) and the in-flight skip
 *     keep recoverable-but-unaffected reports out of the write set;
 *   - --apply is refused when storage isn't healthy or the scan hit the
 *     10k listing window (nothing is written in either case);
 *   - unknown flags are refused (non-zero exit, no requests).
 */

import { execFile } from 'child_process';
import { createServer, Server } from 'http';
import { join } from 'path';

const SCRIPT = join(__dirname, '../../../scripts/backfill-improvement-strategies.ts');
const TSX_CLI = require.resolve('tsx/cli');

const STRATEGIES = [
  { category: 'Payload Economy', issue: 'Too chatty', recommendation: 'Compact records', priority: 'medium' },
];
const RAW = '```json\n' + JSON.stringify({ pass_fail_status: 'passed', improvement_strategies: STRATEGIES }) + '\n```';

function makeReport(id: string, opts: { stored?: any[]; raw?: string; judge?: string; metricsStatus?: string } = {}) {
  return {
    id,
    judgeModelId: opts.judge ?? 'agent-trace-judge',
    metricsStatus: opts.metricsStatus ?? 'ready',
    timestamp: '2026-09-04T17:46:19.614Z',
    trajectory: [{ type: 'assistant', content: 'never fetched by the script' }],
    improvementStrategies: opts.stored ?? [],
    llmJudgeResponse: { modelId: 'agent-trace-judge', rawResponse: opts.raw ?? RAW, improvementStrategies: opts.stored ?? [] },
    matcherResults: [
      { description: 'code', pass: true, method: 'code-assertion' },
      { description: 'judge', pass: true, method: 'llm-judge', improvementStrategies: opts.stored ?? [] },
    ],
  };
}

interface MockState {
  reports: Map<string, any>;
  evalRuns: Map<string, any>;
  requests: Array<{ method: string; url: string; body?: any }>;
  storageHealthy?: boolean;
  /** Pretend the index is huge: every listing page is full, forever. */
  infinitePages?: boolean;
}

function startMock(state: MockState): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const url = new URL(req.url!, 'http://x');
        const body = raw ? JSON.parse(raw) : undefined;
        state.requests.push({ method: req.method!, url: req.url!, body });
        const send = (code: number, payload: any) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const project = (r: any, fields: string | null) => {
          if (!fields) return r;
          const out: any = { id: r.id };
          for (const f of fields.split(',')) if (f in r) out[f] = r[f];
          return out;
        };
        const fields = url.searchParams.get('fields');

        if (req.method === 'GET' && url.pathname === '/api/storage/health') {
          return send(200, { status: state.storageHealthy === false ? 'error' : 'ok', backend: 'file' });
        }
        if (req.method === 'GET' && url.pathname === '/api/storage/runs') {
          const ids = url.searchParams.get('ids');
          if (ids) {
            const runs = ids.split(',').map((id) => state.reports.get(decodeURIComponent(id))).filter(Boolean).map((r) => project(r, fields));
            return send(200, { runs, total: runs.length });
          }
          const size = Number(url.searchParams.get('size') ?? 100);
          const from = Number(url.searchParams.get('from') ?? 0);
          const all = [...state.reports.values()];
          if (state.infinitePages) {
            const page = Array.from({ length: size }, (_, i) => project(makeReport(`report-page-${from + i}`), fields));
            return send(200, { runs: page, total: 999_999 });
          }
          const page = all.slice(from, from + size).map((r) => project(r, fields));
          // Mirror the real route: bundled demo sample runs ride along.
          if (from === 0) page.push({ id: 'demo-report-001', improvementStrategies: [], llmJudgeResponse: { rawResponse: RAW } });
          return send(200, { runs: page, total: all.length });
        }
        const evalMatch = url.pathname.match(/^\/api\/storage\/evaluation-runs\/([^/]+)$/);
        if (req.method === 'GET' && evalMatch) {
          const run = state.evalRuns.get(decodeURIComponent(evalMatch[1]));
          return run ? send(200, { evaluationRun: run }) : send(404, { error: 'not found' });
        }
        const runMatch = url.pathname.match(/^\/api\/storage\/runs\/([^/]+)$/);
        if (req.method === 'PATCH' && runMatch) {
          const id = decodeURIComponent(runMatch[1]);
          const existing = state.reports.get(id);
          if (!existing) return send(404, { error: 'Run not found' });
          const updated = { ...existing, ...body, id };
          state.reports.set(id, updated);
          return send(200, updated);
        }
        send(404, { error: `unhandled ${req.method} ${req.url}` });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as any;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [TSX_CLI, SCRIPT, ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as any).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('scripts/backfill-improvement-strategies.ts', () => {
  let state: MockState;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    state = { reports: new Map(), evalRuns: new Map(), requests: [] };
    state.reports.set('report-uncaptured', makeReport('report-uncaptured'));
    state.reports.set('report-already-stored', makeReport('report-already-stored', { stored: STRATEGIES }));
    state.reports.set('report-raw-empty', makeReport('report-raw-empty', { raw: '{"improvement_strategies": []}' }));
    state.reports.set('report-other-run', makeReport('report-other-run'));
    // Recoverable but NOT affected by the known provider bug — must be gated out by default.
    state.reports.set('report-other-judge', makeReport('report-other-judge', { judge: 'some-bedrock-model' }));
    // Recoverable but still being written by a poller — never race it.
    state.reports.set('report-in-flight', makeReport('report-in-flight', { metricsStatus: 'pending' }));
    state.evalRuns.set('eval-run-A', {
      id: 'eval-run-A',
      results: { 'tc-1': { reportId: 'report-uncaptured' }, 'tc-2': { reportId: 'report-already-stored' } },
    });
    ({ server, base } = await startMock(state));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('dry run (default) counts candidates and issues no writes', async () => {
    const { code, stdout } = await runScript(['--base', base, '--json']);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.mode).toBe('dry-run');
    expect(summary.scanned).toBe(6); // demo sample run excluded
    expect(summary.candidates).toBe(2);
    expect(summary.skippedByJudgeGate).toBe(1);
    expect(summary.skippedInFlight).toBe(1);
    expect(summary.sampleIds.sort()).toEqual(['report-other-run', 'report-uncaptured']);
    expect(summary.byJudge).toEqual({ 'agent-trace-judge': 2 });
    expect(summary.byDay).toEqual({ '2026-09-04': 2 });
    expect(state.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    // Listing is projected — trajectories are never requested.
    for (const r of state.requests.filter((r) => r.url.includes('/api/storage/runs?'))) {
      expect(r.url).toMatch(/fields=id,judgeModelId,metricsStatus,timestamp,improvementStrategies,llmJudgeResponse,matcherResults/);
    }
  }, 90_000);

  it('--judge any lifts the provider gate (in-flight reports are still skipped)', async () => {
    const { summary } = await runScript(['--base', base, '--json', '--judge', 'any']).then((r) => ({ summary: JSON.parse(r.stdout) }));
    expect(summary.candidates).toBe(3);
    expect(summary.skippedByJudgeGate).toBe(0);
    expect(summary.skippedInFlight).toBe(1);
    expect(summary.byJudge).toEqual({ 'agent-trace-judge': 2, 'some-bedrock-model': 1 });
  }, 90_000);

  it('refuses to scan when storage is unhealthy (the listing would silently degrade to sample data)', async () => {
    state.storageHealthy = false;
    const { code, stderr } = await runScript(['--base', base, '--json', '--apply']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/storage is not healthy/);
    expect(state.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
    expect(state.requests.some((r) => r.url.startsWith('/api/storage/runs'))).toBe(false);
  }, 90_000);

  it('refuses --apply over a scan that hit the 10k listing window; dry-run just warns', async () => {
    state.infinitePages = true;
    const dry = await runScript(['--base', base, '--json']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout).windowCapHit).toBe(true);
    expect(JSON.parse(dry.stdout).scanned).toBe(10_000);

    state.requests.length = 0;
    const apply = await runScript(['--base', base, '--json', '--apply']);
    expect(apply.code).not.toBe(0);
    expect(apply.stderr).toMatch(/listing window/);
    expect(state.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  }, 120_000);

  it('--apply patches exactly the candidates with all three surfaces, and a second pass is a no-op', async () => {
    const first = await runScript(['--base', base, '--json', '--apply']);
    expect(first.code).toBe(0);
    const s1 = JSON.parse(first.stdout);
    expect(s1.mode).toBe('apply');
    expect(s1.candidates).toBe(2);
    expect(s1.applied).toBe(2);
    expect(s1.failed).toBe(0);

    const patches = state.requests.filter((r) => r.method === 'PATCH');
    expect(patches.map((p) => decodeURIComponent(p.url.split('/').pop()!)).sort()).toEqual(['report-other-run', 'report-uncaptured']);
    for (const p of patches) {
      expect(Object.keys(p.body).sort()).toEqual(['improvementStrategies', 'llmJudgeResponse', 'matcherResults']);
      expect(p.body.improvementStrategies).toEqual(STRATEGIES);
      expect(p.body.llmJudgeResponse).toEqual({ modelId: 'agent-trace-judge', rawResponse: RAW, improvementStrategies: STRATEGIES });
      expect(p.body.matcherResults).toEqual([
        { description: 'code', pass: true, method: 'code-assertion' },
        { description: 'judge', pass: true, method: 'llm-judge', improvementStrategies: STRATEGIES },
      ]);
    }
    // Untouched reports stay untouched — including the gated and in-flight ones.
    expect(state.reports.get('report-already-stored').improvementStrategies).toEqual(STRATEGIES);
    expect(state.reports.get('report-raw-empty').improvementStrategies).toEqual([]);
    expect(state.reports.get('report-other-judge').improvementStrategies).toEqual([]);
    expect(state.reports.get('report-in-flight').improvementStrategies).toEqual([]);

    state.requests.length = 0;
    const second = await runScript(['--base', base, '--json', '--apply']);
    const s2 = JSON.parse(second.stdout);
    expect(s2.candidates).toBe(0);
    expect(s2.applied).toBe(0);
    expect(state.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  }, 120_000);

  it('--run scopes the scan to that evaluation run via the batch path', async () => {
    const { code, stdout } = await runScript(['--base', base, '--json', '--run', 'eval-run-A']);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.scanned).toBe(2);
    expect(summary.candidates).toBe(1);
    expect(summary.sampleIds).toEqual(['report-uncaptured']);
    expect(state.requests.some((r) => r.url.startsWith('/api/storage/evaluation-runs/eval-run-A'))).toBe(true);
    expect(state.requests.some((r) => r.url.includes('/api/storage/runs?ids='))).toBe(true);
    // No full-listing pages were pulled.
    expect(state.requests.some((r) => /\/api\/storage\/runs\?size=/.test(r.url))).toBe(false);
  }, 90_000);

  it('refuses unknown flags without touching the backend', async () => {
    const { code, stderr } = await runScript(['--base', base, '--orphans']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Unknown flag: --orphans/);
    expect(state.requests).toEqual([]);
  }, 90_000);
});
