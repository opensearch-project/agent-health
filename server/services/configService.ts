/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration Service
 *
 * Manages server-side data-source configuration. In ui-first mode this lives in
 * `.agent-health/state.json` (runtime state, project + user scoped); in
 * code-first mode (an agent-health.config.ts exists) the state file is ignored
 * and the .ts is authoritative.
 * Provides secure credential storage without browser exposure.
 *
 * Reads/writes go through lib/config/statePaths (the single owner of paths +
 * mode + layered read/write); other state owners (customAgentStore, debug,
 * remoteServers) route through the same module so there is no split-brain.
 */

import fs from 'fs';
import { getStorageState, type StorageBackend } from '../adapters/index.js';
import { configToCacheKey } from './opensearchClientFactory.js';
import {
  readLayeredState,
  readStateScope,
  writeStateScope,
  isCodeFirstMode,
  projectStatePath,
  userStatePath,
} from '@/lib/config/statePaths';
import { getEvalRootsStatus, type EvalRootsStatus } from '@/lib/config/evalRoots';
import type { StorageClusterConfig, ObservabilityClusterConfig, ClusterAuthType } from '../../types/index.js';

// Type for the config file sections owned by this module
interface ConfigFileDataSources {
  storage?: {
    endpoint: string;
    authType?: ClusterAuthType;
    username?: string;
    password?: string;
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
    tlsSkipVerify?: boolean;
  };
  observability?: {
    endpoint: string;
    authType?: ClusterAuthType;
    username?: string;
    password?: string;
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
    tlsSkipVerify?: boolean;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
}

// Config status returned to frontend (no raw credentials — username is safe to expose,
// password is indicated only as a boolean so the UI can show placeholder dots)
/**
 * Where a resolved data-source config came from.
 * - 'file'        : .agent-health/state.json runtime state (ui-first; UI-writable)
 * - 'typescript'  : agent-health.config.ts via defineConfig() (committed default)
 * - 'environment' : OPENSEARCH_* env vars
 * - 'none'        : not configured (file-based fallback)
 */
export type ConfigSource = 'file' | 'typescript' | 'environment' | 'none';

export interface ConfigStatus {
  storage: {
    configured: boolean;
    source: ConfigSource;
    endpoint?: string;
    authType?: ClusterAuthType;
    username?: string;    // Safe to return; lets the form pre-fill the username
    hasPassword?: boolean; // True when a password is stored; never return the value itself
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
  };
  observability: {
    configured: boolean;
    source: ConfigSource;
    endpoint?: string;
    authType?: ClusterAuthType;
    username?: string;
    hasPassword?: boolean;
    awsProfile?: string;
    awsRegion?: string;
    awsService?: 'es' | 'aoss';
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
  runtime?: {
    storage: {
      backend: StorageBackend;
      error: string | null;
      configuredEndpoint: string | null;
      drifted: boolean;
    };
  };
  /** Where relative code-SDK `sourceFile`s are resolved (see lib/config/evalRoots.ts). */
  evalRoots?: EvalRootsStatus;
  warnings?: string[];
}

// ============================================================================
// TypeScript config bridge (agent-health.config.ts -> server)
// ============================================================================
//
// The CLI-launched server loads the user's agent-health.config.ts in-process
// (server/app.ts -> loadConfig()). Storage / observability cluster config
// authored there is handed to this module via setTsClusterConfig() so the
// runtime resolution chain can consult it. This is the "single TS source of
// truth" path requested in #261.
//
// Precedence: code-first (an agent-health.config.ts exists) -> .ts wins and the
// state file is ignored; otherwise (ui-first) -> .agent-health/state.json ->
// OPENSEARCH_* env -> file-based fallback. (getConfigStatus resolves ts > state > env.)

let tsStorageConfig: StorageClusterConfig | null = null;
let tsObservabilityConfig: ObservabilityClusterConfig | null = null;

/**
 * Register cluster config authored in agent-health.config.ts.
 * Called once at server startup with the in-process resolved TS config.
 * Pass `null`/omit a field to leave it unset; an endpoint-less object is
 * treated as "not configured".
 */
export function setTsClusterConfig(opts: {
  storage?: StorageClusterConfig | null;
  observability?: ObservabilityClusterConfig | null;
}): void {
  if (opts.storage !== undefined) {
    tsStorageConfig = opts.storage && opts.storage.endpoint ? opts.storage : null;
  }
  if (opts.observability !== undefined) {
    tsObservabilityConfig = opts.observability && opts.observability.endpoint ? opts.observability : null;
  }
}

/** Storage cluster config authored in agent-health.config.ts, or null. */
export function getStorageConfigFromTs(): StorageClusterConfig | null {
  return tsStorageConfig;
}

/** Observability cluster config authored in agent-health.config.ts, or null. */
export function getObservabilityConfigFromTs(): ObservabilityClusterConfig | null {
  return tsObservabilityConfig;
}

/** Test-only: reset the TS config holder between cases. */
export function __resetTsClusterConfigForTests(): void {
  tsStorageConfig = null;
  tsObservabilityConfig = null;
}

/**
 * Read the effective runtime state (config v2).
 *
 * Reads go through the layered state resolver (project `.agent-health/state.json`
 * over user `~/.agent-health/state.json`). In code-first mode (an
 * `agent-health.config.ts` is present) this returns `{}`, so storage/observability
 * fall through to the authored `.ts` config (the strict "state ignored" rule).
 */
function readConfigFromDisk(): Record<string, unknown> {
  return readLayeredState();
}

// ============================================================================
// Storage Configuration
// ============================================================================

/**
 * Get storage configuration from the runtime state file.
 * Returns null if not configured (or in code-first mode — state is ignored).
 */
export function getStorageConfigFromFile(): StorageClusterConfig | null {
  const config = readConfigFromDisk() as ConfigFileDataSources;

  if (!config?.storage?.endpoint) {
    return null;
  }

  return {
    endpoint: config.storage.endpoint,
    authType: config.storage.authType,
    username: config.storage.username,
    password: config.storage.password,
    awsProfile: config.storage.awsProfile,
    awsRegion: config.storage.awsRegion,
    awsService: config.storage.awsService,
    tlsSkipVerify: config.storage.tlsSkipVerify,
  };
}

/**
 * Save storage configuration to file
 */
export function saveStorageConfig(storageConfig: StorageClusterConfig): void {
  // Merge against the project-scope state file (the write target). Throws in
  // code-first mode via writeStateScope below.
  const existingStorage = (readStateScope('project').storage as any) || {};

  // Use ?? so that an absent/undefined field in the incoming payload falls back
  // to whatever is already stored. The form converts sentinel and empty values
  // to undefined before sending. Note: if called directly with password: "",
  // the empty string passes through ?? but is omitted by the falsy spread
  // below, effectively clearing the stored credential. This is intentional.
  const resolvedUsername = storageConfig.username ?? existingStorage.username;
  const resolvedPassword = storageConfig.password ?? existingStorage.password;

  const storage = {
    endpoint: storageConfig.endpoint,
    ...(storageConfig.authType && { authType: storageConfig.authType }),
    ...(resolvedUsername && { username: resolvedUsername }),
    ...(resolvedPassword && { password: resolvedPassword }),
    ...(storageConfig.awsProfile && { awsProfile: storageConfig.awsProfile }),
    ...(storageConfig.awsRegion && { awsRegion: storageConfig.awsRegion }),
    ...(storageConfig.awsService && { awsService: storageConfig.awsService }),
    ...(storageConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: storageConfig.tlsSkipVerify }),
  };

