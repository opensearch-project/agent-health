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
  // Set environment variables for the server
  process.env.AGENT_HEALTH_PORT = String(options.port);
  if (options.headless) process.env.AGENT_HEALTH_HEADLESS = '1';
  if (options.apiKey) process.env.AGENT_HEALTH_API_KEY = options.apiKey;

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
  if (actualPort !== options.port) {
    process.env.VITE_BACKEND_PORT = String(actualPort);
  }
  return actualPort;
}
