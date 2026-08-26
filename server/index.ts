/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend Server Entry Point
 * Handles AWS Bedrock API calls and serves as the main API server
 */

import 'dotenv/config';
import { ChildProcess } from 'child_process';
import config from './config/index.js';
import { createApp } from './app.js';
import { getStorageConfigFromFile, getObservabilityConfigFromFile, getStorageConfigFromTs, getObservabilityConfigFromTs } from './services/configService.js';
import { findObservioRoot, spawnObservioAgent, OBSERVIO_DEFAULT_PORT, resetObservioPort, isPortFree, setObservioPort, waitForObservioReady, killObservioAgent } from './services/observioAgent.js';
import { validateAwsCredentials } from './services/tracesService.js';
import { resumePendingTracePollsSafely } from './services/traceRecoveryOnBoot.js';
import { recoverOrphanBenchmarkRunsSafely } from './services/benchmarkRunRecoveryOnBoot.js';
import { getStorageModule } from './adapters/index.js';

// Register server-side connectors (subprocess, claude-code)
// This import has side effects that register connectors with the registry
import '@/services/connectors/server';

// Re-export createApp for CLI usage
export { createApp } from './app.js';

const PORT = config.PORT;
const MAX_PORT_ATTEMPTS = 10;

// Track the observio child process for cleanup on shutdown
let observioChild: ChildProcess | null = null;

/**
 * Verify that a process on the given port is actually observio by probing its
 * dedicated `/health` endpoint. The observio HTTP server exposes `GET /health`
 * (see observio-sample-agent/src/server/http_server.ts) which is a side-effect-free
 * liveness probe — unlike POST /run-agent, which goes through the full request
 * pipeline and writes audit / validation-error logs on every probe.
 *
 * Returns true only if /health responds with HTTP 200.
 */
async function isObservioResponding(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Try to auto-start the observio sample agent.
 * Always kills stale processes on the default port and spawns fresh.
 * This avoids race conditions where a dying process briefly occupies the port.
 */
async function tryStartObservioAgent(): Promise<void> {
  try {
    const root = findObservioRoot();
    if (!root) {
      console.log('  Observio sample agent: not found (skipped)');
      return;
    }

    const portFree = await isPortFree(OBSERVIO_DEFAULT_PORT);
    if (!portFree) {
      const responding = await isObservioResponding(OBSERVIO_DEFAULT_PORT);
      if (responding) {
        console.log(`  Observio sample agent: already running on port ${OBSERVIO_DEFAULT_PORT}`);
        setObservioPort(OBSERVIO_DEFAULT_PORT);
        return;
      }
      console.log(`  Observio sample agent: port ${OBSERVIO_DEFAULT_PORT} occupied by unresponsive process, killing...`);
      await killObservioAgent(OBSERVIO_DEFAULT_PORT);
      for (let i = 0; i < 10; i++) {
        if (await isPortFree(OBSERVIO_DEFAULT_PORT)) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }

    observioChild = spawnObservioAgent(root);
    if (!observioChild) {
      return; // Dependencies not installed — message already logged
    }
    console.log(`  Observio sample agent: starting (port ${OBSERVIO_DEFAULT_PORT})...`);

    observioChild.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.log(`  [observio] Exited with code ${code}`);
      }
      observioChild = null;
    });

    // Wait for observio to report its actual port before continuing
    await waitForObservioReady();
  } catch (err) {
    console.log(`  Observio sample agent: failed to start (${err instanceof Error ? err.message : err})`);
  }
}

async function startServer() {
  const app = await createApp();

  // Start observio FIRST so we know its port before serving requests
  await tryStartObservioAgent();

  // Wait for coding agent fast pass so first requests have data
  try {
    const { codingAgentRegistry } = require('./services/codingAgents');
    if (codingAgentRegistry?.waitForReady) {
      await codingAgentRegistry.waitForReady();
    }
  } catch { /* non-fatal */ }

  const tryListen = (port: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const host = process.env.HOST || '0.0.0.0';
      const server = app.listen(port, host);

      server.on('listening', () => {
        // Keep AH_PORT in lockstep with the port we actually bound. The loop
        // below auto-increments on EADDRINUSE (4001 busy → 4002 → …); without
        // this rewrite every server self-call (judge proxy, assistant,
        // traces, pi agentic judge) would keep dialing the originally
        // requested port — which may be a foreign instance such as the live
        // demo. See AGENTS.md → server lifecycle.
        process.env.AH_PORT = String(port);
        console.log(`\n  Backend Server running on http://${host}:${port}`);
        console.log(`   Health check: http://localhost:${port}/health`);
        console.log(`   AWS Region: ${process.env.AWS_REGION || 'us-west-2'}`);
        console.log(`   Bedrock Model: ${process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'}`);
        const storageEndpoint = getStorageConfigFromFile()?.endpoint
          ?? getStorageConfigFromTs()?.endpoint
          ?? process.env.OPENSEARCH_STORAGE_ENDPOINT;
        if (storageEndpoint) {
          console.log(`   OpenSearch Storage: ${storageEndpoint}`);
        } else {
          console.log(`   OpenSearch Storage: NOT CONFIGURED`);
        }

        // Proactive credential check for SigV4 clusters (non-blocking)
        const obsConfig = getObservabilityConfigFromFile() ?? getObservabilityConfigFromTs();
        if (obsConfig?.authType === 'sigv4') {
          validateAwsCredentials(obsConfig.awsProfile).then(credError => {
            if (credError) {
              console.warn(`\n  ⚠️  AWS CREDENTIALS ISSUE: ${credError}\n`);
            } else {
              console.log(`   AWS Credentials: ✓ valid (profile: ${obsConfig.awsProfile || 'default'})`);
            }
          }).catch(() => { /* non-fatal */ });
        }
        console.log('');

        // Resume orphan trace-mode polling that was lost during a restart.
        // Fire-and-forget — must never block server startup or crash on failure.
        // Runs after listen() so the poller's HTTP self-calls (asyncRunStorage)
        // can reach the local API.
        try {
          const storage = getStorageModule();
          if (storage) {
            resumePendingTracePollsSafely(storage);
            // Also fail out orphan BenchmarkRuns (status: 'running' for too long
            // with the runner long dead). Different bug class — see
            // server/services/benchmarkRunRecoveryOnBoot.ts.
            recoverOrphanBenchmarkRunsSafely(storage);
          }
        } catch (err: any) {
          console.warn(`[bootRecovery] Could not start: ${err?.message || err}`);
        }

        // Graceful shutdown — stop background timers, kill child processes, drain connections
        const shutdown = (signal: string) => {
          console.log(`\n  Received ${signal}, shutting down gracefully...`);
          // Stop the observio sample agent if we spawned it
          if (observioChild && !observioChild.killed) {
            console.log('  Stopping observio sample agent...');
            observioChild.kill('SIGTERM');
            observioChild = null;
            resetObservioPort();
          }
          try {
            const { codingAgentRegistry } = require('./services/codingAgents');
            if (codingAgentRegistry) {
              codingAgentRegistry.stopBackgroundRefresh();
            }
          } catch { /* registry may not be initialized */ }
          server.close(() => {
            console.log('  Server closed.');
            process.exit(0);
          });
          setTimeout(() => process.exit(0), 5000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        resolve();
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code === 'EADDRINUSE' && port < PORT + MAX_PORT_ATTEMPTS) {
          console.log(`  Port ${port} is in use, trying ${port + 1}...`);
          resolve(tryListen(port + 1));
        } else {
          reject(err);
        }
      });
    });
  };

  await tryListen(PORT);
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
