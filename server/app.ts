/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Express App Factory
 * Creates and configures the Express application
 */

import express, { Express } from 'express';
import routes from './routes/index.js';
import { setupMiddleware, setupSpaFallback } from './middleware/index.js';
import { loadConfig } from '@/lib/config/index';
import { migrateYamlToJsonIfNeeded } from './services/configMigration.js';
import { getStorageConfigFromFile, getObservabilityConfigFromFile } from './services/configService.js';
import { getStorageConfigFromEnv, getObservabilityConfigFromEnv } from './middleware/dataSourceConfig.js';
import { initializeStorageFromConfig } from './services/storageInitializer.js';
import { initEvalTracerProvider, resolveEvalTelemetryConfig, shutdownEvalTracer } from '@/lib/telemetry';
import type { OpenSearchExporterConfig } from '@/lib/telemetry';

// Register server-side connectors (subprocess, claude-code)
// This import has side effects that register connectors with the registry
import '@/services/connectors/server';
import { connectorRegistry } from '@/services/connectors/registry';

/**
 * Resolve storage config at startup (no request context available).
 * Priority: file config > environment variables > null.
 */
function resolveStorageConfigAtStartup() {
  return getStorageConfigFromFile() ?? getStorageConfigFromEnv() ?? null;
}

/**
 * If OpenSearch storage is configured, create an OpenSearchStorageModule
 * and register it as the active storage backend.
 * On failure, sets error state instead of silently falling back to file storage.
 */
async function initializeStorageBackend(): Promise<void> {
  const config = resolveStorageConfigAtStartup();
  if (!config) return;

  const state = await initializeStorageFromConfig(config, { runIndexValidation: true });
  if (state.backend === 'error') {
    console.warn(`[app] Storage configured but unreachable: ${state.error}`);
    console.warn('[app] File storage remains active. Fix the endpoint or use the Settings page to retry.');
  }
}

/**
 * Create and configure the Express application
 * Server loads its own config to ensure the cache is populated in the same
 * module scope as route handlers (fixes CLI-spawned server config isolation).
 * @returns Configured Express app
 */
export async function createApp(): Promise<Express> {
  // Migrate agent-health.yaml → agent-health.config.json if needed (one-time)
  await migrateYamlToJsonIfNeeded();

  const config = await loadConfig();

  // Register user-defined connectors from config (so they work in benchmark execution)
  if (config.connectors?.length) {
    for (const connector of config.connectors) {
      connectorRegistry.register(connector);
    }
    console.log(`[app] Registered ${config.connectors.length} user connector(s) from config`);
  }

  // Initialize evaluation telemetry (OTel span emission).
  // Prefer the observability data source for direct OpenSearch export — this
  // ensures eval spans land in the same cluster/index as agent spans.
  const obsConfig = getObservabilityConfigFromFile() ?? getObservabilityConfigFromEnv();
  let opensearchExporterConfig: OpenSearchExporterConfig | undefined;
  if (obsConfig?.endpoint) {
    opensearchExporterConfig = {
      endpoint: obsConfig.endpoint,
      username: obsConfig.username,
      password: obsConfig.password,
      tlsSkipVerify: obsConfig.tlsSkipVerify,
      indexName: 'otel-v1-apm-span',
    };
  }
  initEvalTracerProvider(resolveEvalTelemetryConfig({
    ...config.telemetry,
    opensearch: opensearchExporterConfig,
  }));
  process.once('SIGTERM', async () => { await shutdownEvalTracer(); });

  // Swap to OpenSearch storage when configured and reachable
  await initializeStorageBackend();

  const app = express();

  // Setup middleware (CORS, JSON parsing, static assets)
  setupMiddleware(app);

  // Setup routes
  app.use(routes);

  // SPA fallback - must be after routes so API requests aren't intercepted
  setupSpaFallback(app);

  return app;
}

export default createApp;
