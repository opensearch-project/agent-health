/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A throw-away agent-health PROJECT for the CLI / e2e matrix suites: FILE
 * storage (no `storage` block) with ONE observability source — the OpenSearch
 * traces index of a REAL node, or CloudWatch (a local CloudWatch Logs API stub
 * the unmodified AWS SDK signs its requests to) — authored the way a user
 * authors it: `agent-health.config.ts` importing `defineConfig` from the
 * installed package (`node_modules/@opensearch-project/agent-health` → this
 * repo), a `.env`, and a TypeScript eval file `evals/retrieval.eval.ts`.
 *
 * The package is STAGED the way `npm install` lays it out
 * (`<project>/node_modules/@opensearch-project/agent-health` = package.json,
 * bin, cli/dist, server/dist, lib/dist, dist), so `bin/cli.js` takes the
 * production path — including for the server `agent-health benchmark`
 * auto-starts (a detached `bin/cli.js serve`), which in a dev checkout would
 * run the TS sources through tsx from a cwd without a tsconfig. The project
 * lives under `<repo>/.agent-health/` (gitignored) so the staged package's
 * dependencies resolve from the repo's node_modules, like detachedServerLifecycle
 * and bindLoopback do. The staged bundle's source map gets a `sourceRoot`
 * pointing back at `<repo>/cli/dist`, so the V8 coverage its processes write
 * (`withCliCoverage()`) maps onto `cli/**\/*.ts` of the repo, not the copy.
 *
 * The server is a REAL process: either a child this helper spawns
 * (`agent-health serve`, or `server/dist/index.js`) or the one the CLI
 * auto-started for the project, which `adoptServer()` identifies by its
 * `/health` instance block (cwd = this project) — config discovery, `.env`
 * loading, the file storage adapter under `<project>/.agent-health/`, the
 * trace readers and the SDK all run as they do for a user. The two network
 * peers (agent, CloudWatch) are real HTTP servers, not module mocks;
 * OpenSearch is a real node.
 *
 * Cleanup kills exactly the server PID this helper spawned or adopted, stops
 * the peers, drops the span index and removes the project directory (its file
 * storage goes with it) — nothing shared is touched.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AgentSpanSink } from './agentSpanSink';
import { startCloudWatchLogsStub, type CloudWatchLogsStub } from './cloudWatchLogsStub';
import { startOpenSearchSpanIndex, type OpenSearchSpanIndex } from './openSearchSpanIndex';
import { startDemoRetrievalAgent, type DemoRetrievalAgent } from './demoRetrievalAgentStub';
import { CLI_COVERAGE_DIR_VAR } from './cliCoverage';

// `process.cwd()` rather than `__dirname`: jest (CJS) and Playwright (ESM, no
// `__dirname`) both run from the repo root.
export const REPO_ROOT = process.cwd();
export const CLI_BUNDLE = join(REPO_ROOT, 'cli', 'dist', 'index.js');
export const SERVER_BUNDLE = join(REPO_ROOT, 'server', 'dist', 'index.js');
/** The package entry `import … from '@opensearch-project/agent-health'` resolves to (package.json `exports`). */
export const PACKAGE_ENTRY = join(REPO_ROOT, 'lib', 'dist', 'lib', 'index.js');
/** Built artefacts staged into the project's node_modules (what `npm pack` ships, minus docs). */
const PACKAGE_FILES = ['package.json', 'bin', 'cli/dist', 'server/dist', 'lib/dist', 'dist'];
const PACKAGE_NAME = '@opensearch-project/agent-health';

export type ObservabilitySource = 'opensearch' | 'cloudwatch';

export const DEMO_AGENT_KEY = 'demo-retrieval';
/** The run inspector derives `<agentKey>-agent` when the agent declares no `traceServiceName`. */
export const DEMO_AGENT_SERVICE_NAME = `${DEMO_AGENT_KEY}-agent`;

/** The judge model every matrix run is started with: the built-in mock judge (provider `demo`, no credentials). */
export const MOCK_JUDGE_MODEL = 'demo-model';

/** The cases of `evals/retrieval.eval.ts`, by name, with the verdict each must get. */
export const MATRIX_CASES = {
  ok: { name: 'answers from the knowledge base', verdict: 'passed' },
  toolError: { name: 'a failed tool attempt is retried', verdict: 'passed' },
  judged: { name: 'the answer is grounded (judged)', verdict: 'passed' },
  fails: { name: 'flags an answer without a citation', verdict: 'failed' },
  soft: { name: 'every soft check is reported', verdict: 'failed' },
  outage: { name: 'an agent outage is an error, not a verdict', verdict: 'errored' },
} as const;
export const MATRIX_CASE_COUNT = Object.keys(MATRIX_CASES).length;
export const MATRIX_VERDICT_COUNTS = { passed: 3, failed: 2, errored: 1 } as const;
/** The one case of `evals/other.eval.ts` (a different source file for the same benchmark name — #620). */
export const OTHER_CASE_NAME = 'answers a billing question (other file)';

