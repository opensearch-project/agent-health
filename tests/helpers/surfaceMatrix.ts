/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared plumbing for the customer-surface regression matrix
 * (`tests/integration/surface-matrix/` + `tests/e2e/surface-matrix/`, index in
 * `docs/SURFACE_MATRIX.md`).
 *
 * Every spec in the matrix pins an EXTERNALLY visible contract — CLI exit code
 * and printed summary, HTTP status + body shape, rendered UI state — against a
 * running backend (`AH_PORT`) with a real fixture REST agent
 * (`tests/helpers/traceparentRestAgent.ts`) and the built-in demo/mock judge.
 * Nothing here reaches into server internals; it only talks to the same
 * surfaces a customer uses. Zero dependencies beyond node:http / node:child_process
 * so the same helper runs under jest and Playwright.
 */

import { spawn } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { uniqueTestName } from './testDataTracker';
import type { TraceparentRestAgent } from './traceparentRestAgent';

export const BACKEND_PORT = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001';
export const BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;
/** Repo root — both jest and Playwright run with cwd = repo root. */
export const REPO_ROOT = process.cwd();
export const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');
/** The model key every run is judged with: `demo-model` → demo provider → mock judge (no LLM). */
export const DEMO_MODEL = 'demo-model';
export const W3C_TRACE_ID = /^[0-9a-f]{32}$/i;

// ── HTTP (plain node:http; sidesteps the jest + undici localhost race) ─────

export interface HttpResult<T = any> {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  /** Parsed JSON body, or `undefined` when the body is not JSON. */
  body: T;
}

