/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '');

  const plugins: PluginOption[] = [react()];

  // Add Istanbul instrumentation for E2E coverage collection in CI
  if (process.env.E2E_COVERAGE === 'true') {
    plugins.push(
      istanbul({
        include: ['components/*', 'hooks/*', 'lib/*', 'App.tsx', 'index.tsx'],
        exclude: ['node_modules', 'tests/', 'dist/', 'server/', 'cli/', '**/*.test.ts'],
        extension: ['.ts', '.tsx', '.js', '.jsx'],
        requireEnv: true,
        forceBuildInstrument: true,
      })
    );
  }

  return {
    plugins,
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
      'import.meta.env.TRAVEL_PLANNER_ENDPOINT': JSON.stringify(env.TRAVEL_PLANNER_ENDPOINT),
      'import.meta.env.OPENSEARCH_FETCH_DELAY_MS': JSON.stringify(env.OPENSEARCH_FETCH_DELAY_MS),
    },
    server: {
      port: parseInt(env.AH_DEV_PORT || env.AGENT_HEALTH_DEV_PORT || '4000'),
      host: true,
      // Allow the dev server to be reached through tunnel hostnames
      // (e.g. *.c.tunnels.lab.aws.dev). Vite v7 rejects unknown Host
      // headers by default. Add the explicit env override first, then
      // the lab tunnel wildcard so any *-ah-main.c.tunnels.lab.aws.dev
      // alias works without further config.
      allowedHosts: [
        ...(env.AH_ALLOWED_HOST || env.AGENT_HEALTH_ALLOWED_HOST
          ? [(env.AH_ALLOWED_HOST || env.AGENT_HEALTH_ALLOWED_HOST) as string]
          : []),
        '.tunnels.lab.aws.dev',
        'localhost',
      ],
      // The tunnel proxies HTTPS, so HMR's WS handshake must use wss
      // and the public port (443) instead of the local dev port.
      hmr: (env.AH_ALLOWED_HOST || env.AGENT_HEALTH_ALLOWED_HOST)
        ? {
            host: (env.AH_ALLOWED_HOST || env.AGENT_HEALTH_ALLOWED_HOST) as string,
            protocol: 'wss',
            clientPort: 443,
          }
        : undefined,
      proxy: {
        '/api': {
          target: `http://localhost:${env.AH_PORT || env.AGENT_HEALTH_PORT || '4001'}`,
          changeOrigin: true
        },
        '/health': {
          target: `http://localhost:${env.AH_PORT || env.AGENT_HEALTH_PORT || '4001'}`,
          changeOrigin: true
        }
      }
    }
  };
});