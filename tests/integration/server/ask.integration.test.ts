/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration — the Agent Health assistant (`/api/ask`) through a REAL server
 * process that this suite boots itself (file storage, temp cwd, port
 * AH_ASK_TEST_PORT or 5382), so it can RESTART the server between a question
 * and its follow-up and prove the thread resumes from the pi session file.
 *
 *   - validation errors are plain 400 JSON (no stream)
 *   - prepare → ask: the answer is grounded in a report created through the
 *     storage API (a sentinel only that report contains)
 *   - the pi session file exists in the dedicated dir with our custom entries
 *   - server restart → follow-up with the same sessionId recalls the earlier
 *     answer (history came from the JSONL, the snapshot is NOT re-sent)
 *   - GET /api/ask/sessions(/:id) list the thread
 *
 * Needs `server/dist` built and a credentialed pi model (Bedrock profile) —
 * skipped with a loud warning otherwise, never silently green.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = process.cwd();
const PORT = process.env.AH_ASK_TEST_PORT || '5382';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DIST = resolve(REPO, 'server/dist/index.js');

let cwd: string;
let child: ChildProcess | null = null;

async function waitHealthy(ms = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startServer(): Promise<boolean> {
  // Refuse to run against a stranger: the port must be free before we boot.
  const taken = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
  if (taken) throw new Error(`${BASE_URL} is already serving something — pick another AH_ASK_TEST_PORT`);
  child = spawn(process.execPath, ['--import', 'tsx', DIST], {
    cwd,
    env: {
      ...process.env,
      PORT, AH_PORT: PORT, AGENT_HEALTH_PORT: PORT,
      AGENT_HEALTH_STORAGE: 'file',
      BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
      TRACE_POLL_MAX_ATTEMPTS: '1', NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => { log += d.toString(); });
  child.stderr?.on('data', (d) => { log += d.toString(); });
  const ok = await waitHealthy();
  if (!ok) console.warn('ask server did not become healthy:\n', log.slice(-2000));
  return ok;
}

async function stopServer(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>((done) => {
    c.once('exit', () => done());
    c.kill('SIGTERM'); // ONLY our own child, by handle.
    setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL'); }, 5000);
  });
}

interface Sse { meta?: any; deltas: string[]; tools: any[]; done?: any; error?: string }
async function postAsk(body: unknown): Promise<{ status: number; json?: any; sse?: Sse }> {
  const res = await fetch(`${BASE_URL}/api/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000),
  });
  if (!res.headers.get('content-type')?.includes('text/event-stream')) return { status: res.status, json: await res.json().catch(() => undefined) };
  const sse: Sse = { deltas: [], tools: [] };
  for (const chunk of (await res.text()).split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const ev = JSON.parse(line.slice(6));
    if (ev.type === 'meta') sse.meta = ev;
    else if (ev.type === 'delta') sse.deltas.push(ev.content);
    else if (ev.type === 'tool') sse.tools.push(ev);
    else if (ev.type === 'done') sse.done = ev;
    else if (ev.type === 'error') sse.error = ev.error;
  }
  return { status: res.status, sse };
}

const canRun = existsSync(DIST);

describe('Agent Health assistant — /api/ask against a self-booted server', () => {
  beforeAll(async () => {
    if (!canRun) { console.warn('server/dist not built — skipping ask integration'); return; }
    cwd = mkdtempSync(join(tmpdir(), 'ask-proto-int-'));
    symlinkSync(resolve(REPO, 'node_modules'), join(cwd, 'node_modules'));
    writeFileSync(join(cwd, 'package.json'), '{"name":"ask-int","private":true,"type":"module"}');
    expect(await startServer()).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await stopServer();
    if (cwd) rmSync(cwd, { recursive: true, force: true }); // the temp cwd holds every doc this suite created
  }, 30_000);

  it('400s on malformed bodies without opening a stream', async () => {
    if (!canRun) return;
    expect((await postAsk({ pageContext: { route: '/x' } })).json?.error).toMatch(/question is required/);
    expect((await postAsk({ question: 'q', pageContext: {} })).status).toBe(400);
    expect((await postAsk({ question: 'q', pageContext: { route: '/x' }, selections: [{ nope: 1 }] })).status).toBe(400);
    const prep = await fetch(`${BASE_URL}/api/ask/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(prep.status).toBe(400);
  });

  it('prepare → grounded answer → pi session file → restart → follow-up resumes the same pi session', async () => {
    if (!canRun) return;
    const sentinel = `sentinel-${Date.now().toString(36)}`;
    const tc = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `ask-int-${sentinel}`, description: 'ask integration', labels: ['category:RCA', 'difficulty:Easy'], category: 'RCA', difficulty: 'Easy', initialPrompt: 'Why is checkout slow?', context: [], expectedOutcomes: ['Names the slow dependency'] }),
    }).then((r) => r.json());
    const report = await fetch(`${BASE_URL}/api/storage/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCaseId: tc.id, testCaseVersion: 1, agentKey: 'demo', agentName: 'Demo agent', modelId: 'demo', status: 'completed',
        passFailStatus: 'failed', metrics: { accuracy: 20 },
        llmJudgeReasoning: `The agent blamed the database, but the slow dependency was the ${sentinel} payment gateway (p99 4.2s). Outcome not achieved.`,
        trajectory: [
          { id: 's1', timestamp: 1, type: 'assistant', content: 'Checking the database first.' },
          { id: 's2', timestamp: 2, type: 'action', toolName: 'query_metrics', content: '{"service":"db"}' },
          { id: 's3', timestamp: 3, type: 'tool_result', toolName: 'query_metrics', content: 'db p99 = 40ms' },
          { id: 's4', timestamp: 4, type: 'response', content: 'The database is slow.' },
        ],
        timestamp: new Date().toISOString(),
      }),
    }).then((r) => r.json());
    const reportId: string = report.id ?? report.run?.id;
    const pageContext = { route: `/runs/${reportId}`, title: 'Run details' };
    const selections = [{ text: 'Outcome not achieved.' }];

    // prepare (what the UI does when the chip is clicked)
    const prepRes = await fetch(`${BASE_URL}/api/ask/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageContext, selections }) });
    if (!prepRes.ok) {
      const e = String((await prepRes.json().catch(() => ({}))).error ?? prepRes.status);
      // The CI integration job has no LLM credentials (and may lack the optional pi SDK):
      // the assistant is unavailable there by design — skip loudly, never silently green.
      if (/credential|model|pi-coding-agent|optional dependency|registry|ExpiredToken|AccessDenied/i.test(e)) {
        console.warn('SKIP (assistant backend unavailable in this environment):', e);
        return;
      }
      throw new Error(`prepare failed unexpectedly: ${prepRes.status} ${e}`);
    }
    const prep = await prepRes.json();
    expect(prep.sessionId).toMatch(/^ask-/);
    expect(prep.loaded).toEqual(expect.arrayContaining([`report ${reportId}`, `test case ${tc.id}`]));

    const first = await postAsk({ question: 'In one or two sentences: which dependency does the judge say was actually slow, and did the agent pass?', selections, pageContext, sessionId: prep.sessionId });
    expect(first.status).toBe(200);
    if (first.sse!.error && /no credentialed model|credential|ExpiredToken|Throttling/i.test(first.sse!.error)) { console.warn('SKIP:', first.sse!.error); return; }
    expect(first.sse!.error).toBeUndefined();
    expect(first.sse!.meta).toMatchObject({ sessionId: prep.sessionId, prepared: true, agent: { key: 'agent-health-assistant' } });
    const answer1: string = first.sse!.done.answer;
    expect(answer1).toContain(sentinel);
    expect(answer1).toMatch(/fail|did not pass|not pass/i);

    // The thread is a pi session file in OUR dir, with our custom entries.
    const dir = join(cwd, '.agent-health', 'ask-sessions');
    const files = readdirSync(dir).filter((f) => f.endsWith(`_${prep.sessionId}.jsonl`));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'session', id: prep.sessionId });
    expect(lines.some((l) => l.type === 'custom' && l.customType === 'agent-health.ask' && l.data.page.route === pageContext.route)).toBe(true);
    expect(lines.some((l) => l.type === 'custom' && l.customType === 'agent-health.ask.turn' && l.data.answer === answer1)).toBe(true);
    expect(lines.filter((l) => l.type === 'message' && l.message.role === 'assistant').length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(process.env.HOME ?? '/nonexistent', '.pi', 'agent', 'sessions', cwd.replace(/[^a-zA-Z0-9]/g, '-')))).toBe(false);

    // RESTART. In-memory state is gone; only the JSONL remains.
    await stopServer();
    expect(await startServer()).toBe(true);

    const second = await postAsk({ question: 'Repeat, verbatim, the exact dependency name you gave in your previous answer (the one containing "sentinel"). Output only that name.', selections: [], pageContext, sessionId: prep.sessionId });
    expect(second.sse!.error).toBeUndefined();
    expect(second.sse!.meta.sessionId).toBe(prep.sessionId);
    expect(second.sse!.meta.prepared).toBe(false);
    expect(second.sse!.meta.loaded).toEqual([]); // no snapshot re-sent: history came from the pi session file
    expect(second.sse!.done.answer).toContain(sentinel);

    const detail = await fetch(`${BASE_URL}/api/ask/sessions/${prep.sessionId}`).then((r) => r.json());
    expect(detail.session.turns).toHaveLength(2);
    expect(detail.session.turns[0].answer).toBe(answer1);
    expect(detail.session.page.route).toBe(pageContext.route);
    const list = await fetch(`${BASE_URL}/api/ask/sessions?route=${encodeURIComponent(pageContext.route)}`).then((r) => r.json());
    expect(list.dir).toBe(dir);
    expect(list.sessions.map((s: any) => s.id)).toContain(prep.sessionId);
    expect(list.sessions[0]).toMatchObject({ firstSelection: 'Outcome not achieved.', turnCount: 2 });
    expect(await fetch(`${BASE_URL}/api/ask/sessions/does-not-exist`).then((r) => r.status)).toBe(404);
  }, 400_000);
});