export function httpRequest<T = any>(
  method: string,
  pathname: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<HttpResult<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE_URL);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        agent: false,
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
          resolve({ status: res.statusCode || 0, headers: res.headers, text, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Like {@link httpRequest} but throws on non-2xx and returns the JSON body. */
export async function api<T = any>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await httpRequest<T>(method, pathname, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${pathname} → ${res.status} ${res.text.slice(0, 500)}`);
  }
  return res.body;
}

export interface SseEvent {
  /** `event:` name when the stream uses named events (evaluation-runs, /execute); otherwise `message`. */
  event: string;
  data: any;
}

/**
 * POST and consume a Server-Sent-Events response to its end. Returns the HTTP
 * status/headers plus every parsed `data:` frame (with its `event:` name).
 */
export function postSse(pathname: string, body: unknown): Promise<HttpResult<undefined> & { events: SseEvent[] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE_URL);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'text/event-stream' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, headers: res.headers, text, body: undefined, events: parseSse(text) });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of text.split('\n\n')) {
    let event = 'message';
    let data: string | undefined;
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = data === undefined ? line.slice(6) : `${data}\n${line.slice(6)}`;
    }
    if (data === undefined) continue;
    try { events.push({ event, data: JSON.parse(data) }); } catch { /* partial frame */ }
  }
  return events;
}

// ── Backend probes ────────────────────────────────────────────────────────

/**
 * Is the backend under test up? A missing server means "skip with a warning"
 * (repo convention for integration suites — `npm test` in the release
 * rehearsal job runs with no server at all). When a job explicitly points the
 * suite at a backend (`AH_PORT` set) under `CI`, an unreachable server is a
 * hard failure instead — a matrix that silently skips every assertion is a
 * false green.
 */
export async function backendReady(): Promise<boolean> {
  let ready = false;
  try {
    const health = await httpRequest('GET', '/health');
    if (health.status === 200) {
      const storage = await httpRequest('GET', '/api/storage/health');
      ready = storage.status === 200 && storage.body?.status === 'ok';
    }
  } catch {
    ready = false;
  }
  if (!ready && process.env.CI && process.env.AH_PORT) {
    throw new Error(`[surface-matrix] backend not reachable at ${BASE_URL} under CI (AH_PORT=${process.env.AH_PORT}) — refusing to skip the matrix`);
  }
  return ready;
}

/**
 * A free TCP port on 127.0.0.1 for a server the test itself boots. Asked of the
 * OS (bind :0, read, release) so parallel workers / shards never collide on a
 * fixed offset; `SURFACE_MATRIX_SPARE_PORT` pins one when a range is reserved.
 */
export async function reserveSparePort(): Promise<number> {
  if (process.env.SURFACE_MATRIX_SPARE_PORT) return Number(process.env.SURFACE_MATRIX_SPARE_PORT);
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Which storage backend the server under test runs on — read from
 * `/api/storage/config/status` (`runtime.storage.backend`), which names it on
 * both backends; `/api/storage/health` only says `backend: 'file'` on file
 * storage and returns the cluster health otherwise.
 */
export async function storageBackend(): Promise<'file' | 'opensearch' | 'unknown'> {
  const res = await httpRequest('GET', '/api/storage/config/status');
  const backend = res.body?.runtime?.storage?.backend;
  return backend === 'file' || backend === 'opensearch' ? backend : 'unknown';
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// ── Fixtures ──────────────────────────────────────────────────────────────

export interface CaseInput {
  name: string;
  category: string;
  difficulty: string;
  initialPrompt: string;
  expectedOutcomes: string[];
  context: unknown[];
  labels?: string[];
}

/** A synthetic retrieval-style test case; `label` gives the run-unique name a readable prefix. */
export function caseInput(label: string, i: number, extra: Partial<CaseInput> = {}): CaseInput {
  return {
    name: uniqueTestName(`${label}-case-${i}`),
    category: 'RCA',
    difficulty: 'Easy',
    initialPrompt: `search products ${i} ${uniqueTestName('q')}`,
    expectedOutcomes: ['returns a product'],
    context: [],
    ...extra,
  };
}

export async function createTestCase(input: CaseInput): Promise<{ id: string; name: string }> {
  const body = await api<any>('POST', '/api/storage/test-cases', input);
  const tc = body.testCase ?? body;
  return { id: tc.id, name: tc.name };
}

export async function createBenchmark(name: string, testCaseIds: string[]): Promise<{ id: string; name: string }> {
  const body = await api<any>('POST', '/api/storage/benchmarks', {
    name,
    description: 'customer-surface regression matrix',
    testCaseIds,
  });
  const bm = body.benchmark ?? body;
  return { id: bm.id, name: bm.name };
}

/**
 * Register the fixture REST agent the way a customer does from Settings →
 * "Add custom agent" (`POST /api/agents/custom`). Returns the generated key.
 */
export async function registerRestAgent(agent: TraceparentRestAgent, opts: { useTraces: boolean; label?: string }): Promise<string> {
  const created = await api<{ agent: { key: string } }>('POST', '/api/agents/custom', {
    name: uniqueTestName(opts.label ?? 'surface-matrix-rest-agent'),
    endpoint: agent.url,
    connectorType: 'rest',
    useTraces: opts.useTraces,
  });
  return created.agent.key;
}

export async function getEvaluationRun(id: string): Promise<any> {
  return api('GET', `/api/storage/evaluation-runs/${encodeURIComponent(id)}`);
}

export async function getReport(id: string): Promise<any> {
  const body = await api<any>('GET', `/api/storage/runs/${encodeURIComponent(id)}`);
  return body.run ?? body;
}

export async function getBenchmark(id: string): Promise<any> {
  const body = await api<any>('GET', `/api/storage/benchmarks/${encodeURIComponent(id)}`);
  return body.benchmark ?? body;
}

/**
 * Find a benchmark by its (run-unique) name. Polls briefly: on the OpenSearch
 * backend a freshly created document can trail the list view by one refresh
 * interval (~1s), and the CLI may have created it only moments ago.
 */
export async function findBenchmarkByName(name: string, timeoutMs = 8_000): Promise<any | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { benchmarks } = await api<{ benchmarks: any[] }>('GET', '/api/storage/benchmarks?size=500');
    const found = benchmarks.find((b) => b.name === name);
    if (found || Date.now() >= deadline) return found;
    await sleep(500);
  }
}

/**
 * The evaluation runs a customer sees for a benchmark (`GET
 * /api/storage/evaluation-runs?benchmarkId=`), polled until at least `min`
 * of them are terminal (same refresh-lag reasoning as {@link findBenchmarkByName}).
 */
export async function listTerminalRunsForBenchmark(benchmarkId: string, min = 1, timeoutMs = 60_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let runs: any[] = [];
  for (;;) {
    ({ evaluationRuns: runs } = await api<{ evaluationRuns: any[] }>(
      'GET', `/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}&size=50`
    ));
    if (runs.filter((r) => TERMINAL_RUN_STATUSES.has(r.status)).length >= min || Date.now() >= deadline) return runs;
    await sleep(500);
  }
}

/** Give an eventually-consistent (OpenSearch) backend one refresh interval; a no-op on file storage. */
export async function settleStorage(): Promise<void> {
  if ((await storageBackend()) === 'opensearch') await sleep(1_500);
}

export async function waitForTerminalRun(id: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await getEvaluationRun(id);
    if (TERMINAL_RUN_STATUSES.has(last?.status)) return last;
    await sleep(500);
  }
  throw new Error(`evaluation run ${id} did not reach a terminal state within ${timeoutMs}ms (last status: ${last?.status})`);
}

/** Poll until every report has left `pending`/`calculating` (i.e. the judge has spoken or given up). */
export async function waitForReportsResolved(reportIds: string[], timeoutMs = 60_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let reports: any[] = [];
  while (Date.now() < deadline) {
    reports = await Promise.all(reportIds.map((id) => getReport(id)));
    const unresolved = reports.filter((r) => r.metricsStatus === 'pending' || r.metricsStatus === 'calculating');
    if (unresolved.length === 0) return reports;
    await sleep(500);
  }
  throw new Error(`reports still unresolved after ${timeoutMs}ms: ${reports.filter((r) => r.metricsStatus === 'pending' || r.metricsStatus === 'calculating').map((r) => r.id).join(', ')}`);
}

export function reportIdsOf(run: any): string[] {
  return (Object.values(run?.results || {}) as any[]).map((r) => r.reportId).filter(Boolean);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CLI ───────────────────────────────────────────────────────────────────

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr with ANSI colour codes stripped — what the customer reads. */
  out: string;
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Environment for a spawned CLI: what a customer's shell would carry (PATH,
 * HOME, locale, proxy / CA config, AWS_*), and nothing the test runner
 * injects. An allow-list rather than a deny-list because jest/Playwright
 * `NODE_OPTIONS` shims break undici inside the child's `/health` probe (see
 * tests/integration/cli/benchmarkCodeSdk.integration.test.ts) and new runner
 * variables keep appearing. `CI` is deliberately NOT carried: a customer's
 * shell does not set it, and `CI=1` changes how the CLI treats an
 * already-running server (`reuseExistingServer: false` — reused only when the
 * port was named explicitly, refused otherwise). That contract is pinned on
 * its own in cli-server-lifecycle (`env: { CI: 'true' }`).
 *
 * An override whose value is `undefined` UNSETS the variable in the child —
 * `{ AH_PORT: undefined }` is how the lifecycle spec spawns a CLI with an
 * implicit (defaulted) port.
 */
export function cliEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (
      k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k === 'LANG' || k === 'TZ' || k === 'SHELL' ||
      k === 'NODE_EXTRA_CA_CERTS' || k === 'SSL_CERT_FILE' || /^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/.test(k) ||
      k.startsWith('AWS_')
    ) {
      env[k] = v;
    }
  }
  const merged: Record<string, string> = {
    ...env,
    AH_PORT: BACKEND_PORT,
    // `bin/cli.js` runs the TypeScript source through tsx when the checkout is
    // present (dev mode). tsx resolves the `@/` path alias from the tsconfig
    // nearest to cwd, so a CLI launched from ANOTHER directory (the isolated
    // project dirs used by the lifecycle spec) needs the repo tsconfig pinned.
    // Irrelevant for the published package (bundled `cli/dist`).
    TSX_TSCONFIG_PATH: path.join(REPO_ROOT, 'tsconfig.json'),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1',
    AH_QUIET_DEPRECATIONS: '1',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

export interface RunCliOptions {
  cwd?: string;
  /** Extra child env; a value of `undefined` unsets that variable (see cliEnv). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Spawn `node bin/cli.js <args>` exactly as `npx @opensearch-project/agent-health <args>` would run it. */
export function runCli(args: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      env: cliEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms: agent-health ${args.join(' ')}\n${stripAnsi(stdout + stderr)}`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, out: stripAnsi(stdout + stderr) });
    });
  });
}

