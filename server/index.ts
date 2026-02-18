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

// Log to verify .env is loaded
console.log('[Server] UNDICI_HEADERS_TIMEOUT from .env:', process.env.UNDICI_HEADERS_TIMEOUT);

// Re-export createApp for CLI usage
export { createApp } from './app.js';

const PORT = config.PORT;

// Configure undici timeout BEFORE starting server
(async () => {
  try {
    // @ts-ignore - undici is built into Node.js 18+
    const undici = await import('undici');
    const timeoutMs = parseInt(process.env.UNDICI_HEADERS_TIMEOUT || '300000', 10);
    undici.setGlobalDispatcher(new undici.Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    }));
    console.log(`[Server] Configured HTTP timeout: ${timeoutMs}ms (${timeoutMs/60000} minutes)`);
  } catch (e) {
    console.warn('[Server] Could not configure undici timeout:', e);
  }

  // Start server AFTER configuring timeout
  const app = createApp();

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
})();
