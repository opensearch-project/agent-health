/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Express App Factory
 * Creates and configures the Express application
 */

import express, { Express } from 'express';
import type { Server } from 'http';
import routes from './routes/index.js';
import { setupMiddleware, setupSpaFallback, setupFinalErrorHandler } from './middleware/index.js';
import { loadConfig } from '@/lib/config/index';
import { migrateYamlToJsonIfNeeded } from './services/configMigration.js';
import { getStorageConfigFromFile, getStorageConfigFromTs, setTsClusterConfig } from './services/configService.js';
import { initEvalTelemetryFromConfig } from './services/evalTelemetryBoot.js';
import { setConfiguredEvalRoots } from '@/lib/config/evalRoots';
import { getStorageConfigFromEnv } from './middleware/dataSourceConfig.js';
import { initializeStorageFromConfig } from './services/storageInitializer.js';
import { runColdStartMigrations } from './services/coldStartMigrations.js';
import { getStorageModule } from './adapters/index.js';
import { shutdownEvalTracer } from '@/lib/telemetry';
import { installGracefulShutdown, type GracefulShutdownHandle, type GracefulShutdownOptions } from './utils/gracefulShutdown.js';

// Register server-side connectors (subprocess, claude-code)
// This import has side effects that register connectors with the registry
import '@/services/connectors/server';
import { connectorRegistry } from '@/services/connectors/registry';

/**
 * Resolve storage config at startup (no request context available).
 * Priority: agent-health.config.json (file) > agent-health.config.ts (TS) >
 * OPENSEARCH_STORAGE_* env vars > null.
 */
function resolveStorageConfigAtStartup() {
  return getStorageConfigFromFile() ?? getStorageConfigFromTs() ?? getStorageConfigFromEnv() ?? null;
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
  // Migrate legacy agent-health.yaml / agent-health.config.json → .agent-health/state.json (one-time)
  await migrateYamlToJsonIfNeeded();

  const config = await loadConfig();

  // Bridge cluster config authored in agent-health.config.ts into the server's
  // runtime resolution chain (#271). In code-first mode (a .ts is present) the
  // .ts wins and the runtime state file is ignored; otherwise the state file is
  // used. Pass `null` (not undefined) for absent fields so each createApp()
  // fully resets the bridge (undefined means "leave previous value").
  setTsClusterConfig({ storage: config.storage ?? null, observability: config.observability ?? null, observabilitySources: config.observabilitySources ?? null });
  // Same bridge for `evalRoots` (where relative code-SDK `sourceFile`s are
  // resolved). `AGENT_HEALTH_EVAL_ROOTS` still wins over this at read time.
  setConfiguredEvalRoots(config.evalRoots ?? null);

  // Register user-defined connectors from config (so they work in benchmark execution)
  if (config.connectors?.length) {
    for (const connector of config.connectors) {
      connectorRegistry.register(connector);
    }
    console.log(`[app] Registered ${config.connectors.length} user connector(s) from config`);
  }

  // Initialize evaluation telemetry (OTel span emission) from the project
  // config — shared with the CLI executor (server/services/evalTelemetryBoot.ts).
  initEvalTelemetryFromConfig(config);
  // Telemetry is flushed by installAppShutdown(); createApp() itself must not
  // register signal listeners — a bare SIGTERM listener suppresses Node's
  // default termination, and a caller that only listens would never exit.

  // Swap to OpenSearch storage when configured and reachable
  await initializeStorageBackend();

  // Run idempotent cold-start migrations against whatever storage backend
  // is now active. Failures here are logged but never fatal — the server
  // can still serve requests against unmigrated data.
  try {
    const storage = getStorageModule();
    if (storage) {
      await runColdStartMigrations(storage);
    }
  } catch (err: any) {
    console.warn(`[app] Cold-start migrations failed: ${err?.message || err}`);
  }

  const app = express();

  // Setup middleware (CORS, JSON parsing, static assets)
  setupMiddleware(app);

  // Setup routes
  app.use(routes);

  // SPA fallback - must be after routes so API requests aren't intercepted
  setupSpaFallback(app);

  // Final catch-all JSON error handler - must be registered last
  setupFinalErrorHandler(app);

  return app;
}

/**
 * Wire SIGTERM/SIGINT handling for a listener serving an app from createApp():
 * stop accepting requests immediately, then drain and flush eval telemetry plus
 * entrypoint cleanup (child agents, timers), exit 0 — all bounded by the timeout.
 * Every entrypoint that calls `app.listen()` must call this on the resulting
 * server, otherwise the process does not react to termination signals the
 * same way (see server/utils/gracefulShutdown.ts).
 */
export function installAppShutdown(server: Server, options: GracefulShutdownOptions = {}): GracefulShutdownHandle {
  return installGracefulShutdown(server, {
    ...options,
    cleanup: [...(options.cleanup ?? []), shutdownEvalTracer],
  });
}

export default createApp;