  writeStateScope({ storage }, 'project');
}

/**
 * Clear storage configuration from file
 */
export function clearStorageConfig(): void {
  // Deleting the key removes it from the project state file, preserving
  // siblings. Throws in code-first mode (state is managed by the .ts).
  writeStateScope({ storage: undefined }, 'project');
}

// ============================================================================
// Observability Configuration
// ============================================================================

/**
 * Get observability configuration from file
 * Returns null if not configured in file
 */
export function getObservabilityConfigFromFile(): ObservabilityClusterConfig | null {
  const config = readConfigFromDisk() as ConfigFileDataSources;

  if (!config?.observability?.endpoint) {
    return null;
  }

  return {
    endpoint: config.observability.endpoint,
    authType: config.observability.authType,
    username: config.observability.username,
    password: config.observability.password,
    awsProfile: config.observability.awsProfile,
    awsRegion: config.observability.awsRegion,
    awsService: config.observability.awsService,
    tlsSkipVerify: config.observability.tlsSkipVerify,
    indexes: config.observability.indexes,
  };
}

/**
 * Save observability configuration to file
 */
export function saveObservabilityConfig(obsConfig: ObservabilityClusterConfig): void {
  const existingObs = (readStateScope('project').observability as any) || {};

  // Use ?? so that an absent/undefined field in the incoming payload falls back
  // to whatever is already stored.
  const resolvedUsername = obsConfig.username ?? existingObs.username;
  const resolvedPassword = obsConfig.password ?? existingObs.password;

  const observability = {
    endpoint: obsConfig.endpoint,
    ...(obsConfig.authType && { authType: obsConfig.authType }),
    ...(resolvedUsername && { username: resolvedUsername }),
    ...(resolvedPassword && { password: resolvedPassword }),
    ...(obsConfig.awsProfile && { awsProfile: obsConfig.awsProfile }),
    ...(obsConfig.awsRegion && { awsRegion: obsConfig.awsRegion }),
    ...(obsConfig.awsService && { awsService: obsConfig.awsService }),
    ...(obsConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: obsConfig.tlsSkipVerify }),
    ...(obsConfig.indexes && Object.keys(obsConfig.indexes).length > 0 && {
      indexes: obsConfig.indexes,
    }),
  };

