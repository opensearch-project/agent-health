/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #655: the per-run config reload (#629) must also work when Node loads
 * `agent-health.config.ts` as a **CommonJS** module — a project whose
 * package.json says `"type": "commonjs"`. There the module cache is keyed by
 * filename, so the `?reload=<hash>` re-import returned the module loaded at
 * boot: `/api/agents` and runs kept the old agents until a restart.
 *
 * Real everything: a real server process started with the CLI bundle's
 * `serve` from a temp project (FILE storage), a real REST agent stub, the real
 * `POST /api/storage/evaluation-runs` (UI) route. Four project shapes:
 *
 *   - `"type": "commonjs"`, `.ts` config in ESM syntax, server started with
 *     `node --import tsx` (the reporter's setup; tsx transpiles to CJS);
 *   - `"type": "commonjs"`, `.ts` config in CommonJS syntax, plain `node`
 *     (built-in type stripping);
 *   - `"type": "module"`, `.ts` config, `node --import tsx` (regression guard);
 *   - `"type": "module"`, `.ts` config, plain `node` (built-in type stripping —
 *     the `npx agent-health` production path; regression guard).
 *
 * The config appends one byte to `import-count.log` every time it is
 * evaluated, so the test also pins "unchanged file ⇒ cached module" (one
 * evaluation per distinct content, none per run) for every shape.
 *
 * Red on main for both CommonJS shapes: the run after the edit still ran the
 * boot-time agent and `/api/agents` never listed the agent added to the file.
 *
 * Build first: npm run build:server && npm run build:cli (the suite builds whatever is missing).
 *
 * Run:
 *   npm run test:integration -- --testPathPatterns=uiRunConfigReloadCommonJs
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import { tmpdir } from 'os';
import * as path from 'path';

import { withCliCoverage } from '../../../helpers/cliCoverage';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLI_BUNDLE = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
/** `serve` loads the server from here (cli/utils/startServer.ts). */
const SERVER_APP_BUNDLE = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const TEST_TIMEOUT = 180_000;

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}
function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}

