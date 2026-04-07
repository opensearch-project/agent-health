/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration Service
 *
 * Manages server-side configuration stored in agent-health.config.json.
 * Provides secure credential storage without browser exposure.
 *
 * Shares the same JSON file as customAgentStore.ts — each module
 * owns its own top-level keys (storage, observability vs customAgents).
 * Safe because Node.js is single-threaded and both use synchronous fs calls.
 */

import fs from 'fs';
import path from 'path';
import { debug } from '../../lib/debug.js';
import type { StorageClusterConfig, ObservabilityClusterConfig, ClusterAuthType } from '../../types/index.js';

// Same filename used by customAgentStore.ts
const CONFIG_FILENAME = 'agent-health.config.json';

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
export interface ConfigStatus {
  storage: {
    configured: boolean;
    source: 'file' | 'environment' | 'none';
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
    source: 'file' | 'environment' | 'none';
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
}

/**
 * Get the config file path.
 * Checks CWD first, then falls back to CWD as default write location.
 */
function getConfigFilePath(): string {
  const cwdPath = path.join(process.cwd(), CONFIG_FILENAME);
  return cwdPath;
}

/**
 * Read the full JSON config from disk.
 * Returns `{}` when file doesn't exist (safe to create new).
 * Returns `null` when file exists but read/parse fails (unsafe to write — would clobber).
 */
function readConfigFromDisk(): Record<string, unknown> | null {
  try {
    const filePath = getConfigFilePath();
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[ConfigService] Config file contains non-object content, refusing to overwrite');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error('[ConfigService] Failed to read config file:', err);
    return null;
  }
}

/**
 * Write config back to disk, preserving all sibling keys.
 * Same pattern as customAgentStore.ts.
 */
function writeConfigToDisk(config: Record<string, unknown>): void {
  try {
    const filePath = getConfigFilePath();
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    debug('ConfigService', `Config saved to ${filePath}`);
  } catch (error) {
    console.error('[ConfigService] Failed to write config file:', error);
    throw error;
  }
}

// ============================================================================
// Storage Configuration
// ============================================================================

/**
 * Get storage configuration from file
 * Returns null if not configured in file
 */
export function getStorageConfigFromFile(): StorageClusterConfig | null {
  const config = readConfigFromDisk() as ConfigFileDataSources | null;

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
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot save storage config: existing config file is unreadable or corrupt');
  }
  const existingStorage = (existing.storage as any) || {};

  // Use ?? so that an absent/undefined field in the incoming payload falls back
  // to whatever is already stored. The form converts sentinel and empty values
  // to undefined before sending. Note: if called directly with password: "",
  // the empty string passes through ?? but is omitted by the falsy spread
  // below, effectively clearing the stored credential. This is intentional.
  const resolvedUsername = storageConfig.username ?? existingStorage.username;
  const resolvedPassword = storageConfig.password ?? existingStorage.password;

  existing.storage = {
    endpoint: storageConfig.endpoint,
    ...(storageConfig.authType && { authType: storageConfig.authType }),
    ...(resolvedUsername && { username: resolvedUsername }),
    ...(resolvedPassword && { password: resolvedPassword }),
    ...(storageConfig.awsProfile && { awsProfile: storageConfig.awsProfile }),
    ...(storageConfig.awsRegion && { awsRegion: storageConfig.awsRegion }),
    ...(storageConfig.awsService && { awsService: storageConfig.awsService }),
    ...(storageConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: storageConfig.tlsSkipVerify }),
  };

  writeConfigToDisk(existing);
}

/**
 * Clear storage configuration from file
 */
export function clearStorageConfig(): void {
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot clear storage config: existing config file is unreadable or corrupt');
  }
  delete existing.storage;

  // If config is now empty, delete the file
  if (Object.keys(existing).length === 0) {
    const filePath = getConfigFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      debug('ConfigService', 'Config file deleted (empty)');
    }
  } else {
    writeConfigToDisk(existing);
  }
}

// ============================================================================
// Observability Configuration
// ============================================================================

/**
 * Get observability configuration from file
 * Returns null if not configured in file
 */
export function getObservabilityConfigFromFile(): ObservabilityClusterConfig | null {
  const config = readConfigFromDisk() as ConfigFileDataSources | null;

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
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot save observability config: existing config file is unreadable or corrupt');
  }
  const existingObs = (existing.observability as any) || {};

  // Use ?? so that an absent/undefined field in the incoming payload falls back
  // to whatever is already stored.
  const resolvedUsername = obsConfig.username ?? existingObs.username;
  const resolvedPassword = obsConfig.password ?? existingObs.password;

  existing.observability = {
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

  writeConfigToDisk(existing);
}

/**
 * Clear observability configuration from file
 */