/**
 * Start `agent-health serve --headless` on `port` (a port the caller owns),
 * wait for `/health`, and return the server's own pid as reported by the
 * health endpoint (the only thing a customer can use to stop it).
 */
export async function serveHeadless(port: number, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{
  pid: number;
  health: any;
  stop: () => Promise<void>;
}> {
  const child = spawn(process.execPath, [CLI, 'serve', '--headless', '--no-browser', '-p', String(port)], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: cliEnv({ AH_PORT: String(port), ...(opts.env ?? {}) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const url = `http://127.0.0.1:${port}/health`;
  let health: any = null;
  while (Date.now() < deadline && !health) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(url);
      if (res.ok) health = await res.json();
    } catch { /* not up yet */ }
    if (!health) await sleep(300);
  }
  const stop = async () => {
    const pid = health?.instance?.pid ?? child.pid;
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    await waitForPortFree(port, 15_000);
  };
  if (!health) {
    await stop();
    throw new Error(`agent-health serve did not become healthy on :${port} within ${opts.timeoutMs ?? 90_000}ms\n${stripAnsi(output)}`);
  }
  return { pid: health.instance?.pid ?? child.pid!, health, stop };
}

export async function isPortServing(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortServing(port))) return;
    await sleep(250);
  }
}

/**
 * Stop whatever agent-health server answers on `port` — by the pid IT reports
 * on `/health` (never by pattern), and only when its `instance.cwd` matches
 * the directory the test booted it from.
 */
