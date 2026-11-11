/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server Lifecycle Utilities
 *
 * Manages the Agent Health server lifecycle for CLI commands.
 * Follows Playwright's webServer pattern:
 * - Dev: Reuse existing server if running
 * - CI: Start fresh server, stop after
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { ResolvedServerConfig } from '@/lib/config/types.js';
import { decideServerOwnership, foreignServerError } from './serverOwnership.js';
import { nonLoopbackBindWarning, resolveBindHost } from '../../lib/bindHost.js';
import {
  decideVersionMismatchRestart,
  parseActiveRuns,
  restartRefusedError,
  type ActiveRunsSummary,
} from './versionMismatch.js';

// Get CLI version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// From cli/utils/dist/ go up three levels to package root, or from cli/utils/ go up two levels
const packageJsonPath = join(__dirname, '..', '..', 'package.json');

let cachedVersion: string | null = null;

/**
 * Every lifecycle notice goes to stderr. stdout belongs to the command's data
 * (`report -f json --stdout`, `list --output json`) and must stay parseable.
 */
function lifecycleNotice(message: string): void {
  console.error(`[ServerLifecycle] ${message}`);
}

/**
 * Get the CLI version from package.json
 */
export function getCliVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    cachedVersion = packageJson.version || 'unknown';
  } catch {
    // Try alternative path (for compiled output)
    try {
      const altPath = join(__dirname, '..', '..', '..', 'package.json');
      const packageJson = JSON.parse(readFileSync(altPath, 'utf-8'));
      cachedVersion = packageJson.version || 'unknown';
    } catch {
      cachedVersion = 'unknown';
    }
  }

  return cachedVersion;
}

/**
 * Server status with version + instance identity information
 */
export interface ServerStatus {
  /** Whether server is running */
  running: boolean;
  /** Server version (from /health endpoint) */
  version?: string;
  /**
   * Working directory the running server was launched from (from
   * /health `instance.cwd`). Absent for older servers that predate the
   * identity block. Used to detect a *foreign* server (a different
   * checkout/instance) before reusing or killing it.
   */
  cwd?: string;
  /** PID of the running server (from /health `instance.pid`). */
  pid?: number;
  /**
   * Runs the server process is executing right now (from /health
   * `activeRuns`, read from its in-memory executor registries). Absent for
   * older servers that predate the field — then we cannot tell, and a
   * version-mismatch restart is refused rather than risked.
   */
  activeRuns?: ActiveRunsSummary;
}

/**
 * Result of ensuring server is running
 */
export interface EnsureServerResult {
  /** Whether a new server was started (false if reused existing) */
  wasStarted: boolean;
  /** Base URL of the server */
  baseUrl: string;
  /** Child process if server was started (for cleanup in CI) */
  process?: ChildProcess;
}

/**
 * Check if a server is running on the specified port
 * Uses HTTP health check for reliability (TCP socket can give false negatives)
 */
export async function isServerRunning(port: number): Promise<boolean> {
  // First try HTTP health check (most reliable)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });

    if (response.ok) {
      return true;
    }
  } catch {
    // Health check failed, fall back to TCP check
  } finally {
    clearTimeout(timeout);
  }

  // Fall back to TCP socket check
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      resolve(false);
    });

    socket.connect(port, 'localhost');
  });
}

/**
 * Check server status including version
 * Returns running status and version from /health endpoint
 */
export async function checkServerStatus(port: number): Promise<ServerStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });

    if (response.ok) {
      const data = await response.json();
      return {
        running: true,
        version: data.version,
        cwd: data.instance?.cwd,
        pid: data.instance?.pid,
        activeRuns: parseActiveRuns(data.activeRuns),
      };
    }
  } catch {
    // Server status check failed
  } finally {
    clearTimeout(timeout);
  }

  return { running: false };
}

/**
 * Kill any process running on the specified port
 * Cross-platform: uses lsof on Unix, netstat on Windows
 */
