/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helper for integration tests that drive the REAL CLI bundle
 * (`cli/dist/index.js`) as a child process — the way a user runs
 * `npx @opensearch-project/agent-health …`.
 *
 * - `ensureCliBundle()` builds the bundle once if it is missing.
 * - `runCli(args, opts)` spawns it synchronously with a CLEAN environment:
 *   Jest injects NODE_OPTIONS / coverage shims that confuse undici inside the
 *   child (its `/health` probe fails, it thinks no server is running and
 *   starts its own), so only PATH/HOME/USER/TMPDIR/AWS_* survive, plus
 *   `AH_PORT` pinned to the backend the test config points at. Every child
 *   also goes through `withCliCoverage()` so, when CI sets
 *   `AH_CLI_V8_COVERAGE_DIR`, its execution counts toward the `cli` flag.
 *
 * Nothing here mocks the CLI: assertions in the suites are on exit codes,
 * printed output and the data the server ends up holding.
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { getTestBackendUrl } from '../integration/testConfig';
import { withCliCoverage } from './cliCoverage';
import { uniqueTestName, type TestDataTracker } from './testDataTracker';

export const REPO_ROOT = join(__dirname, '..', '..');
export const CLI_BUNDLE = join(REPO_ROOT, 'cli', 'dist', 'index.js');

export function ensureCliBundle(): void {
  if (existsSync(CLI_BUNDLE)) return;
  const built = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
  if (built.status !== 0) throw new Error('npm run build:cli failed; cannot continue');
  if (!existsSync(CLI_BUNDLE)) throw new Error(`CLI bundle still missing at ${CLI_BUNDLE} after build`);
}

/** The port of the backend under test (from AH_PORT / AGENT_HEALTH_PORT, default 4001). */
export function backendPort(): string {
  return new URL(getTestBackendUrl()).port || '4001';
}

/**
 * Plain `http.request` JSON helper (no undici, no keep-alive). Jest 30 + undici
 * has a known race on localhost right after a child process used the same
 * loopback (`SocketError: other side closed` / `socket hang up`); a pooled
 * `fetch` in the test process can inherit a half-closed socket. `agent: false`
 * opens a fresh connection per call and sidesteps it.
 */
