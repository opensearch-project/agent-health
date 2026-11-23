/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A throw-away agent-health PROJECT for CLI / e2e suites that need the exact
 * setup #640 was filed against: FILE storage (no `storage` block) and the
 * CloudWatch observability backend, authored in `agent-health.config.mjs`,
 * with a local REST agent whose spans land in a local CloudWatch Logs stub.
 *
 * The server is a REAL child process (`agent-health serve` from the built CLI
 * bundle, or `server/dist/index.js`) started with the project as its cwd, so
 * config discovery, `.env` loading, the file storage adapter under
 * `<project>/.agent-health/`, the CloudWatch reader and the AWS SDK's endpoint
 * override all run as they do for a user. Only the two network peers are
 * fakes — and they are real HTTP servers, not module mocks.
 *
 * Cleanup kills exactly the server PID this helper spawned and removes the
 * project directory (its file storage goes with it) — nothing shared is touched.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCloudWatchLogsStub, type CloudWatchLogsStub } from './cloudWatchLogsStub';
import { request as httpRequest } from 'node:http';
import { startDemoRetrievalAgent, type DemoRetrievalAgent, type SpanSink } from './demoRetrievalAgentStub';
import { startOpenSearchSpanSink, type OpenSearchSpanSink } from './openSearchSpanSink';

// `process.cwd()` rather than `__dirname`: jest (CJS) and Playwright (ESM, no
// `__dirname`) both run from the repo root.
export const REPO_ROOT = process.cwd();
export const CLI_BUNDLE = join(REPO_ROOT, 'cli', 'dist', 'index.js');
export const SERVER_BUNDLE = join(REPO_ROOT, 'server', 'dist', 'index.js');

export const DEMO_AGENT_KEY = 'demo-retrieval';
/** The run inspector derives `<agentKey>-agent` when the agent declares no `traceServiceName`. */
export const DEMO_AGENT_SERVICE_NAME = `${DEMO_AGENT_KEY}-agent`;

export interface FileStorageCloudWatchProject {
  dir: string;
  /** The CloudWatch Logs stub (CloudWatch backend) — undefined for the OpenSearch-traces variant. */
  cloudWatch?: CloudWatchLogsStub;
  /** The OpenSearch span sink (OpenSearch backend) — undefined for the CloudWatch variant. */
  openSearch?: OpenSearchSpanSink;
  /** Where the agent's spans went (whichever backend). */
  spans: SpanSink & { size(): number };
  agent: DemoRetrievalAgent;
  /** Env for every process of this project: the server and any CLI command against it. */
  env: Record<string, string>;
  port: number;
  baseUrl: string;
  /** PID of the server child this helper spawned (undefined until `startServer`). */
  serverPid?: number;
  startServer(entry?: 'cli' | 'server-bundle'): Promise<void>;
  /** Kill the spawned server (by its PID only), stop both stubs, delete the project. */
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
 * Env a user's shell would have in this project: no inherited AWS profile or
 * OpenSearch settings (file storage + the stub endpoint must win), static test
 * credentials for SigV4, and the AWS SDK's per-service endpoint override
 * pointing the CloudWatch Logs client at the stub.
 */
export function projectEnv(port: number, cloudWatchUrl: string): Record<string, string> {
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
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIATESTCLOUDWATCHSTUB',
    AWS_SECRET_ACCESS_KEY: 'test-secret-for-the-local-cloudwatch-stub',
    AWS_ENDPOINT_URL_CLOUDWATCH_LOGS: cloudWatchUrl,
    // Trace polling on the SDK path: the stub answers instantly; don't wait minutes on a miss.
    TRACE_POLL_MAX_ATTEMPTS: '3',
    TRACE_POLL_INTERVAL_MS: '500',
  });
  return env;
}

/**
 * `agent-health.config.mjs` body: one REST agent (Strategy D session id via
 * afterResponse) + the observability backend, no `storage`. CloudWatch (the
 * #640 setup) or an OpenSearch cluster whose `indexes.traces` points at a
 * throwaway `ahtest-*` index.
 */
export type TraceBackend =
  | { type: 'cloudwatch' }
  | { type: 'opensearch'; endpoint: string; tracesIndex: string };

export function configSource(agentEndpoint: string, backend: TraceBackend = { type: 'cloudwatch' }): string {
  const observability = backend.type === 'cloudwatch'
    ? `{ type: 'cloudwatch', awsRegion: 'us-east-1' }`
    : `{ type: 'opensearch', endpoint: ${JSON.stringify(backend.endpoint)}, indexes: { traces: ${JSON.stringify(`${backend.tracesIndex}*`)} } }`;
  return `// Generated by a test — FILE storage (no \`storage\` block) + ${backend.type} observability.
export default {
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
        // surface it as the connector's sessionId (Strategy D), as the issue's agent did.
        afterResponse: async (ctx) => {
          if (ctx.metadata && ctx.response && typeof ctx.response.sessionId === 'string') ctx.metadata.sessionId = ctx.response.sessionId;
          return { response: ctx.response, trajectory: ctx.trajectory, runId: ctx.runId };
        },
      },
    },
  ],
  observability: ${observability},
};
`;
}

