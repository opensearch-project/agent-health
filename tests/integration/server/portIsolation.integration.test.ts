/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for PORT ISOLATION (leak #1: stale AH_PORT after
 * auto-increment).
 *
 * Scenario reproduced:
 *   1. Occupy a base port with a dummy listener.
 *   2. Boot the real CLI `serve` (bin/cli.js → cli/index.ts → startServer)
 *      requesting that same base port via -p.
 *   3. The server hits EADDRINUSE and auto-increments to base+1.
 *
 * Assertion: the server's own /health `instance.port` equals the ACTUAL bound
 * port (base+1), NOT the originally requested base port. Before the fix
 * AH_PORT stayed at the requested port, so every server self-call (judge
 * proxy, assistant, traces) dialed the wrong port — potentially a foreign
 * instance such as the live demo.
 *
 * We use the CLI `serve` path (headless) because it boots via `createApp`
 * with no observio sample-agent, keeping the test fast and deterministic in
 * CI. It exercises the real startup → listen → auto-increment →
 * AH_PORT-rewrite path end to end.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import { existsSync } from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'cli.js');
const SERVER_APP = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const TEST_TIMEOUT = 60000;

/** Occupy a port with a bare TCP listener so the server must auto-increment. */
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** Wait for /health on a port to answer, returning its JSON. */
async function waitForHealth(port: number, timeoutMs: number): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`/health on ${port} did not respond within ${timeoutMs}ms`);
}

describe('Port isolation — AH_PORT tracks the actual bound port', () => {
  let dummy: net.Server | undefined;
  let child: ChildProcess | undefined;
  const BASE_PORT = 4573; // we occupy it ourselves so auto-increment is forced
  const EXPECTED_PORT = BASE_PORT + 1;

  beforeAll(() => {
    if (!existsSync(SERVER_APP)) {
      // startServer dynamically imports server/dist/app.js — build it once.
      execSync('npm run build:server', { cwd: REPO_ROOT, stdio: 'ignore' });
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* noop */ }
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
    if (dummy) await new Promise<void>((r) => dummy!.close(() => r()));
  });

  it(
    'auto-increments past an occupied port and reports the real port on /health',
    async () => {
      // 1. Occupy BASE_PORT.
      dummy = await occupyPort(BASE_PORT);

      // 2. Boot the CLI serve requesting the occupied BASE_PORT (headless ⇒ no observio).
      child = spawn(
        'node',
        [CLI_ENTRY, 'serve', '-p', String(BASE_PORT), '--headless', '--no-browser'],
        {
          cwd: REPO_ROOT,
          detached: true,
          // Ignore child output rather than pipe it: nothing consumes these
          // streams, and an unconsumed full pipe buffer can hang the child.
          stdio: 'ignore',
          env: { ...process.env, HOST: '127.0.0.1' },
        }
      );

      // 3. The server should bind EXPECTED_PORT (BASE_PORT was taken).
      const health = await waitForHealth(EXPECTED_PORT, TEST_TIMEOUT - 5000);

      expect(health.status).toBe('ok');
      expect(health.instance).toBeDefined();
      // The crux: instance.port is the ACTUAL bound port, not the requested one.
      expect(health.instance.port).toBe(EXPECTED_PORT);
      expect(health.instance.port).not.toBe(BASE_PORT);
      expect(health.instance.cwd).toBe(REPO_ROOT);
    },
    TEST_TIMEOUT
  );
});