export function httpJson<T = any>(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; ok: boolean; body: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        agent: false,
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          let body: unknown = text;
          try { body = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
          resolve({ status, ok: status >= 200 && status < 300, body: body as T });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function backendAvailable(baseUrl = getTestBackendUrl()): Promise<boolean> {
  try {
    const health = await httpJson(`${baseUrl}/health`);
    if (!health.ok) return false;
    const storage = await httpJson<{ status?: string }>(`${baseUrl}/api/storage/health`);
    return storage.body.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Gate for suites that need the backend. Returns false (→ the suite skips with
 * a warning, the repo-wide convention for a dev box with no server) unless
 * `AH_TEST_EXPECT_BACKEND` promises one — the CI integration job sets it to
 * `opensearch` — in which case an unreachable server or a different backend
 * FAILS the suite instead of skipping, so coverage cannot vanish behind a
 * green check (see #579).
 */
export async function backendReadyOrSkip(label: string, baseUrl = getTestBackendUrl()): Promise<boolean> {
  const expected = process.env.AH_TEST_EXPECT_BACKEND;
  const ready = await backendAvailable(baseUrl);
  if (!ready) {
    if (expected) throw new Error(`[${label}] AH_TEST_EXPECT_BACKEND=${expected} but no healthy backend at ${baseUrl}`);
    // eslint-disable-next-line no-console
    console.warn(`[${label}] backend not reachable at ${baseUrl} — skipping`);
    return false;
  }
  if (expected) {
    const actual = await storageBackend(baseUrl);
    if (actual !== expected) throw new Error(`[${label}] AH_TEST_EXPECT_BACKEND=${expected} but the server at ${baseUrl} reports backend=${actual}`);
  }
  return true;
}

/**
 * The storage backend the server reports: `file` when the file module says so
 * explicitly; `opensearch` otherwise — the OpenSearch module reports cluster
 * health with NO `backend` key (server/routes/storage/admin.ts), same reading
 * as `probeStorageBackend()` in the storage-route suites.
 */
export async function storageBackend(baseUrl = getTestBackendUrl()): Promise<string> {
  const res = await httpJson<{ status?: string; backend?: string }>(`${baseUrl}/api/storage/health`);
  if (!res.ok || res.body.status !== 'ok') throw new Error(`storage health probe: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  if (res.body.backend === 'file') return 'file';
  if (res.body.backend === undefined || res.body.backend === 'opensearch') return 'opensearch';
  throw new Error(`storage health probe: unexpected backend "${res.body.backend}"`);
}

export interface RunCliOptions {
  /** Working directory for the child (default: repo root). */
  cwd?: string;
  /** Extra env for the child; overrides the clean base. `undefined` values delete keys. */
  env?: Record<string, string | undefined>;
  /** Kill the child after this many ms (default 120 s). */
  timeoutMs?: number;
  /** Keep AWS_* from the parent env (default true; set false to prove credential-less paths). */
  keepAws?: boolean;
  /** Pipe this string to the child's stdin. */
  input?: string;
}

export interface CliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for assertions that do not care which stream a line went to. */
  output: string;
}

export function cleanCliEnv(opts: RunCliOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k === 'SHELL' || k === 'LD_LIBRARY_PATH') env[k] = v;
    else if ((opts.keepAws ?? true) && k.startsWith('AWS_')) env[k] = v;
  }
  env.AH_PORT = backendPort();
  env.AH_SUPPRESS_EXPERIMENTAL = '1';
  env.AH_QUIET_DEPRECATIONS = '1';
  // `CI` is deliberately NOT inherited: the CLI changes behaviour under it
  // (stops servers it started, skips prompts). Suites opt in via `env`.
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export function runCli(args: string[], opts: RunCliOptions = {}): CliResult {
  const res: SpawnSyncReturns<string> = spawnSync(process.execPath, [CLI_BUNDLE, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    env: withCliCoverage(cleanCliEnv(opts)),
    timeout: opts.timeoutMs ?? 120_000,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  return { status: res.status, signal: res.signal, stdout, stderr, output: stdout + stderr };
}

/**
 * Parse the JSON document a command printed, skipping any banner lines before
 * it. Several server-backed commands still print one-line notices
 * (`[ServerLifecycle] Reusing existing server …`, `[workflow:…]`, the `run`
 * banner) on stdout even with `-o json` / `--stdout` — pre-existing on `main`
 * and tracked as a stdout-hygiene fix, NOT a contract these suites endorse:
 * tolerated here so the data assertions stay meaningful.
 */
export function jsonTail(stdout: string): unknown {
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('[') && !t.startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      /* a banner line such as "[ServerLifecycle] …" — keep looking */
    }
  }
  throw new Error(`no JSON document found in stdout:\n${stdout}`);
}

/** Strip ANSI colour codes so assertions can match the words the user reads. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// ─── Fixtures + cleanup for suites that drive the CLI against the backend ──────


/** A minimal, schema-valid classic (JSON) test case with a run-unique name. */
export function classicCase(label: string, overrides: Record<string, unknown> = {}) {
  return {
    name: uniqueTestName(label),
    category: 'RCA',
    difficulty: 'Easy',
    initialPrompt: 'Why did the checkout service start returning 500s after the last deploy?',
    expectedOutcomes: ['Checks the error logs', 'Identifies the failing dependency'],
    ...overrides,
  };
}

/** Write `n` classic cases to `<dir>/<file>` and return the names. */
export function writeCasesFile(dir: string, file: string, n: number, label: string): string[] {
  const cases = Array.from({ length: n }, (_, i) => classicCase(`${label}-${i + 1}`));
  writeFileSync(join(dir, file), JSON.stringify(cases, null, 2), 'utf-8');
  return cases.map(c => c.name);
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

interface BenchmarkDoc {
  id: string;
  name: string;
  testCaseIds?: string[];
  runs?: Array<{ id: string }>;
}

/**
 * Find a benchmark by (unique) name and track it, its evaluation runs, every
 * report those runs produced, any legacy embedded runs, and its test cases —
 * so afterAll deletes exactly what the CLI created and nothing else.
 * Returns the benchmark doc (or null when the CLI never created it).
 */
export async function trackBenchmarkByName(
  tracker: TestDataTracker,
  name: string,
  baseUrl = getTestBackendUrl(),
): Promise<BenchmarkDoc | null> {
  const list = await httpJson<{ benchmarks?: BenchmarkDoc[] }>(`${baseUrl}/api/storage/benchmarks?size=1000`);
  const bm = (list.body.benchmarks ?? []).find(b => b.name === name);
  if (!bm) return null;
  for (const id of bm.testCaseIds ?? []) tracker.testCase(id);
  for (const lr of bm.runs ?? []) tracker.benchmarkRun(bm.id, lr.id);
  await trackEvaluationRunsOf(tracker, bm.id, baseUrl);
  tracker.benchmark(bm.id);
  return bm;
}

export async function trackEvaluationRunsOf(tracker: TestDataTracker, benchmarkId: string, baseUrl = getTestBackendUrl()): Promise<string[]> {
  const res = await httpJson<{ evaluationRuns?: Array<{ id: string; results?: Record<string, { reportId?: string }> }> }>(
    `${baseUrl}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}&size=500`,
  );
  const ids: string[] = [];
  for (const run of res.body.evaluationRuns ?? []) {
    for (const r of Object.values(run.results ?? {})) tracker.run(r.reportId);
    tracker.evaluationRun(run.id);
    ids.push(run.id);
  }
  return ids;
}

/** Track an ad-hoc evaluation run (no benchmark) and its reports by id. */
export async function trackEvaluationRun(tracker: TestDataTracker, runId: string, baseUrl = getTestBackendUrl()): Promise<void> {
  const run = await getEvaluationRun(runId, baseUrl);
  for (const r of Object.values(run?.results ?? {})) tracker.run(r.reportId);
  tracker.evaluationRun(runId);
}

export interface EvaluationRunDoc {
  id: string;
  status: string;
  benchmarkId?: string;
  agentKey?: string;
  trigger?: string;
  judgeModelId?: string;
  results?: Record<string, { reportId?: string; status: string; passFailStatus?: string }>;
}

/** GET one evaluation run; the route returns the doc either bare or under `evaluationRun`. */
export async function getEvaluationRun(runId: string, baseUrl = getTestBackendUrl()): Promise<EvaluationRunDoc | null> {
  const res = await httpJson<EvaluationRunDoc & { evaluationRun?: EvaluationRunDoc }>(`${baseUrl}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return null;
  return res.body.evaluationRun ?? res.body;
}

export async function listEvaluationRunsOf(benchmarkId: string, baseUrl = getTestBackendUrl()): Promise<EvaluationRunDoc[]> {
  const res = await httpJson<{ evaluationRuns?: EvaluationRunDoc[] }>(`${baseUrl}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}&size=500`);
  return res.body.evaluationRuns ?? [];
}

/** Track every stored test case whose name is in `names` (names are run-unique). */
export async function trackTestCasesByName(tracker: TestDataTracker, names: string[], baseUrl = getTestBackendUrl()): Promise<Map<string, string>> {
  const wanted = new Set(names);
  const found = new Map<string, string>();
  const res = await httpJson<{ testCases?: Array<{ id: string; name: string }> }>(`${baseUrl}/api/storage/test-cases?size=1000`);
  for (const tc of res.body.testCases ?? []) {
    if (wanted.has(tc.name)) {
      tracker.testCase(tc.id);
      found.set(tc.name, tc.id);
    }
  }
  return found;
}