export interface FileStorageEvalProject {
  source: ObservabilitySource;
  dir: string;
  /** `bin/cli.js` of the staged package — the CLI a user runs (`npx agent-health …`). */
  cli: string;
  /** `server/dist/index.js` of the staged package. */
  serverBundle: string;
  sink: AgentSpanSink;
  /** The CloudWatch Logs API stub (CloudWatch source only). */
  cloudWatch?: CloudWatchLogsStub;
  /** The throw-away Data Prepper span index (OpenSearch source only). */
  spanIndex?: OpenSearchSpanIndex;
  agent: DemoRetrievalAgent;
  /** Env for every process of this project: the server and any CLI command against it. */
  env: Record<string, string>;
  port: number;
  baseUrl: string;
  /** PID of the server this helper spawned or adopted (undefined until `startServer` / `adoptServer`). */
  serverPid?: number;
  startServer(entry?: 'cli' | 'server-bundle'): Promise<void>;
  /** Take ownership of the server the CLI auto-started for THIS project (identified by `/health` instance.cwd). */
  adoptServer(): Promise<number>;
  /** Kill the spawned/adopted server (by its PID only), stop the peers, drop the span index, delete the project. */
  cleanup(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Plain `node:http` JSON request (no keep-alive agent): jest 30 + undici has a
 * known race on the first loopback request after a CLI child used the port.
 */
export function httpJson<T = any>(url: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; ok: boolean; body: T }> {
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
        headers: { Accept: 'application/json', ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          let body: unknown = text;
          try { body = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
          resolve({ status, ok: status >= 200 && status < 300, body: body as T });
        });
      }
    );
    req.on('error', reject);
    // A listener that accepts but never answers must not hang the suite.
    req.setTimeout(15_000, () => req.destroy(new Error(`${init.method ?? 'GET'} ${url}: no response within 15 s`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A free loopback port, or `AH_TEST_SERVER_PORT` when a suite must stay inside an assigned range. */
export async function reservePort(): Promise<number> {
  const fixed = Number(process.env.AH_TEST_SERVER_PORT);
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/**
 * Env a user's shell would have in this project: no inherited AWS profile,
 * OpenSearch settings or AH_* overrides (file storage + the configured source
 * must win). The CloudWatch variant adds static test credentials for SigV4 and
 * the AWS SDK's per-service endpoint override pointing at the stub.
 */
export function projectEnv(port: number, source: ObservabilitySource, cloudWatchUrl?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (['PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL', 'LANG', 'LD_LIBRARY_PATH', 'NODE_V8_COVERAGE'].includes(k)) env[k] = v;
  }
  Object.assign(env, {
    PORT: String(port),
    AH_PORT: String(port),
    AGENT_HEALTH_STORAGE: 'file',
    BENCHMARK_RUN_RECOVERY_DISABLED: '1',
    EVALUATION_RUN_RECOVERY_DISABLED: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1',
    AH_QUIET_DEPRECATIONS: '1',
    NO_COLOR: '1',
    // Trace polling on the SDK path: both sources answer instantly; don't wait minutes on a miss.
    TRACE_POLL_MAX_ATTEMPTS: '3',
    TRACE_POLL_INTERVAL_MS: '500',
  });
  if (process.env[CLI_COVERAGE_DIR_VAR]) {
    // CLI coverage (CI): the processes run the STAGED bundle, which cleanup() deletes before `coverage:cli` runs.
    // With source maps enabled Node embeds the bundle's map (+ line lengths) in each V8 dump, so c8 needs neither
    // the copy nor its .map afterwards — and the map's `sourceRoot` (see stagePackage) points the sources at the repo.
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--enable-source-maps'].filter(Boolean).join(' ');
  }
  if (source === 'cloudwatch') {
    Object.assign(env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIATESTCLOUDWATCHSTUB',
      AWS_SECRET_ACCESS_KEY: 'test-secret-for-the-local-cloudwatch-stub',
      AWS_ENDPOINT_URL_CLOUDWATCH_LOGS: cloudWatchUrl!,
    });
  }
  return env;
}

/** `agent-health.config.ts` body: one REST agent (Strategy D session id via afterResponse) + the observability source, no `storage`. */
export function configSource(agentEndpoint: string, observability: Record<string, unknown>): string {
  return `// Generated by a test — FILE storage (no \`storage\` block) + one observability source, authored in TypeScript.
import { defineConfig } from '@opensearch-project/agent-health';

interface AgentReply { sessionId?: string; response?: string }

export default defineConfig({
  agents: [
    {
      key: ${JSON.stringify(DEMO_AGENT_KEY)},
      name: 'Demo Retrieval Agent',
      connectorType: 'rest',
      endpoint: ${JSON.stringify(agentEndpoint)},
      useTraces: true,
      tracePolling: { maxAttempts: 3, intervalMs: 500 },
      hooks: {
        // The agent stamps \`session.id\` on its spans and echoes it in the reply:
        // surface it as the connector's sessionId (Strategy D).
        afterResponse: async (ctx: any) => {
          const reply = ctx.response as AgentReply | undefined;
          if (ctx.metadata && reply && typeof reply.sessionId === 'string') ctx.metadata.sessionId = reply.sessionId;
          return { response: ctx.response, trajectory: ctx.trajectory, runId: ctx.runId };
        },
      },
    },
  ],
  observability: ${JSON.stringify(observability, null, 2).replace(/\n/g, '\n  ')},
});
`;
}

/** The eval file the CLI runs: six cases — deterministic pass/fail, a failed tool span, a judged case, soft checks, an agent outage. */
export const RETRIEVAL_EVAL_SOURCE = `import { test, expect } from '@opensearch-project/agent-health';

const CITATION: string = 'Billing FAQ';
const TOKENS_PER_RUN: number = 4050;

// Deterministic checks only — no judge. \`traces\` is read from the configured
// observability source (OpenSearch or CloudWatch) DURING the run.
test(${JSON.stringify(MATRIX_CASES.ok.name)}, { prompt: 'How long do refunds take to post?' }, async ({ agent, traces }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include(CITATION);
  expect(result.trajectory).to.haveCalledTool('search_documents');
  expect(traces.totalTokens).to.equal(TOKENS_PER_RUN);
  expect(traces.totalCost).to.be.closeTo(0.0111, 1e-9);
});

// The first tool attempt fails (an ERROR span) and is retried — the case passes and its metrics are still read (#599).
test(${JSON.stringify(MATRIX_CASES.toolError.name)}, { prompt: '[tool-error] Which plans include priority support?' }, async ({ agent, traces }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include(CITATION);
  expect(traces.totalTokens).to.equal(TOKENS_PER_RUN);
});

// An LLM-judged claim — the run is started with the built-in mock judge model, so no credentials are needed.
test(${JSON.stringify(MATRIX_CASES.judged.name)}, { prompt: 'Is the refund policy explained with a source?' }, async ({ agent, judge }) => {
  const result = await agent.run();
  await judge(result, 'cites the Billing FAQ article as the source of the answer');
});

// A hard expect that does not hold → FAILED.
test(${JSON.stringify(MATRIX_CASES.fails.name)}, { prompt: '[no-answer] Can I pay by invoice?' }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include(CITATION);
});

// Soft checks: one holds, one does not; the body runs to its end and EVERY check is recorded (#621).
test(${JSON.stringify(MATRIX_CASES.soft.name)}, { prompt: 'Do you support purchase orders?' }, async ({ agent, expect }) => {
  const result = await agent.run();
  expect.soft(result.agentOutput, 'mentions purchase orders').to.include('purchase order');
  expect.soft(result.agentOutput, 'cites the knowledge base').to.include(CITATION);
  expect(result).to.haveCompletedWithin(60000);
});

// The agent is down (HTTP 500): agent.run() throws → ERRORED, never a pass/fail verdict (#598, #600).
test(${JSON.stringify(MATRIX_CASES.outage.name)}, { prompt: '[agent-500] What is the refund window?' }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include(CITATION);
});
`;

/** A second eval file: the #620 scenario (`-f other.eval.ts -n <existing>` is refused unless --force). */
export const OTHER_EVAL_SOURCE = `import { test, expect } from '@opensearch-project/agent-health';

test(${JSON.stringify(OTHER_CASE_NAME)}, { prompt: 'Where do I find my invoices?' }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include('Billing FAQ');
});
`;

export const EVAL_FILE_RELATIVE = 'evals/retrieval.eval.ts';
export const OTHER_EVAL_FILE_RELATIVE = 'evals/other.eval.ts';

export interface CreateProjectOptions {
  source: ObservabilitySource;
  prefix?: string;
  /** OpenSearch source: node URL (see `resolveRawOpenSearchEndpoint()`); required for `'opensearch'`. */
  openSearchEndpoint?: string;
}

/**
 * Stage the built package into `<project>/node_modules/@opensearch-project/agent-health`
 * and point the CLI bundle's source map back at the repo (coverage attribution).
 */
function stagePackage(projectDir: string): { cli: string; serverBundle: string } {
  for (const file of PACKAGE_FILES) {
    const src = join(REPO_ROOT, file);
    if (!existsSync(src)) throw new Error(`${src} is missing — run npm run build:all first`);
  }
  const packageDir = join(projectDir, 'node_modules', ...PACKAGE_NAME.split('/'));
  mkdirSync(packageDir, { recursive: true });
  for (const file of PACKAGE_FILES) cpSync(join(REPO_ROOT, file), join(packageDir, file), { recursive: true });
  const mapPath = join(packageDir, 'cli', 'dist', 'index.js.map');
  if (existsSync(mapPath)) {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    // esbuild's `sources` are relative to cli/dist; anchor them at the REPO's cli/dist so c8 reports repo paths.
    map.sourceRoot = join(REPO_ROOT, 'cli', 'dist') + '/';
    writeFileSync(mapPath, JSON.stringify(map));
  }
  return { cli: join(packageDir, 'bin', 'cli.js'), serverBundle: join(packageDir, 'server', 'dist', 'index.js') };
}

export async function createFileStorageEvalProject(options: CreateProjectOptions): Promise<FileStorageEvalProject> {
  const { source } = options;
  if (!existsSync(PACKAGE_ENTRY)) throw new Error(`${PACKAGE_ENTRY} is missing — run npm run build:all first (the project's config imports the package)`);
  let cloudWatch: CloudWatchLogsStub | undefined;
  let spanIndex: OpenSearchSpanIndex | undefined;
  let sink: AgentSpanSink;
  let observability: Record<string, unknown>;
  if (source === 'cloudwatch') {
    cloudWatch = await startCloudWatchLogsStub();
    sink = cloudWatch;
    observability = { type: 'cloudwatch', awsRegion: 'us-east-1' };
  } else {
    if (!options.openSearchEndpoint) throw new Error('openSearchEndpoint is required for the opensearch source');
    spanIndex = await startOpenSearchSpanIndex(options.openSearchEndpoint, { label: options.prefix ?? 'matrix' });
    sink = spanIndex;
    observability = { type: 'opensearch', endpoint: spanIndex.endpoint, authType: 'none', indexes: { traces: spanIndex.index } };
  }

  let agent: DemoRetrievalAgent | undefined;
  let dir: string | undefined;
  let port: number;
  let env: Record<string, string>;
  let staged: { cli: string; serverBundle: string };
  try {
    agent = await startDemoRetrievalAgent(sink, { serviceName: DEMO_AGENT_SERVICE_NAME });
    port = await reservePort();
    // Under the repo (gitignored `.agent-health/`), so the staged package resolves its dependencies from the repo's node_modules.
    const scratchRoot = join(REPO_ROOT, '.agent-health');
    mkdirSync(scratchRoot, { recursive: true });
    dir = mkdtempSync(join(scratchRoot, `${options.prefix ?? `matrix-${source}`}-`));
    env = projectEnv(port, source, cloudWatch?.url);
    staged = stagePackage(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'matrix-project', private: true, type: 'module' }, null, 2) + '\n');
    writeFileSync(join(dir, 'agent-health.config.ts'), configSource(agent.url, observability));
    const envKeys = ['PORT', 'AH_PORT', 'AGENT_HEALTH_STORAGE', 'BENCHMARK_RUN_RECOVERY_DISABLED', 'EVALUATION_RUN_RECOVERY_DISABLED'];
    if (source === 'cloudwatch') envKeys.push('AWS_REGION', 'AWS_ENDPOINT_URL_CLOUDWATCH_LOGS');
    writeFileSync(join(dir, '.env'), envKeys.map((k) => `${k}=${env[k]}`).join('\n') + '\n');
    mkdirSync(join(dir, 'evals'));
    writeFileSync(join(dir, EVAL_FILE_RELATIVE), RETRIEVAL_EVAL_SOURCE);
    writeFileSync(join(dir, OTHER_EVAL_FILE_RELATIVE), OTHER_EVAL_SOURCE);
  } catch (e) {
    // Nothing leaks when scaffolding fails: the listeners, the index and the half-written directory go.
    await agent?.close();
    await sink.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  let child: ChildProcess | undefined;
  let adoptedPid: number | undefined;
  const baseUrl = `http://127.0.0.1:${port}`;

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const project: FileStorageEvalProject = {
    source,
    dir,
    cli: staged.cli,
    serverBundle: staged.serverBundle,
    sink,
    cloudWatch,
    spanIndex,
    agent,
    env,
    port,
    baseUrl,
    async startServer(entry = 'cli') {
      const argv = entry === 'cli' ? [staged.cli, 'serve', '-p', String(port), '--no-browser'] : [staged.serverBundle];
      child = spawn(process.execPath, argv, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      project.serverPid = child.pid;
      let log = '';
      child.stdout?.on('data', (c) => { log += c; });
      child.stderr?.on('data', (c) => { log += c; });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${log.slice(-4000)}`);
        try {
          // Identity check: a server that fell back to another port, or a foreign
          // server already on this port, must not be mistaken for ours.
          const health = await httpJson(`${baseUrl}/health`);
          const ours = health.status === 200 && health.body?.instance?.pid === child.pid;
          if (ours) {
            const storage = await httpJson(`${baseUrl}/api/storage/health`);
            if (storage.status === 200 && storage.body?.status === 'ok') return;
          } else if (health.status === 200 && health.body?.instance?.pid) {
            throw new Error(`port ${port} is served by another agent-health process (pid ${health.body.instance.pid}, cwd ${health.body.instance.cwd})`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('port ')) throw e;
          /* not up yet */
        }
        await sleep(250);
      }
      throw new Error(`server on ${baseUrl} not healthy within 90 s:\n${log.slice(-4000)}`);
    },
    async adoptServer() {
      const health = await httpJson(`${baseUrl}/health`);
      const inst = health.body?.instance;
      if (health.status !== 200 || !inst?.pid) throw new Error(`no agent-health server answering on ${baseUrl}`);
      if (inst.cwd !== dir) throw new Error(`the server on ${baseUrl} (pid ${inst.pid}) serves ${inst.cwd}, not this project — refusing to adopt it`);
      adoptedPid = inst.pid;
      project.serverPid = inst.pid;
      return inst.pid;
    },
    async cleanup() {
      // Every step is isolated: one failure must not leak the rest (a server, the peers, the index, the directory).
      const steps: Array<[string, () => Promise<void>]> = [
        ['spawned server', async () => {
          if (!child || child.exitCode !== null || child.signalCode !== null) return;
          const exited = new Promise<void>((resolve) => child!.once('close', () => resolve()));
          child.kill('SIGTERM');
          const forceKill = setTimeout(() => { if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL'); }, 5_000);
          // Wait for the child AND its stdio pipes to be gone before the project directory is removed.
          await Promise.race([exited, sleep(10_000)]);
          clearTimeout(forceKill);
        }],
        ['auto-started server', async () => {
          // A CLI run that auto-started the server but whose suite failed before adoptServer() must not leak it.
          if (!adoptedPid && !child) await project.adoptServer().catch(() => undefined);
          if (!adoptedPid || !alive(adoptedPid)) return;
          // Re-verify ownership at kill time, not just at adoption: the pid must still be an agent-health server
          // serving THIS project (/health), or at least a live process whose cwd is this project (/proc, Linux).
          const health = await httpJson(`${baseUrl}/health`).catch(() => null);
          const stillOurs = health?.body?.instance?.pid === adoptedPid && health?.body?.instance?.cwd === dir;
          const cwdOurs = (() => { try { return realpathSync(`/proc/${adoptedPid}/cwd`) === realpathSync(dir!); } catch { return false; } })();
          if (!stillOurs && !cwdOurs) {
            console.warn(`[fileStorageEvalProject] not killing pid ${adoptedPid}: it no longer identifies as this project's server`);
            return;
          }
          try { process.kill(adoptedPid, 'SIGTERM'); } catch { /* gone */ }
          const deadline = Date.now() + 5_000;
          while (alive(adoptedPid) && Date.now() < deadline) await sleep(100);
          if (alive(adoptedPid)) { try { process.kill(adoptedPid, 'SIGKILL'); } catch { /* gone */ } }
        }],
        ['agent', () => agent!.close()],
        ['span sink', () => sink.close()],
        ['project directory', async () => { rmSync(dir!, { recursive: true, force: true }); }],
      ];
      const failures: string[] = [];
      for (const [what, step] of steps) {
        try { await step(); } catch (e) { failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (failures.length > 0) console.warn(`[fileStorageEvalProject] cleanup problems — ${failures.join('; ')}`);
    },
  };
  return project;
}
