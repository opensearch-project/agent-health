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
import { isStorageConfigured } from './services/opensearchClient.js';
import { loadConfig } from '@/lib/config/index.js';

// Register server-side connectors (subprocess, claude-code)
// This import has side effects that register connectors with the registry
import '@/services/connectors/server';

// Re-export createApp for CLI usage
export { createApp } from './app.js';

const PORT = config.PORT;

// Load config asynchronously before starting the server
// This ensures loadConfigSync() has cached config available
async function startServer() {
  // Load config FIRST before creating the app (routes use loadConfigSync)
  await loadConfig();

  const app = createApp();

  // Start server - bind to 0.0.0.0 to allow external access
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Backend Server running on http://0.0.0.0:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   AWS Region: ${process.env.AWS_REGION || 'us-west-2'}`);
    console.log(`   Bedrock Model: ${process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'}`);
    if (isStorageConfigured()) {
      console.log(`   OpenSearch Storage: ${process.env.OPENSEARCH_STORAGE_ENDPOINT}`);
    } else {
      console.log(`   OpenSearch Storage: NOT CONFIGURED`);
    }
    console.log('');
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
