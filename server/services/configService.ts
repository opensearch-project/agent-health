/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration Service
 *
 * Manages server-side configuration stored in agent-health.yaml.
 * Provides secure credential storage without browser exposure.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import type { StorageClusterConfig, ObservabilityClusterConfig } from '../../types/index.js';

// ESM equivalent of __dirname
const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);

// Config file path - at project root
const CONFIG_FILE_NAME = 'agent-health.yaml';

// Type for the full config file structure
interface ConfigFile {
  storage?: {
    endpoint: string;
    username?: string;
    password?: string;
    tlsSkipVerify?: boolean;
  };
  observability?: {
    endpoint: string;
    username?: string;
    password?: string;
    tlsSkipVerify?: boolean;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
}

// Config status returned to frontend (no credentials)
export interface ConfigStatus {
  storage: {
    configured: boolean;
    source: 'file' | 'environment' | 'none';
    endpoint?: string;  // Show endpoint for verification, never credentials
  };
  observability: {
    configured: boolean;
    source: 'file' | 'environment' | 'none';
    endpoint?: string;
    indexes?: {
      traces?: string;
      logs?: string;
      metrics?: string;
    };
  };
}

/**
 * Get the config file path
 * Checks multiple locations in order: CWD, then project root
 */
function getConfigFilePath(): string {
  // First check current working directory
  const cwdPath = path.join(process.cwd(), CONFIG_FILE_NAME);
  if (fs.existsSync(cwdPath)) {
    return cwdPath;
  }

  // Then check the directory where this file is located (project root from server/services/)
  const projectRootPath = path.join(currentDirname, '..', '..', CONFIG_FILE_NAME);
  return projectRootPath;
}

/**
 * Read and parse the config file
 */
function readConfigFile(): ConfigFile | null {
  const configPath = getConfigFilePath();

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(content) as ConfigFile;
    return config;
  } catch (error) {
    console.error('[ConfigService] Failed to read config file:', error);
    return null;
  }
}

/**
 * Write config to the config file
 */
function writeConfigFile(config: ConfigFile): void {
  const configPath = getConfigFilePath();

  // If the file doesn't exist, create it at CWD
  const targetPath = fs.existsSync(configPath)
    ? configPath
    : path.join(process.cwd(), CONFIG_FILE_NAME);

  try {
    const content = yaml.dump(config, {
      indent: 2,
      lineWidth: -1,  // Don't wrap lines
      quotingType: '"',
      forceQuotes: false,
    });
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log(`[ConfigService] Config saved to ${targetPath}`);
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
  const config = readConfigFile();

  if (!config?.storage?.endpoint) {
    return null;
  }

  return {
    endpoint: config.storage.endpoint,
    username: config.storage.username,
    password: config.storage.password,
    tlsSkipVerify: config.storage.tlsSkipVerify,
  };
}

/**
 * Save storage configuration to file
 */
export function saveStorageConfig(storageConfig: StorageClusterConfig): void {
  const existingConfig = readConfigFile() || {};

  const updatedConfig: ConfigFile = {
    ...existingConfig,
    storage: {
      endpoint: storageConfig.endpoint,
      ...(storageConfig.username && { username: storageConfig.username }),
      ...(storageConfig.password && { password: storageConfig.password }),
      ...(storageConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: storageConfig.tlsSkipVerify }),
    },
  };

  writeConfigFile(updatedConfig);
}

/**
 * Clear storage configuration from file
 */
export function clearStorageConfig(): void {
  const existingConfig = readConfigFile();

  if (!existingConfig) {
    return;
  }

  delete existingConfig.storage;

  // If config is now empty, delete the file
  if (Object.keys(existingConfig).length === 0) {
    const configPath = getConfigFilePath();
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      console.log('[ConfigService] Config file deleted (empty)');
    }
  } else {
    writeConfigFile(existingConfig);
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
  const config = readConfigFile();

  if (!config?.observability?.endpoint) {
    return null;
  }

  return {
    endpoint: config.observability.endpoint,
    username: config.observability.username,
    password: config.observability.password,
    tlsSkipVerify: config.observability.tlsSkipVerify,
    indexes: config.observability.indexes,
  };
}

/**
 * Save observability configuration to file
 */
export function saveObservabilityConfig(obsConfig: ObservabilityClusterConfig): void {
  const existingConfig = readConfigFile() || {};

  const updatedConfig: ConfigFile = {
    ...existingConfig,
    observability: {
      endpoint: obsConfig.endpoint,
      ...(obsConfig.username && { username: obsConfig.username }),
      ...(obsConfig.password && { password: obsConfig.password }),
      ...(obsConfig.tlsSkipVerify !== undefined && { tlsSkipVerify: obsConfig.tlsSkipVerify }),
      ...(obsConfig.indexes && Object.keys(obsConfig.indexes).length > 0 && {
        indexes: obsConfig.indexes,
      }),
    },
  };

  writeConfigFile(updatedConfig);
}

/**
 * Clear observability configuration from file
 */
export function clearObservabilityConfig(): void {
  const existingConfig = readConfigFile();

  if (!existingConfig) {
    return;
  }

  delete existingConfig.observability;

  // If config is now empty, delete the file
  if (Object.keys(existingConfig).length === 0) {
    const configPath = getConfigFilePath();
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      console.log('[ConfigService] Config file deleted (empty)');
    }
  } else {
    writeConfigFile(existingConfig);
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
  const fileConfig = readConfigFile();

  // Determine storage config source
  let storageSource: 'file' | 'environment' | 'none' = 'none';
  let storageEndpoint: string | undefined;

  if (fileConfig?.storage?.endpoint) {
    storageSource = 'file';
    storageEndpoint = fileConfig.storage.endpoint;
  } else if (process.env.OPENSEARCH_STORAGE_ENDPOINT) {
    storageSource = 'environment';
    storageEndpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;
  }

  // Determine observability config source
  let obsSource: 'file' | 'environment' | 'none' = 'none';
  let obsEndpoint: string | undefined;
  let obsIndexes: ConfigStatus['observability']['indexes'];

  if (fileConfig?.observability?.endpoint) {
    obsSource = 'file';
    obsEndpoint = fileConfig.observability.endpoint;
    obsIndexes = fileConfig.observability.indexes;
  } else if (process.env.OPENSEARCH_LOGS_ENDPOINT) {
    obsSource = 'environment';
    obsEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
    obsIndexes = {
      traces: process.env.OPENSEARCH_LOGS_TRACES_INDEX,
      logs: process.env.OPENSEARCH_LOGS_INDEX,
    };
  }

  return {
    storage: {
      configured: storageSource !== 'none',
      source: storageSource,
      endpoint: storageEndpoint,
    },
    observability: {
      configured: obsSource !== 'none',
      source: obsSource,
      endpoint: obsEndpoint,
      indexes: obsIndexes,
    },
  };
}

/**
 * Check if config file exists
 */
export function configFileExists(): boolean {
  const configPath = getConfigFilePath();
  return fs.existsSync(configPath);
}
