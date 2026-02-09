/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Config Module
 * Public exports for configuration system
 */

// Type exports
export type {
  UserConfig,
  UserAgentConfig,
  UserModelConfig,
  ResolvedConfig,
  ConfigFileInfo,
  ReporterConfig,
  JudgeConfig,
  ServerConfig,
  ResolvedServerConfig,
} from './types';

// Re-export hook types for consumer convenience (e.g., in agent-health.config.ts)
export type { AgentHooks, BeforeRequestContext } from '@/types';

// Function exports
export { defineConfig } from './defineConfig';
export {
  loadConfig,
  loadConfigSync,
  findConfigFile,
  getConfigFileInfo,
  clearConfigCache,
  DEFAULT_SERVER_CONFIG,
} from './loader';
