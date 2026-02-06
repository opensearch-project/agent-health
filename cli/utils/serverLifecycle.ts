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
 * Server status with version information
 */
export interface ServerStatus {
  /** Whether server is running */
  running: boolean;
  /** Server version (from /health endpoint) */
  version?: string;
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
        execSync(`lsof -t -i:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
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

/**
 * Start the Agent Health server
 */
export async function startServer(
  port: number,
  timeout: number
): Promise<ChildProcess> {
  // Spawn server process
  // Use the serve command which is the standard way to start the server
  // Use path.join for cross-platform compatibility
  const cliPath = path.join('bin', 'cli.js');
  const child = spawn('node', [cliPath, 'serve', '-p', String(port), '--no-browser'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      // Ensure child inherits all env vars including OpenSearch config
    },
  });

  // Unref so parent can exit independently (in non-CI mode)
  child.unref();

  // Wait for server to be ready
  const ready = await waitForServer(port, timeout);

  if (!ready) {
    // Kill the process if it didn't start in time
    try {
      child.kill();
    } catch {
      // Ignore kill errors
    }
    throw new Error(`Server failed to start within ${timeout}ms on port ${port}`);
  }

  return child;
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
  const serverProcess = await startServer(port, startTimeout);

  return {
    wasStarted: true,
    baseUrl,
    process: serverProcess,
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
