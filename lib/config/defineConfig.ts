/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * defineConfig Helper
 * Provides type safety for agent-health.config.ts files
 */

import type { UserConfig } from './types';

/**
 * Define configuration with full type safety
 *
 * @example
 * ```typescript
 * // agent-health.config.ts
 * import { defineConfig } from '@opensearch-project/agent-health';
 *
 * export default defineConfig({
 *   agents: [
 *     {
 *       key: 'my-agent',
 *       name: 'My Agent',
 *       endpoint: 'https://api.example.com/chat',
 *       connectorType: 'rest',
 *       models: ['claude-sonnet-4'],
 *     },
 *   ],
 * });
 * ```
 */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}
