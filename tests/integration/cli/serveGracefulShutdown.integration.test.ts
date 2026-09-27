/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: `agent-health serve` exits on SIGTERM.
 *
 * `createApp()` registers a `process.once('SIGTERM')` tracer-flush listener,
 * which replaced Node's default terminate-on-SIGTERM — so the in-process
 * `serve` used by every CLI flow that starts (and later stops) its own server
 * ignored SIGTERM entirely. `benchmark` quick/file mode, CI and
 * `--stop-server` then hung forever on the orphaned child's stdio pipes while
 * the server kept listening. Boots the real CLI `serve`, sends SIGTERM, and
 * asserts the process exits and the port is released.
 *
 * Self-contained: uses its own free port and the file storage backend.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import { existsSync } from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'cli.js');
const SERVER_APP = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const TEST_TIMEOUT = 60000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`/health on ${port} did not respond within ${timeoutMs}ms`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not exit within ${timeoutMs}ms after SIGTERM`)), timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

describe('serve — graceful shutdown on SIGTERM', () => {
  let child: ChildProcess | undefined;

  beforeAll(() => {
    if (!existsSync(SERVER_APP)) {
      execSync('npm run build:server', { cwd: REPO_ROOT, stdio: 'ignore' });
    }
  }, TEST_TIMEOUT);

  afterAll(() => {
    if (child && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
  });

  it(
    'exits (code 0) and releases its port after SIGTERM instead of living on as an orphan',
    async () => {
      const port = await freePort();
      child = spawn('node', [CLI_ENTRY, 'serve', '-p', String(port), '--headless', '--no-browser'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          AH_PORT: String(port),
          PORT: String(port),
          AGENT_HEALTH_STORAGE: 'file',
          BENCHMARK_RUN_RECOVERY_DISABLED: '1',
          EVALUATION_RUN_RECOVERY_DISABLED: '1',
        },
      });
      await waitForHealth(port, TEST_TIMEOUT - 15000);

      const exitPromise = waitForExit(child, 10000);
      child.kill('SIGTERM');
      const code = await exitPromise;
      expect(code).toBe(0);

      // Port released: the health probe now fails to connect.
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    },
    TEST_TIMEOUT
  );
});
