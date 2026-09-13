/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end tests for scripts/backfill-report-run-ids.ts against an
 * in-process mock backend: the script is run as a real subprocess (tsx), so
 * argument parsing, selection, HTTP flow, dry-run vs --apply, idempotency
 * and exit codes are all exercised for real. Synthetic fixtures only.
 */

import { execFile } from 'child_process';
import { createServer, Server } from 'http';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'backfill-report-run-ids.ts');
const TSX = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');

interface MockBackend {
  server: Server;
  url: string;
  patches: Array<{ path: string; body: any }>;
  reports: Record<string, any>;
}

const RUN_ID = 'eval-run-synthetic-1';
const OTHER_RUN_ID = 'eval-run-synthetic-2';

function freshReports(): Record<string, any> {
  return {
    // REST, no runId, echoes a session id -> candidate
    'rep-a': { id: 'rep-a', connectorProtocol: 'rest', runId: null, rawEvents: [{ answer: 'x', session_id: 'sess-a' }] },
    // REST, no runId, echoes run_id -> candidate (different field)
    'rep-b': { id: 'rep-b', connectorProtocol: 'rest', rawEvents: [{ run_id: 'rid-b' }] },
    // REST, already has a runId -> skipped (idempotency)
    'rep-c': { id: 'rep-c', connectorProtocol: 'rest', runId: 'already', rawEvents: [{ session_id: 'nope' }] },
    // REST, no runId, response carries nothing recognizable -> unresolved
    'rep-d': { id: 'rep-d', connectorProtocol: 'rest', runId: null, rawEvents: [{ answer: 'only text' }] },
    // subprocess connector, no runId -> not a candidate, never touched
    'rep-e': { id: 'rep-e', connectorProtocol: 'claude-code', runId: null, rawEvents: [{ session_id: 'cc-sess' }] },
    // belongs to the OTHER run: must not be touched when only RUN_ID is selected
    'rep-f': { id: 'rep-f', connectorProtocol: 'rest', runId: null, rawEvents: [{ session_id: 'sess-f' }] },
  };
}

