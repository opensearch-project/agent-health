/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Server Startup Utility
 * Used by all CLI commands to start the Express server
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import type { CLIConfig } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
 * Start the Express server with CLI config
 * Sets environment variables and creates the app instance
 */
export async function startServer(config: CLIConfig): Promise<void> {
  // Set environment variables for the server
  process.env.CLI_MODE = config.mode;
  process.env.VITE_BACKEND_PORT = String(config.port);
  process.env.AGENT_TYPE = config.agent.type;
  process.env.JUDGE_TYPE = config.judge.type;

  // Storage configuration (optional)
  if (config.storage?.endpoint) {
    process.env.OPENSEARCH_STORAGE_ENDPOINT = config.storage.endpoint;
  }
  if (config.storage?.username) {
    process.env.OPENSEARCH_STORAGE_USERNAME = config.storage.username;
  }
  if (config.storage?.password) {
    process.env.OPENSEARCH_STORAGE_PASSWORD = config.storage.password;
  }

  // Agent configuration
  if (config.agent.endpoint) {
    process.env.MLCOMMONS_ENDPOINT = config.agent.endpoint;
  }

  // Judge configuration
  if (config.judge.region) {
    process.env.AWS_REGION = config.judge.region;
  }
  if (config.judge.modelId) {
    process.env.BEDROCK_MODEL_ID = config.judge.modelId;
  }

  // Traces configuration
  if (config.traces) {
    if (config.traces.endpoint) {
      process.env.OPENSEARCH_LOGS_ENDPOINT = config.traces.endpoint;
    }
    if (config.traces.index) {
      process.env.OPENSEARCH_LOGS_TRACES_INDEX = config.traces.index;
    }
  }

  // Dynamic import the server module from package root
  // Using computed path prevents esbuild from bundling server code into CLI
  const packageRoot = findPackageRoot();
  const serverPath = join(packageRoot, 'server', 'dist', 'app.js');
  const { createApp } = await import(serverPath);

  const app = createApp(config);

  return new Promise((resolve) => {
    app.listen(config.port, '0.0.0.0', () => {
      resolve();
    });
  });
}