/** Plain `http` (not undici) — see the Jest 30 + undici loopback note in benchmarkCodeSdk. */
function httpJson<T = any>(method: string, url: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; body: T; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false, timeout: timeoutMs,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: any;
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = undefined; }
        resolve({ status: res.statusCode || 0, body: parsed, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpJson('GET', `${baseUrl}/health`, undefined, 3000);
      if (r.status === 200) return;
      last = `status ${r.status}`;
    } catch (e: any) { last = e?.message ?? String(e); }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server at ${baseUrl} did not become healthy in ${timeoutMs}ms (${last})`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/** Minimal env for the server child: no inherited AH_PORT / NODE_OPTIONS / OPENSEARCH_* → FILE storage. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR') env[k] = v;
  }
  return Object.assign(env, {
    AH_HEADLESS: '1',
    AGENT_HEALTH_STORAGE: 'file',
    BENCHMARK_RUN_RECOVERY_DISABLED: '1',
    EVALUATION_RUN_RECOVERY_DISABLED: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1',
    AH_QUIET_DEPRECATIONS: '1',
    NO_COLOR: '1',
    NODE_ENV: 'test',
  }, extra);
}

function ensureBuilt(): void {
  const scripts: Array<[string, string]> = [[CLI_BUNDLE, 'build:cli'], [SERVER_APP_BUNDLE, 'build:server']];
  for (const [file, script] of scripts) {
    if (existsSync(file)) continue;
    const b = spawnSync('npm', ['run', script], { cwd: REPO_ROOT, encoding: 'utf-8' });
    if (b.status !== 0) throw new Error(`${script} failed: ${b.stderr}`);
  }
}

type Syntax = 'esm' | 'cjs';

/** `agents.ts` next to the config: the one local module the config imports. */
function siblingModule(syntax: Syntax, version: string): string {
  const value = JSON.stringify(`Demo Agent ${version}`);
  return syntax === 'esm'
    ? `export const demoAgentName: string = ${value};\n`
    : `const demoAgentName: string = ${value};\nmodule.exports = { demoAgentName };\n`;
}

/**
 * The config (tsx or Node's type stripping handles the `.ts`). Appends one
 * byte to `import-count.log` per evaluation.
 */
function configModule(syntax: Syntax, agentEndpoint: string, siblingSpecifier: string, extraAgent: boolean): string {
  const agent = (key: string, name: string) =>
    `{ key: ${JSON.stringify(key)}, name: ${name}, connectorType: 'rest', endpoint: ${JSON.stringify(agentEndpoint)}, useTraces: false }`;
  const agents = `[
    ${agent('demo-agent', extraAgent ? "demoAgentName + ' (edited)'" : 'demoAgentName')},${extraAgent ? `
    ${agent('second-agent', "'Second Agent'")},` : ''}
  ]`;
  return syntax === 'esm'
    ? `import { appendFileSync } from 'fs';
import { demoAgentName } from ${JSON.stringify(siblingSpecifier)};
appendFileSync('import-count.log', 'x');
export default { agents: ${agents} };
`
    : `const { appendFileSync } = require('fs');
const { demoAgentName } = require(${JSON.stringify(siblingSpecifier)});
appendFileSync('import-count.log', 'x');
module.exports = { agents: ${agents} };
`;
}

interface Shape {
  name: string;
  packageType: 'commonjs' | 'module';
  /** Module syntax of the `.ts` files (Node's type stripping does not transform syntax; tsx does). */
  syntax: Syntax;
  /** Extra `node` flags before the CLI bundle. */
  nodeArgs: string[];
  /** How the config imports its sibling (`--import tsx` resolves extensionless; Node's type stripping does not). */
  siblingSpecifier: string;
  /**
   * Whether an edit to the sibling module is picked up too. CommonJS: yes when
   * Node loaded the sibling through its CommonJS loader — always under tsx,
   * and with built-in type stripping from Node 24 on; Node 22's type stripping
   * requires a CommonJS config's dependencies through the ESM loader's cache
   * (`module.children` stays empty), which nothing can evict, so there only
   * the config file itself is re-evaluated. ESM: no (documented limitation).
   */
  siblingReloads: boolean;
}

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

const SHAPES: Shape[] = [
  { name: '"type": "commonjs" + .ts config (ESM syntax), node --import tsx', packageType: 'commonjs', syntax: 'esm', nodeArgs: ['--import', TSX_LOADER], siblingSpecifier: './agents', siblingReloads: true },
  { name: '"type": "commonjs" + .ts config (CommonJS syntax), plain node (built-in type stripping)', packageType: 'commonjs', syntax: 'cjs', nodeArgs: [], siblingSpecifier: './agents.ts', siblingReloads: NODE_MAJOR >= 24 },
  { name: '"type": "module" + .ts config, node --import tsx', packageType: 'module', syntax: 'esm', nodeArgs: ['--import', TSX_LOADER], siblingSpecifier: './agents', siblingReloads: false },
  { name: '"type": "module" + .ts config, plain node (built-in type stripping)', packageType: 'module', syntax: 'esm', nodeArgs: [], siblingSpecifier: './agents.ts', siblingReloads: false },
];

describe.each(SHAPES)('UI-started runs re-evaluate an edited agent-health.config.ts without a restart — $name (#655)', ({ packageType, syntax, nodeArgs, siblingSpecifier, siblingReloads }) => {
  let project: string;
  let agentServer: Server;
  let agentEndpoint: string;
  let server: ChildProcess | undefined;
  let baseUrl: string;
  let serverLog = '';

  const configPath = () => path.join(project, 'agent-health.config.ts');
  const importCount = () => (existsSync(path.join(project, 'import-count.log')) ? readFileSync(path.join(project, 'import-count.log'), 'utf-8').length : 0);

  beforeAll(async () => {
    ensureBuilt();

    agentServer = createServer((req, res) => {
      req.on('data', () => { /* drain */ });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'stub answer' }));
      });
    });
    agentEndpoint = `http://127.0.0.1:${await listen(agentServer)}/ask`;

    project = mkdtempSync(path.join(tmpdir(), `ah-cfg-reload-${packageType}-`));
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'reload-fixture', private: true, type: packageType }));
    writeFileSync(path.join(project, 'agents.ts'), siblingModule(syntax, 'v1'));
    writeFileSync(configPath(), configModule(syntax, agentEndpoint, siblingSpecifier, false));

    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    baseUrl = `http://127.0.0.1:${port}`;

    server = spawn(process.execPath, [...nodeArgs, CLI_BUNDLE, 'serve', '-p', String(port), '--headless', '--no-browser'], {
      cwd: project,
      env: withCliCoverage(cleanEnv({ AH_PORT: String(port), PORT: String(port) })),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', c => { serverLog += c.toString(); });
    server.stderr!.on('data', c => { serverLog += c.toString(); });
    try {
      await waitForHealth(baseUrl, 60_000);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- server output ---\n${serverLog}`);
    }
    // The server answering on the reserved port is ours (the CLI falls back to another port when it is taken).
    const health = await httpJson<{ instance?: { pid?: number } }>('GET', `${baseUrl}/health`);
    expect(health.body.instance?.pid).toBe(server.pid);
    const storage = await httpJson<{ backend?: string }>('GET', `${baseUrl}/api/storage/health`);
    expect(storage.body.backend).toBe('file');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Only the exact child this suite spawned, by its captured handle.
    if (server?.pid) {
      try { server.kill('SIGTERM'); } catch { /* already gone */ }
      if (!(await waitForExit(server.pid, 8000))) {
        try { server.kill('SIGKILL'); } catch { /* noop */ }
      }
    }
    if (agentServer) await closeServer(agentServer);
    if (project) rmSync(project, { recursive: true, force: true });
  }, TEST_TIMEOUT);

  async function agentNames(): Promise<string[]> {
    const r = await httpJson<{ agents: Array<{ name: string }> }>('GET', `${baseUrl}/api/agents`);
    expect(r.status).toBe(200);
    return r.body.agents.map(a => a.name);
  }

  /** One UI-style run (SSE); returns the persisted report of the single case. */
  async function runOnce(testCaseId: string, agentKey: string): Promise<any> {
    const sse = await httpJson('POST', `${baseUrl}/api/storage/evaluation-runs`, {
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey,
      judgeModelId: 'demo-model',
      name: `config-reload ${Date.now()}`,
    }, 120_000);
    expect(sse.status).toBe(200);
    const completedLine = sse.text.split('\n').find(l => l.startsWith('data: ') && l.includes('"status":"completed"') && l.includes('"stats"'));
    if (!completedLine) throw new Error(`run did not complete:\n${sse.text}\n--- server output ---\n${serverLog}`);
    const run = JSON.parse(completedLine.slice(6));
    const report = await httpJson('GET', `${baseUrl}/api/storage/runs/${encodeURIComponent(run.results[testCaseId].reportId)}`);
    expect(report.status).toBe(200);
    return report.body.run ?? report.body;
  }

  it('a run after the edit uses the new agent list; an unchanged file is not re-evaluated', async () => {
    const tc = await httpJson('POST', `${baseUrl}/api/storage/test-cases`, {
      name: `config-reload-case-${Date.now()}`,
      category: 'general', difficulty: 'easy',
      initialPrompt: 'Hello?', expectedOutcomes: ['answers'],
    });
    expect(tc.status).toBe(201);
    const testCaseId: string = tc.body.testCase?.id ?? tc.body.id;

    // Boot: one evaluation, one agent from the file.
    expect(importCount()).toBe(1);
    expect(await agentNames()).toContain('Demo Agent v1');

    // Runs 1 and 2, nothing edited: the per-run reload reuses the cached module.
    expect((await runOnce(testCaseId, 'demo-agent')).agentName).toBe('Demo Agent v1');
    expect((await runOnce(testCaseId, 'demo-agent')).agentName).toBe('Demo Agent v1');
    expect(importCount()).toBe(1);

    // Edit while the server keeps running: rename the agent, add a second one,
    // and change the sibling module the config imports.
    writeFileSync(path.join(project, 'agents.ts'), siblingModule(syntax, 'v2'));
    writeFileSync(configPath(), configModule(syntax, agentEndpoint, siblingSpecifier, true));

    // Run 3 with the agent that only exists in the edited file.
    const third = await runOnce(testCaseId, 'second-agent');
    expect(third.agentName).toBe('Second Agent');
    expect(importCount()).toBe(2);

    // /api/agents reflects the edited file — no restart. CommonJS: the sibling
    // was re-evaluated too; ESM: the config's imports stay cached (documented).
    const names = await agentNames();
    expect(names).toContain('Second Agent');
    expect(names).toContain(siblingReloads ? 'Demo Agent v2 (edited)' : 'Demo Agent v1 (edited)');
    expect(names).not.toContain('Demo Agent v1');

    // Run 4, nothing edited since: still cached.
    expect((await runOnce(testCaseId, 'second-agent')).agentName).toBe('Second Agent');
    expect(importCount()).toBe(2);

    expect(serverLog).not.toMatch(/Unhandled|ERR_/);
  }, TEST_TIMEOUT);
});