function startMockBackend(): Promise<MockBackend> {
  const patches: MockBackend['patches'] = [];
  const reports = freshReports();
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && path === `/api/storage/evaluation-runs/${RUN_ID}`) {
      return send(200, { evaluationRun: { id: RUN_ID, agentKey: 'example-rest-agent', createdAt: '2026-03-01T10:00:00Z', results: {
        'tc-1': { reportId: 'rep-a' }, 'tc-2': { reportId: 'rep-b' }, 'tc-3': { reportId: 'rep-c' }, 'tc-4': { reportId: 'rep-d' }, 'tc-5': { reportId: 'rep-e' },
      } } });
    }
    if (req.method === 'GET' && path === `/api/storage/evaluation-runs/${OTHER_RUN_ID}`) {
      return send(200, { evaluationRun: { id: OTHER_RUN_ID, agentKey: 'example-rest-agent', createdAt: '2026-03-02T10:00:00Z', results: { 'tc-1': { reportId: 'rep-f' } } } });
    }
    if (req.method === 'GET' && path === '/api/storage/evaluation-runs') {
      const since = url.searchParams.get('agentKey');
      const runs = [
        { id: OTHER_RUN_ID, agentKey: 'example-rest-agent', createdAt: '2026-03-02T10:00:00Z', results: { 'tc-1': { reportId: 'rep-f' } } },
        { id: RUN_ID, agentKey: 'example-rest-agent', createdAt: '2026-03-01T10:00:00Z', results: { 'tc-1': { reportId: 'rep-a' } } },
        { id: 'eval-run-old', agentKey: 'example-rest-agent', createdAt: '2025-01-01T00:00:00Z', results: { 'tc-1': { reportId: 'rep-b' } } },
      ].filter((r) => !since || r.agentKey === since);
      return send(200, { evaluationRuns: runs, total: runs.length });
    }
    const m = path.match(/^\/api\/storage\/runs\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const doc = reports[id];
      if (!doc) return send(404, { error: 'Run not found' });
      if (req.method === 'GET') return send(200, doc);
      if (req.method === 'PATCH') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          const body = JSON.parse(raw || '{}');
          patches.push({ path, body });
          Object.assign(doc, body);
          send(200, doc);
        });
        return;
      }
    }
    send(404, { error: `unhandled ${req.method} ${path}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, patches, reports });
    });
  });
}

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(TSX, [SCRIPT, ...args], { timeout: 60_000, env: { ...process.env, AH_BACKEND: undefined } }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === 'number' ? (error as any).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('scripts/backfill-report-run-ids.ts', () => {
  let backend: MockBackend;
  beforeEach(async () => { backend = await startMockBackend(); });
  afterEach(async () => { await new Promise<void>((r) => backend.server.close(() => r())); });

  it('dry-run (default) resolves candidates and writes NOTHING', async () => {
    const { code, stdout } = await runScript(['--run', RUN_ID, '--base', backend.url, '--json']);
    expect(code).toBe(0);
    expect(backend.patches).toEqual([]);
    const summary = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(summary).toMatchObject({
      mode: 'dry-run', runs: 1, reportsScanned: 5, alreadyHadRunId: 1, notRest: 1, resolved: 2, unresolved: 1, applied: 0, failed: 0,
      bySource: { 'field:session_id': 1, 'field:run_id': 1 },
    });
    expect(summary.changes).toEqual(expect.arrayContaining([
      { reportId: 'rep-a', evaluationRunId: RUN_ID, runId: 'sess-a', source: 'field:session_id' },
      { reportId: 'rep-b', evaluationRunId: RUN_ID, runId: 'rid-b', source: 'field:run_id' },
    ]));
    expect(summary.unresolvedReports).toEqual([expect.objectContaining({ reportId: 'rep-d' })]);
  }, 90_000);

  it('--apply PATCHes exactly the resolved candidates; a second pass is a no-op (idempotent)', async () => {
    const first = await runScript(['--run', RUN_ID, '--base', backend.url, '--apply', '--json']);
    expect(first.code).toBe(0);
    expect(backend.patches.map((p) => [p.path, p.body]).sort()).toEqual([
      ['/api/storage/runs/rep-a', { runId: 'sess-a' }],
      ['/api/storage/runs/rep-b', { runId: 'rid-b' }],
    ]);
    // untouched: already-had-runId, unresolved, non-REST, other run
    expect(backend.reports['rep-c'].runId).toBe('already');
    expect(backend.reports['rep-d'].runId).toBeNull();
    expect(backend.reports['rep-e'].runId).toBeNull();
    expect(backend.reports['rep-f'].runId).toBeNull();

    backend.patches.length = 0;
    const second = await runScript(['--run', RUN_ID, '--base', backend.url, '--apply', '--json']);
    expect(second.code).toBe(0);
    expect(backend.patches).toEqual([]);
    const summary = JSON.parse(second.stdout.slice(second.stdout.indexOf('{')));
    expect(summary).toMatchObject({ resolved: 0, applied: 0, alreadyHadRunId: 3, unresolved: 1 });
  }, 120_000);

  it('--id-fields narrows the rule (a field not in the list is not used)', async () => {
    const { code, stdout } = await runScript(['--run', RUN_ID, '--base', backend.url, '--id-fields', 'run_id', '--json']);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(summary.changes.map((c: any) => c.reportId)).toEqual(['rep-b']);
    expect(summary.unresolvedReports.map((u: any) => u.reportId).sort()).toEqual(['rep-a', 'rep-d']);
  }, 90_000);

  it('--since selects runs by createdAt (older runs excluded) and --agent-key filters', async () => {
    const { code, stdout } = await runScript(['--since', '2026-01-01T00:00:00Z', '--agent-key', 'example-rest-agent', '--base', backend.url, '--json']);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(summary.runs).toBe(2); // eval-run-old (2025) excluded
    expect(summary.changes.map((c: any) => c.reportId).sort()).toEqual(['rep-a', 'rep-f']);
  }, 90_000);

  it('refuses unknown flags and a missing selector with a non-zero exit', async () => {
    const unknown = await runScript(['--run', RUN_ID, '--base', backend.url, '--yolo']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/Unknown flag: --yolo/);
    const noSel = await runScript(['--base', backend.url]);
    expect(noSel.code).toBe(2);
    expect(noSel.stderr).toMatch(/--run .* or --since/);
    expect(backend.patches).toEqual([]);
  }, 90_000);
});