export async function killServerOnPort(port: number): Promise<void> {

  try {
    if (process.platform !== 'win32') {
      // Unix/Mac: use lsof to find and kill process
      try {
        execSync(`lsof -t -i:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      } catch {
        // Ignore errors - process may not exist
      }
    } else {
      // Windows: use netstat and taskkill
      try {
        const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
        const lines = result.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(parseInt(pid))) {
            try {
              execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
            } catch {
              // Ignore - process may already be dead
            }
          }
        }
      } catch {
        // Ignore - no process on port
      }
    }

    // Wait for port to be free with retry loop
    const maxRetries = 10;
    const retryDelay = 500;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise(r => setTimeout(r, retryDelay));
      const stillRunning = await isServerRunning(port);
      if (!stillRunning) {
        return;
      }
    }
    console.warn(`[ServerLifecycle] Port ${port} may still be in use after ${maxRetries} retries`);
  } catch {
    // Ignore errors during cleanup
  }
}

/** Read only the end of a startup log; a noisy child must not exhaust CLI memory. */
function readLogTail(logPath: string): string {
  const fd = openSync(logPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    const bytes = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString('utf8', 0, bytes);
  } finally {
    closeSync(fd);
  }
}

function openServerLog(port: number): { logPath: string; logFd: number } {
  const name = `server-${port}-${Date.now()}-${process.pid}.log`;
  const openIn = (directory: string) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const logPath = join(directory, name);
    return { logPath, logFd: openSync(logPath, 'wx', 0o600) };
  };
  try {
    return openIn(join(process.cwd(), '.agent-health', 'logs'));
  } catch {
    // A read-only checkout must not prevent a CLI command from starting. An
    // atomically-created private directory avoids trusting a pre-existing path
    // in shared /tmp; include the user id for attribution, not authorization.
    const privateDir = mkdtempSync(join(tmpdir(), `agent-health-${process.getuid?.() ?? 'user'}-`));
    return openIn(join(privateDir, 'logs'));
  }
}

interface StartServerResult {
  child: ChildProcess;
  actualPort: number;
}

/**
 * Start a persistent server with file-backed output, not pipes owned by the CLI.
 * The short-lived IPC channel reports the actual bound port, then disconnects.
 * Neither the child handle nor its output may keep the calling command alive.
 */
export async function startServer(
  port: number,
  timeout: number
): Promise<StartServerResult> {
  const cliPath = join(__dirname, '..', '..', 'bin', 'cli.js');
  const { logPath, logFd } = openServerLog(port);
  lifecycleNotice(`Server log: ${logPath}`);
  // The child inherits AH_HOST and warns in its own (file) log; say it here
  // too, where the user running `benchmark` / `run` actually looks.
  const bindWarning = nonLoopbackBindWarning(resolveBindHost(undefined, process.env));
  if (bindWarning) lifecycleNotice(bindWarning);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [cliPath, 'serve', '-p', String(port), '--no-browser'], {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: { ...process.env },
    });
  } finally {
    // The child has its own copies. Closing ours does not close its log output.
    closeSync(logFd);
  }
  child.unref();

  try {
    const actualPort = await new Promise<number>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      };
      const onMessage = (message: unknown) => {
        const ready = message as { type?: string; port?: number } | null;
        if (ready?.type !== 'agent-health:server-ready' ||
            !Number.isInteger(ready.port) || ready.port! < 1 || ready.port! > 65535) return;
        cleanup();
        resolve(ready.port!);
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`Server process exited before becoming ready (code ${code}, signal ${signal})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Server failed to start within ${timeout}ms on port ${port}`));
      }, timeout);
      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);
    });
    return { child, actualPort };
  } catch (error) {
    // Startup failed; kill only the exact child we created, never a port owner.
    child.kill('SIGKILL');
    lifecycleNotice(`Server log: ${logPath}`);
    try {
      const output = readLogTail(logPath);
      if (output) lifecycleNotice(`Server output (last 64 KiB):\n${output}`);
    } catch {
      // Preserve the startup error even if its log is no longer readable.
    }
    throw error;
  } finally {
    if (child.connected) child.disconnect();
  }
}

/**
 * Stop a server process
 */
export function stopServer(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  // Preserve the synchronous cleanup API, but keep Node alive until this exact
  // child exits. SIGTERM alone is insufficient if its handler stalls or ignores
  // shutdown. The server has a 5s graceful deadline; allow it 7s before escalation.
  child.ref();
  const finish = () => {
    clearTimeout(escalate);
    child.removeListener('exit', finish);
    child.removeListener('error', onError);
    child.unref();
  };
  const onError = (error: Error) => {
    lifecycleNotice(`Could not stop child ${child.pid}: ${error.message}`);
    finish();
  };
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 7000);
  child.once('exit', finish);
  child.once('error', onError);
  child.kill('SIGTERM');
}

/**
 * Ensure server is running based on configuration
 *
 * Behavior:
 * - If server running + reuseExistingServer=true: Reuse it
 * - If server running + reuseExistingServer=false: Error
 * - If server not running: Start it
 *
 * @param config - Server configuration
 * @returns Result with server info
 */
export async function ensureServer(
  config: ResolvedServerConfig
): Promise<EnsureServerResult> {
  const { port, reuseExistingServer, startTimeout, readOnly } = config;
  const baseUrl = `http://localhost:${port}`;

  // Check if server is already running and get version
  const serverStatus = await checkServerStatus(port);
  const cliVersion = getCliVersion();

  if (serverStatus.running) {
    // ── Ownership guard ───────────────────────────────────────────────
    // Before any reuse/version logic, decide whether the server on this
    // port is *ours* (same checkout) or a FOREIGN instance — e.g. a live
    // demo / another worktree that merely happens to occupy the port.
    // Without this, a version mismatch would `killServerOnPort()` and take
    // down that foreign server, and a version match would silently route
    // every benchmark/run/report into its storage. Both are data-corruption
    // hazards. See AGENTS.md → server lifecycle.
    const myCwd = process.cwd();
    const allowForeign =
      process.env.AH_REUSE_FOREIGN_SERVER === '1' ||
      process.env.AH_REUSE_FOREIGN_SERVER === 'true';
    const ownership = decideServerOwnership({
      serverCwd: serverStatus.cwd,
      myCwd,
      allowForeign,
      readOnly,
    });

    if (ownership.action === 'refuse') {
      throw new Error(
        foreignServerError({
          port,
          myCwd,
          serverCwd: serverStatus.cwd,
          serverPid: serverStatus.pid,
        })
      );
    }
    if (ownership.action === 'reuse-foreign-readonly') {
      lifecycleNotice(
        `Reusing FOREIGN server on port ${port} in read-only mode ` +
          `(cwd ${serverStatus.cwd}, no writes will be issued).`
      );
      return { wasStarted: false, baseUrl };
    }
    if (ownership.action === 'reuse-foreign') {
      lifecycleNotice(
        `Reusing FOREIGN server on port ${port} ` +
          `(cwd ${serverStatus.cwd}) — AH_REUSE_FOREIGN_SERVER override set.`
      );
      return { wasStarted: false, baseUrl };
    }
    if (!serverStatus.cwd) {
      lifecycleNotice(
        `Server on port ${port} reports no instance identity ` +
          `(older build) — ownership unverifiable; proceeding with legacy reuse logic.`
      );
    }

    // Check for version mismatch
    const versionMatches = serverStatus.version === cliVersion ||
                           serverStatus.version === 'unknown' ||
                           cliVersion === 'unknown';

    if (!versionMatches) {
      lifecycleNotice(`Version mismatch detected!`);
      lifecycleNotice(`  Server version: ${serverStatus.version}`);
      lifecycleNotice(`  CLI version: ${cliVersion}`);

      if (reuseExistingServer) {
        // Restarting kills whatever the old server is executing. Only do it
        // when the server itself says nothing is in flight (#612): its
        // in-memory registries, not storage status, which can hold stale
        // `running` docs from crashed processes that would block forever.
        const decision = decideVersionMismatchRestart({ activeRuns: serverStatus.activeRuns });
        if (decision.action === 'refuse') {
          throw new Error(
            restartRefusedError({
              port,
              serverVersion: serverStatus.version,
              cliVersion,
              serverPid: serverStatus.pid,
              decision,
            })
          );
        }
        // Kill old server and start new one with matching version
        lifecycleNotice(`Stopping old server and starting v${cliVersion}...`);
        await killServerOnPort(port);
        // Fall through to start new server below
      } else {
        // In CI mode, error out on version mismatch
        throw new Error(
          `Server version mismatch: server=${serverStatus.version}, CLI=${cliVersion}. ` +
            `Stop the existing server or upgrade to matching version.`
        );
      }
    } else if (reuseExistingServer) {
      // Versions match - safe to reuse
      lifecycleNotice(`Reusing existing server (version ${serverStatus.version})`);
      return {
        wasStarted: false,
        baseUrl,
      };
    } else {
      // In CI mode, don't reuse - error out
      throw new Error(
        `Server already running on port ${port}. ` +
          `In CI mode (reuseExistingServer=false), this is an error. ` +
          `Stop the existing server or set reuseExistingServer: true.`
      );
    }
  }

  // Server not running (or was killed due to version mismatch) - start it
  const { child, actualPort } = await startServer(port, startTimeout);

  if (actualPort !== port) {
    lifecycleNotice(`Port ${port} was in use, server started on port ${actualPort}`);
  }

  return {
    wasStarted: true,
    baseUrl: `http://localhost:${actualPort}`,
    process: child,
  };
}

/**
 * Create a cleanup function for CI mode
 *
 * In CI mode, we want to stop the server after the CLI command completes.
 * This returns a cleanup function that should be called in a finally block.
 */
export function createServerCleanup(
  result: EnsureServerResult,
  isCI: boolean
): () => void {
  return () => {
    // Only cleanup if we started the server AND we're in CI mode
    if (result.wasStarted && isCI && result.process) {
      stopServer(result.process);
    }
  };
}
