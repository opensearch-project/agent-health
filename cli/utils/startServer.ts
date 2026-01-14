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

/**
 * Start the Express server
 */
export async function startServer(options: StartOptions): Promise<void> {
  // Set environment variables for the server
  process.env.VITE_BACKEND_PORT = String(options.port);

  // Dynamic import the server module from package root
  // Using computed path prevents esbuild from bundling server code into CLI
  const packageRoot = findPackageRoot();
  const serverPath = join(packageRoot, 'server', 'dist', 'app.js');
  const { createApp } = await import(serverPath);

  const app = createApp();

  return new Promise((resolve) => {
    app.listen(options.port, '0.0.0.0', () => {
      resolve();
    });
  });
}
