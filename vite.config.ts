/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './')
      }
    },
    // Manually expose environment variables without VITE_ prefix
    define: {
      'import.meta.env.AGENT_ENDPOINT': JSON.stringify(env.AGENT_ENDPOINT),
      'import.meta.env.AGENT_PROXY_URL': JSON.stringify(env.AGENT_PROXY_URL),
      'import.meta.env.AWS_REGION': JSON.stringify(env.AWS_REGION),
      'import.meta.env.AWS_PROFILE': JSON.stringify(env.AWS_PROFILE),
      'import.meta.env.BEDROCK_MODEL_ID': JSON.stringify(env.BEDROCK_MODEL_ID),
      'import.meta.env.JUDGE_API_URL': JSON.stringify(env.JUDGE_API_URL),
      'import.meta.env.OPENSEARCH_ENDPOINT': JSON.stringify(env.OPENSEARCH_ENDPOINT),
      'import.meta.env.OPENSEARCH_USERNAME': JSON.stringify(env.OPENSEARCH_USERNAME),
      'import.meta.env.OPENSEARCH_PASSWORD': JSON.stringify(env.OPENSEARCH_PASSWORD),
      'import.meta.env.OPENSEARCH_INDEX_PREFIX': JSON.stringify(env.OPENSEARCH_INDEX_PREFIX),
      'import.meta.env.OPENSEARCH_TIME_RANGE_MINUTES': JSON.stringify(env.OPENSEARCH_TIME_RANGE_MINUTES),
      // Per-agent endpoints
      'import.meta.env.LANGGRAPH_ENDPOINT': JSON.stringify(env.LANGGRAPH_ENDPOINT),
      'import.meta.env.MLCOMMONS_ENDPOINT': JSON.stringify(env.MLCOMMONS_ENDPOINT),
      'import.meta.env.OPENSEARCH_FETCH_DELAY_MS': JSON.stringify(env.OPENSEARCH_FETCH_DELAY_MS),
      // ML-Commons agent headers (for agent to access data source)
      'import.meta.env.MLCOMMONS_HEADER_OPENSEARCH_URL': JSON.stringify(env.MLCOMMONS_HEADER_OPENSEARCH_URL),
      'import.meta.env.MLCOMMONS_HEADER_AUTHORIZATION': JSON.stringify(env.MLCOMMONS_HEADER_AUTHORIZATION),
      'import.meta.env.MLCOMMONS_HEADER_AWS_REGION': JSON.stringify(env.MLCOMMONS_HEADER_AWS_REGION),
      'import.meta.env.MLCOMMONS_HEADER_AWS_SERVICE_NAME': JSON.stringify(env.MLCOMMONS_HEADER_AWS_SERVICE_NAME),
      'import.meta.env.MLCOMMONS_HEADER_AWS_ACCESS_KEY_ID': JSON.stringify(env.MLCOMMONS_HEADER_AWS_ACCESS_KEY_ID),
      'import.meta.env.MLCOMMONS_HEADER_AWS_SECRET_ACCESS_KEY': JSON.stringify(env.MLCOMMONS_HEADER_AWS_SECRET_ACCESS_KEY),
      'import.meta.env.MLCOMMONS_HEADER_AWS_SESSION_TOKEN': JSON.stringify(env.MLCOMMONS_HEADER_AWS_SESSION_TOKEN),
      // Legacy: Agent endpoint headers (kept for backward compatibility)
      'import.meta.env.AGENT_HEADER_OPENSEARCH_URL': JSON.stringify(env.AGENT_HEADER_OPENSEARCH_URL),
      'import.meta.env.AGENT_HEADER_AWS_REGION': JSON.stringify(env.AGENT_HEADER_AWS_REGION),
      'import.meta.env.AGENT_HEADER_AWS_SERVICE_NAME': JSON.stringify(env.AGENT_HEADER_AWS_SERVICE_NAME),
      'import.meta.env.AGENT_HEADER_AWS_ACCESS_KEY_ID': JSON.stringify(env.AGENT_HEADER_AWS_ACCESS_KEY_ID),
      'import.meta.env.AGENT_HEADER_AWS_SECRET_ACCESS_KEY': JSON.stringify(env.AGENT_HEADER_AWS_SECRET_ACCESS_KEY),
      'import.meta.env.AGENT_HEADER_AWS_SESSION_TOKEN': JSON.stringify(env.AGENT_HEADER_AWS_SESSION_TOKEN),
    },
    server: {
      port: 4000,
      host: true,
      proxy: {
        '/api': {
          target: 'http://localhost:4001',
          changeOrigin: true
        }
      }
    }
  };
});