export function clearObservabilityConfig(): void {
  const existing = readConfigFromDisk();
  if (existing === null) {
    throw new Error('Cannot clear observability config: existing config file is unreadable or corrupt');
  }
  delete existing.observability;

  // If config is now empty, delete the file
  if (Object.keys(existing).length === 0) {
    const filePath = getConfigFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      debug('ConfigService', 'Config file deleted (empty)');
    }
  } else {
    writeConfigToDisk(existing);
  }
}

// ============================================================================
// Config Status (for frontend display)
// ============================================================================

/**
 * Get configuration status for frontend display
 * Never exposes credentials - only shows source and endpoint
 */
export function getConfigStatus(): ConfigStatus {
  const config = readConfigFromDisk() as ConfigFileDataSources | null;

  // Determine storage config source
  let storageSource: 'file' | 'environment' | 'none' = 'none';
  let storageEndpoint: string | undefined;

  if (config?.storage?.endpoint) {
    storageSource = 'file';
    storageEndpoint = config.storage.endpoint;
  } else if (process.env.OPENSEARCH_STORAGE_ENDPOINT) {
    storageSource = 'environment';
    storageEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;
  }

  // Determine observability config source
  let obsSource: 'file' | 'environment' | 'none' = 'none';
  let obsEndpoint: string | undefined;
  let obsIndexes: ConfigStatus['observability']['indexes'];

  if (config?.observability?.endpoint) {
    obsSource = 'file';
    obsEndpoint = config.observability.endpoint;
    obsIndexes = config.observability.indexes;
  } else if (process.env.OPENSEARCH_LOGS_ENDPOINT) {
    obsSource = 'environment';
    obsEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
    obsIndexes = {
      traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX,
      logs: process.env.OPENSEARCH_LOGS_INDEX,
    };
  }

  // Resolve SigV4 fields
  const storageAuthType: ClusterAuthType | undefined = storageSource === 'file'
    ? config?.storage?.authType
    : (process.env.OPENSEARCH_STORAGE_AUTH_TYPE as ClusterAuthType) || undefined;
  const storageAwsProfile = storageSource === 'file'
    ? config?.storage?.awsProfile
    : process.env.OPENSEARCH_STORAGE_AWS_PROFILE;
  const storageAwsRegion = storageSource === 'file'
    ? config?.storage?.awsRegion
    : process.env.OPENSEARCH_STORAGE_AWS_REGION;
  const storageAwsService = storageSource === 'file'
    ? config?.storage?.awsService
    : (process.env.OPENSEARCH_STORAGE_AWS_SERVICE as 'es' | 'aoss') || undefined;

  const obsAuthType: ClusterAuthType | undefined = obsSource === 'file'
    ? config?.observability?.authType
    : (process.env.OPENSEARCH_LOGS_AUTH_TYPE as ClusterAuthType) || undefined;
  const obsAwsProfile = obsSource === 'file'
    ? config?.observability?.awsProfile
    : process.env.OPENSEARCH_LOGS_AWS_PROFILE;
  const obsAwsRegion = obsSource === 'file'
    ? config?.observability?.awsRegion
    : process.env.OPENSEARCH_LOGS_AWS_REGION;
  const obsAwsService = obsSource === 'file'
    ? config?.observability?.awsService
    : (process.env.OPENSEARCH_LOGS_AWS_SERVICE as 'es' | 'aoss') || undefined;

  return {
    storage: {
      configured: storageSource !== 'none',
      source: storageSource,
      endpoint: storageEndpoint,
      authType: storageAuthType,
      username: storageSource === 'file'
        ? config?.storage?.username
        : process.env.OPENSEARCH_STORAGE_USERNAME,
      hasPassword: storageSource === 'file'
        ? Boolean(config?.storage?.password)
        : Boolean(process.env.OPENSEARCH_STORAGE_PASSWORD),
      awsProfile: storageAwsProfile,
      awsRegion: storageAwsRegion,
      awsService: storageAwsService,
    },
    observability: {
      configured: obsSource !== 'none',
      source: obsSource,
      endpoint: obsEndpoint,
      authType: obsAuthType,
      username: obsSource === 'file'
        ? config?.observability?.username
        : process.env.OPENSEARCH_LOGS_USERNAME,
      hasPassword: obsSource === 'file'
        ? Boolean(config?.observability?.password)
        : Boolean(process.env.OPENSEARCH_LOGS_PASSWORD),
      awsProfile: obsAwsProfile,
      awsRegion: obsAwsRegion,
      awsService: obsAwsService,
      indexes: obsIndexes,
    },
  };
}

/**
 * Check if config file exists
 */
export function configFileExists(): boolean {
  const filePath = getConfigFilePath();
  return fs.existsSync(filePath);
}