  writeStateScope({ observability }, 'project');
}

/**
 * Clear observability configuration from file
 */
export function clearObservabilityConfig(): void {
  writeStateScope({ observability: undefined }, 'project');
}

// ============================================================================
// Config Status (for frontend display)
// ============================================================================

// Logged at most once per server process: GET /api/storage/config/status is
// polled by the UI (Dashboard's useDataState, SettingsPage) on every page
// visit, not just at server startup, so without this guard a persistent
// zero-agents config would re-log the same WARNING on every request/poll.
// The returned warnings[] field itself is NOT gated -- the API response
// always reflects live state; only the server-log noise is deduplicated.
let zeroAgentsWarningLogged = false;

/**
 * Get configuration status for frontend display
 * Never exposes credentials - only shows source and endpoint
 */
export function getConfigStatus(agents?: any[]): ConfigStatus {
  const config = readConfigFromDisk() as ConfigFileDataSources;

  // Resolve the active storage config + source.
  // Precedence: authored .ts (typescript) > runtime state file > env. In
  // code-first mode `config` (layered state) is {} so .ts wins; in ui-first
  // there is no .ts so the state file wins.
  let storageSource: ConfigSource = 'none';
  let activeStorage: Partial<StorageClusterConfig> = {};
  if (tsStorageConfig?.endpoint) {
    storageSource = 'typescript';
    activeStorage = tsStorageConfig;
  } else if (config?.storage?.endpoint) {
    storageSource = 'file';
    activeStorage = config.storage;
  } else if (process.env.OPENSEARCH_STORAGE_ENDPOINT) {
    storageSource = 'environment';
    activeStorage = {
      endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT,
      authType: (process.env.OPENSEARCH_STORAGE_AUTH_TYPE as ClusterAuthType) || undefined,
      username: process.env.OPENSEARCH_STORAGE_USERNAME,
      password: process.env.OPENSEARCH_STORAGE_PASSWORD,
      awsProfile: process.env.OPENSEARCH_STORAGE_AWS_PROFILE,
      awsRegion: process.env.OPENSEARCH_STORAGE_AWS_REGION,
      awsService: (process.env.OPENSEARCH_STORAGE_AWS_SERVICE as 'es' | 'aoss') || undefined,
    };
  }

  // Resolve the active observability config + source (precedence: ts > state > env).
  let obsSource: ConfigSource = 'none';
  let activeObs: Partial<ObservabilityClusterConfig> = {};
  let obsIndexes: ConfigStatus['observability']['indexes'];
  if (tsObservabilityConfig?.endpoint) {
    obsSource = 'typescript';
    activeObs = tsObservabilityConfig;
    obsIndexes = tsObservabilityConfig.indexes;
  } else if (config?.observability?.endpoint) {
    obsSource = 'file';
    activeObs = config.observability;
    obsIndexes = config.observability.indexes;
  } else if (process.env.OPENSEARCH_LOGS_ENDPOINT) {
    obsSource = 'environment';
    activeObs = {
      endpoint: process.env.OPENSEARCH_LOGS_ENDPOINT,
      authType: (process.env.OPENSEARCH_LOGS_AUTH_TYPE as ClusterAuthType) || undefined,
      username: process.env.OPENSEARCH_LOGS_USERNAME,
      password: process.env.OPENSEARCH_LOGS_PASSWORD,
      awsProfile: process.env.OPENSEARCH_LOGS_AWS_PROFILE,
      awsRegion: process.env.OPENSEARCH_LOGS_AWS_REGION,
      awsService: (process.env.OPENSEARCH_LOGS_AWS_SERVICE as 'es' | 'aoss') || undefined,
    };
    obsIndexes = {
      traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX,
      logs: process.env.OPENSEARCH_LOGS_INDEX,
    };
  }

  // Compute runtime storage state. Mirror the resolution precedence so drift
  // detection compares against whatever config the storage backend will use.
  const storageState = getStorageState();
  const resolvedStorageConfig = getStorageConfigFromTs() ?? getStorageConfigFromFile() ??
    (process.env.OPENSEARCH_STORAGE_ENDPOINT ? { endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT } as StorageClusterConfig : null);
  const fileConfigKey = resolvedStorageConfig ? configToCacheKey(resolvedStorageConfig) : null;
  const drifted = fileConfigKey !== storageState.configKey &&
    storageState.configKey !== '__file_override__';

  // Build warnings list. The returned field always reflects live state
  // (needed by the UI); the console.warn is deliberately warn-once (see
  // zeroAgentsWarningLogged above) since this getter runs on every
  // GET /api/storage/config/status call, not just once at startup.
  const warnings: string[] = [];
  if (agents !== undefined && agents.length === 0) {
    warnings.push('WARNING: Config file exists but declares zero agents. The server will have no agents available for evaluation.');
    if (!zeroAgentsWarningLogged) {
      zeroAgentsWarningLogged = true;
      console.warn('[app] WARNING: Config file exists but declares zero agents. The server will have no agents available for evaluation.');
    }
  }

  return {
    storage: {
      configured: storageSource !== 'none',
      source: storageSource,
      endpoint: activeStorage.endpoint,
      authType: activeStorage.authType,
      username: activeStorage.username,
      hasPassword: Boolean(activeStorage.password),
      awsProfile: activeStorage.awsProfile,
      awsRegion: activeStorage.awsRegion,
      awsService: activeStorage.awsService,
    },
    observability: {
      configured: obsSource !== 'none',
      source: obsSource,
      endpoint: activeObs.endpoint,
      authType: activeObs.authType,
      username: activeObs.username,
      hasPassword: Boolean(activeObs.password),
      awsProfile: activeObs.awsProfile,
      awsRegion: activeObs.awsRegion,
      awsService: activeObs.awsService,
      indexes: obsIndexes,
    },
    runtime: {
      storage: {
        backend: storageState.backend,
        error: storageState.error,
        configuredEndpoint: storageState.configuredEndpoint,
        drifted,
      },
    },
    // Where relative code-SDK `sourceFile`s are resolved (env > config > cwd)
    // so the UI/CLI can tell the user where THIS server looks.
    evalRoots: getEvalRootsStatus(),
    ...(warnings.length > 0 && { warnings }),
  };
}

/**
 * Whether any config is in effect: an authored config file (code-first) or a
 * runtime state file at project or user scope.
 */
export function configFileExists(): boolean {
  return isCodeFirstMode() || fs.existsSync(projectStatePath()) || fs.existsSync(userStatePath());
}
