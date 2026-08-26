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
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { ResolvedServerConfig } from '@/lib/config/types.js';
import { decideServerOwnership, foreignServerError } from './serverOwnership.js';

// Get CLI version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// From cli/utils/dist/ go up three levels to package root, or from cli/utils/ go up two levels
const packageJsonPath = join(__dirname, '..', '..', 'package.json');

let cachedVersion: string | null = null;

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

/**
 * Wait for server to be ready on port
 */
async function waitForServer(port: number, timeout: number): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeout) {
    if (await isServerRunning(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return false;
}

interface StartServerResult {
  child: ChildProcess;
  actualPort: number;
}

/**
 * Start the Agent Health server.
 * Parses stdout to detect the actual port (which may differ from the
 * requested port if auto-increment kicked in on EADDRINUSE).
 */
export async function startServer(
  port: number,
  timeout: number
): Promise<StartServerResult> {
  const packageRoot = join(__dirname, '..', '..');
  const cliPath = join(packageRoot, 'bin', 'cli.js');
  const child = spawn('node', [cliPath, 'serve', '-p', String(port), '--no-browser'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
    },
  });

  let stderrOutput = '';
  let stdoutOutput = '';

  // Wait for the child to print its actual port before health-checking.
  // The server prints "Backend Server running on http://0.0.0.0:XXXX",
  // which may differ from the requested port due to auto-increment.
  let resolvePortDetection: (port: number) => void;
  const portDetected = new Promise<number>((resolve) => {
    resolvePortDetection = resolve;
  });

  child.stderr?.on('data', (data: Buffer) => {
    stderrOutput += data.toString();
  });
  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stdoutOutput += chunk;
    const match = chunk.match(/Backend Server running on http:\/\/0\.0\.0\.0:(\d+)/);
    if (match) {
      resolvePortDetection(parseInt(match[1], 10));
    }
  });

  let earlyExit = false;
  let exitCode: number | null = null;
  child.on('exit', (code) => {
    earlyExit = true;
    exitCode = code;
    // If the child exits before printing a port, fall back to the requested port
    resolvePortDetection(port);
  });

  child.unref();

  // Wait for either: port detected from stdout, child exit, or timeout
  const portDetectionTimeout = Math.min(timeout, 10000);
  const actualPort = await Promise.race([
    portDetected,
    new Promise<number>((resolve) => setTimeout(() => resolve(port), portDetectionTimeout)),
  ]);

  const ready = await waitForServer(actualPort, timeout);

  if (!ready) {
    try {
      child.kill();
    } catch {
      // Ignore kill errors
    }

    if (earlyExit) {
      console.error(`[ServerLifecycle] Server process exited with code ${exitCode} before becoming ready`);
    } else {
      console.error(`[ServerLifecycle] Server process did not respond to health checks within ${timeout}ms`);
    }
    if (stderrOutput) {
      console.error(`[ServerLifecycle] Server stderr:\n${stderrOutput}`);
    }
    if (stdoutOutput) {
      console.error(`[ServerLifecycle] Server stdout:\n${stdoutOutput}`);
    }
    if (!stderrOutput && !stdoutOutput) {
      console.error(`[ServerLifecycle] No output captured from server process`);
      console.error(`[ServerLifecycle] CLI path: ${cliPath}`);
      console.error(`[ServerLifecycle] Package root: ${packageRoot}`);
    }
    throw new Error(`Server failed to start within ${timeout}ms on port ${port}`);
  }

  return { child, actualPort };
}

/**
 * Stop a server process
 */
export function stopServer(process: ChildProcess): void {
  try {
    // Kill the process group (negative PID)
    if (process.pid) {
      // On Unix, kill the process group
      try {
        process.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
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
  const { port, reuseExistingServer, startTimeout } = config;
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
    if (ownership.action === 'reuse-foreign') {
      console.log(
        `[ServerLifecycle] Reusing FOREIGN server on port ${port} ` +
          `(cwd ${serverStatus.cwd}) — AH_REUSE_FOREIGN_SERVER override set.`
      );
      return { wasStarted: false, baseUrl };
    }
    if (!serverStatus.cwd) {
      console.log(
        `[ServerLifecycle] Server on port ${port} reports no instance identity ` +
          `(older build) — ownership unverifiable; proceeding with legacy reuse logic.`
      );
    }

    // Check for version mismatch
    const versionMatches = serverStatus.version === cliVersion ||
                           serverStatus.version === 'unknown' ||
                           cliVersion === 'unknown';

    if (!versionMatches) {
      console.log(`[ServerLifecycle] Version mismatch detected!`);
      console.log(`[ServerLifecycle]   Server version: ${serverStatus.version}`);
      console.log(`[ServerLifecycle]   CLI version: ${cliVersion}`);

      if (reuseExistingServer) {
        // Kill old server and start new one with matching version
        console.log(`[ServerLifecycle] Stopping old server and starting v${cliVersion}...`);
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
      console.log(`[ServerLifecycle] Reusing existing server (version ${serverStatus.version})`);
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
    console.log(`[ServerLifecycle] Port ${port} was in use, server started on port ${actualPort}`);
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
