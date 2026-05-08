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
import { getStorageConfigFromFile, getObservabilityConfigFromFile } from './services/configService.js';
import { findObservioRoot, isPortFree, spawnObservioAgent, OBSERVIO_PORT } from './services/observioAgent.js';
import { validateAwsCredentials } from './services/tracesService.js';

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
 * Try to auto-start the observio sample agent if available.
 * Fails silently — never blocks the main server.
 */
async function tryStartObservioAgent(): Promise<void> {
  try {
    const root = findObservioRoot();
    if (!root) {
      console.log('  Observio sample agent: not found (skipped)');
      return;
    }

    const free = await isPortFree(OBSERVIO_PORT);
    if (!free) {
      console.log(`  Observio sample agent: port ${OBSERVIO_PORT} already in use (skipped)`);
      return;
    }

    observioChild = spawnObservioAgent(root);
    if (!observioChild) {
      return; // Dependencies not installed — message already logged
    }
    console.log(`  Observio sample agent: starting on port ${OBSERVIO_PORT}...`);

    observioChild.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.log(`  [observio] Exited with code ${code}`);
      }
      observioChild = null;
    });
  } catch (err) {
    console.log(`  Observio sample agent: failed to start (${err instanceof Error ? err.message : err})`);
  }
}

async function startServer() {
  const app = await createApp();

  // Wait for coding agent fast pass so first requests have data
  try {
    const { codingAgentRegistry } = require('./services/codingAgents');
    if (codingAgentRegistry?.waitForReady) {
      await codingAgentRegistry.waitForReady();
    }
  } catch { /* non-fatal */ }

  const tryListen = (port: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, '0.0.0.0');

      server.on('listening', () => {
        console.log(`\n  Backend Server running on http://0.0.0.0:${port}`);
        console.log(`   Health check: http://localhost:${port}/health`);
        console.log(`   AWS Region: ${process.env.AWS_REGION || 'us-west-2'}`);
        console.log(`   Bedrock Model: ${process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'}`);
        const storageEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT
          || getStorageConfigFromFile()?.endpoint;
        if (storageEndpoint) {
          console.log(`   OpenSearch Storage: ${storageEndpoint}`);
        } else {
          console.log(`   OpenSearch Storage: NOT CONFIGURED`);
        }

        // Proactive credential check for SigV4 clusters (non-blocking)
        const obsConfig = getObservabilityConfigFromFile();
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

        // Graceful shutdown — stop background timers, kill child processes, drain connections
        const shutdown = (signal: string) => {
          console.log(`\n  Received ${signal}, shutting down gracefully...`);
          // Stop the observio sample agent if we spawned it
          if (observioChild && !observioChild.killed) {
            console.log('  Stopping observio sample agent...');
            observioChild.kill('SIGTERM');
            observioChild = null;
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

        // Auto-start the observio sample agent (non-blocking)
        tryStartObservioAgent();

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
