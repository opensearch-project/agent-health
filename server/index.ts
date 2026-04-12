/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend Server Entry Point
 * Handles AWS Bedrock API calls and serves as the main API server
 */

import 'dotenv/config';
import config from './config/index.js';
import { createApp } from './app.js';
import { getStorageConfigFromFile } from './services/configService.js';

// Register server-side connectors (subprocess, claude-code)
// This import has side effects that register connectors with the registry
import '@/services/connectors/server';

// Re-export createApp for CLI usage
export { createApp } from './app.js';

const PORT = config.PORT;

async function startServer() {
  const app = await createApp();

  // Wait for coding agent fast pass so first requests have data
  try {
    const { codingAgentRegistry } = require('./services/codingAgents');
    if (codingAgentRegistry?.waitForReady) {
      await codingAgentRegistry.waitForReady();
    }
  } catch { /* non-fatal */ }

  // Start server - bind to 0.0.0.0 to allow external access
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Backend Server running on http://0.0.0.0:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   AWS Region: ${process.env.AWS_REGION || 'us-west-2'}`);
    console.log(`   Bedrock Model: ${process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'}`);
    const storageEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT
      || getStorageConfigFromFile()?.endpoint;
    if (storageEndpoint) {
      console.log(`   OpenSearch Storage: ${storageEndpoint}`);
    } else {
      console.log(`   OpenSearch Storage: NOT CONFIGURED`);
    }
    console.log('');
  });

  // Graceful shutdown — stop background timers and drain connections
  const shutdown = (signal: string) => {
    console.log(`\n  Received ${signal}, shutting down gracefully...`);
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
    // Force exit after 5 seconds if connections don't drain
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