/** The eval file the CLI runs: three cases, deterministic (no LLM judge). */
export const RETRIEVAL_EVAL_SOURCE = `const { test, expect } = require('@opensearch-project/agent-health');

// Deterministic checks only — no judge, so no model call. \`traces\` is read from
// the configured observability backend (CloudWatch) DURING the run.
test('answers from the knowledge base', { prompt: 'How long do refunds take to post?' }, async ({ agent, traces }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include('Billing FAQ');
  expect(result.trajectory).to.haveCalledTool('search_documents');
  expect(traces.totalTokens).to.equal(4050);
  expect(traces.totalCost).to.be.closeTo(0.0111, 1e-9);
});

test('a failed tool attempt is retried', { prompt: '[tool-error] Which plans include priority support?' }, async ({ agent, traces }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include('Billing FAQ');
  expect(traces.totalTokens).to.equal(4050);
});

test('flags an answer without a citation', { prompt: '[no-answer] Can I pay by invoice?' }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include('Billing FAQ');
});
`;

export const EVAL_FILE_RELATIVE = 'evals/retrieval.eval.js';

export async function createFileStorageCloudWatchProject(
  options: { prefix?: string; traces?: 'cloudwatch' | { opensearchEndpoint: string }; evalSource?: string; evalFile?: string } = {},
): Promise<FileStorageCloudWatchProject> {
  const useOpenSearch = typeof options.traces === 'object';
  const cloudWatch = useOpenSearch ? undefined : await startCloudWatchLogsStub();
  let openSearch: OpenSearchSpanSink | undefined;
  let agent: DemoRetrievalAgent | undefined;
  let dir: string | undefined;
  let port: number;
  let env: Record<string, string>;
  try {
    if (useOpenSearch) openSearch = await startOpenSearchSpanSink((options.traces as { opensearchEndpoint: string }).opensearchEndpoint);
    const spans = (cloudWatch ?? openSearch)!;
    agent = await startDemoRetrievalAgent(spans, { serviceName: DEMO_AGENT_SERVICE_NAME });
    port = await reservePort();
    dir = mkdtempSync(join(tmpdir(), `${options.prefix ?? 'ah-file-cw'}-`));
    // Without a CloudWatch stub the SDK endpoint override is simply unused.
    env = projectEnv(port, cloudWatch?.url ?? 'http://127.0.0.1:1');
    const backend: TraceBackend = openSearch
      ? { type: 'opensearch', endpoint: openSearch.endpoint, tracesIndex: openSearch.index }
      : { type: 'cloudwatch' };
    writeFileSync(join(dir, 'agent-health.config.mjs'), configSource(agent.url, backend));
    writeFileSync(
      join(dir, '.env'),
      ['PORT', 'AH_PORT', 'AGENT_HEALTH_STORAGE', 'BENCHMARK_RUN_RECOVERY_DISABLED', 'EVALUATION_RUN_RECOVERY_DISABLED', 'AWS_REGION', 'AWS_ENDPOINT_URL_CLOUDWATCH_LOGS']
        .map((k) => `${k}=${env[k]}`)
        .join('\n') + '\n'
    );
    mkdirSync(join(dir, 'evals'));
    writeFileSync(join(dir, options.evalFile ?? EVAL_FILE_RELATIVE), options.evalSource ?? RETRIEVAL_EVAL_SOURCE);
  } catch (e) {
    // Nothing leaks when scaffolding fails: both listeners and the half-written directory go.
    await agent?.close();
    await cloudWatch?.close();
    await openSearch?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  let child: ChildProcess | undefined;
  const baseUrl = `http://127.0.0.1:${port}`;

  const project: FileStorageCloudWatchProject = {
    dir,
    cloudWatch,
    openSearch,
    spans: (cloudWatch ?? openSearch)!,
    agent,
    env,
    port,
    baseUrl,
    async startServer(entry = 'cli') {
      const argv = entry === 'cli' ? [CLI_BUNDLE, 'serve', '-p', String(port), '--no-browser'] : [SERVER_BUNDLE];
      if (!existsSync(argv[0])) throw new Error(`${argv[0]} is missing — run npm run build:all first`);
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
    async cleanup() {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child!.once('close', () => resolve()));
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => { if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL'); }, 5_000);
        // Wait for the child AND its stdio pipes to be gone before the project directory is removed.
        await Promise.race([exited, sleep(10_000)]);
        clearTimeout(forceKill);
      }
      await agent!.close();
      await cloudWatch?.close();
      await openSearch?.close();
      rmSync(dir!, { recursive: true, force: true });
    },
  };
  return project;
}
