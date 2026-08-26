/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Server Startup Utility
 * Used by CLI to start the Express server
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface StartOptions {
  port: number;
  headless?: boolean;
  apiKey?: string;
}

/**
 * Find the package root by searching up for package.json
 */
function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return join(__dirname, '..');
}

const MAX_PORT_ATTEMPTS = 10;

/**
 * Start the Express server, auto-incrementing port if already in use
 */
export async function startServer(options: StartOptions): Promise<number> {
  // Set environment variables for the server (use new AH_* names; legacy
  // AGENT_HEALTH_* names are still read by the readEnv compatibility shim).
  process.env.AH_PORT = String(options.port);
  if (options.headless) process.env.AH_HEADLESS = '1';
  if (options.apiKey) process.env.AH_API_KEY = options.apiKey;

  const packageRoot = findPackageRoot();
  const serverPath = join(packageRoot, 'server', 'dist', 'app.js');
  const { createApp } = await import(serverPath);

  const app = await createApp();

  const tryListen = (port: number): Promise<number> => {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, '0.0.0.0');

      server.on('listening', () => {
        resolve(port);
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code === 'EADDRINUSE' && port <= options.port + MAX_PORT_ATTEMPTS) {
          console.log(`  Port ${port} is in use, trying ${port + 1}...`);
          resolve(tryListen(port + 1));
        } else {
          reject(err);
        }
      });
    });
  };

  const actualPort = await tryListen(options.port);
  // Keep AH_PORT in lockstep with the port we actually bound. Without this,
  // an auto-incremented server (e.g. 4001 busy → bound 4002) leaves
  // AH_PORT=4001, so every self-call (judge proxy, assistant, traces, pi
  // agentic judge) dials the *original* port — which may be a foreign
  // instance such as the live demo. See AGENTS.md → server lifecycle.
  process.env.AH_PORT = String(actualPort);
  if (actualPort !== options.port) {
    process.env.VITE_BACKEND_PORT = String(actualPort);
  }
  return actualPort;
}