export async function stopServerOnPort(port: number, expectedCwd: string): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return;
    const health = await res.json();
    const pid = health?.instance?.pid;
    if (typeof pid === 'number' && health?.instance?.cwd === expectedCwd) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      await waitForPortFree(port, 15_000);
    }
  } catch { /* nothing listening */ }
}

// ── Shared assertions (plain functions so jest `expect` and Playwright `expect` both work) ──

/**
 * The customer-visible shape of a finished run produced through ANY surface:
 * one report per case, each judged (`metricsStatus` resolved, never `error`),
 * each carrying the agent's conversation id as `runId` and — when traces were
 * correlated — a real W3C trace id that is never the connector id.
 */
export function describeResolvedReports(reports: any[], agent: TraceparentRestAgent): string[] {
  const problems: string[] = [];
  for (const report of reports) {
    if (report.status !== 'completed') problems.push(`${report.id}: status=${report.status}`);
    if (report.metricsStatus !== 'ready') problems.push(`${report.id}: metricsStatus=${report.metricsStatus} traceError=${report.traceError ?? ''}`);
    if (!['passed', 'failed'].includes(report.passFailStatus)) problems.push(`${report.id}: passFailStatus=${report.passFailStatus}`);
    if (!agent.invocations.some((i) => i.conversationId === report.runId)) problems.push(`${report.id}: runId ${report.runId} is not one of the agent's conversation ids`);
    if (report.traceId !== undefined && report.traceId !== null) {
      if (!W3C_TRACE_ID.test(report.traceId)) problems.push(`${report.id}: traceId ${report.traceId} is not a W3C trace id`);
      if (report.traceId === report.runId) problems.push(`${report.id}: traceId equals runId (connector id persisted as traceId)`);
    }
  }
  return problems;
}
