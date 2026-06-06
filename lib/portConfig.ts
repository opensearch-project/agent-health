/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Port Configuration - Single source of truth for all port settings.
 *
 * Backend port: AH_PORT (default 4001)
 * Frontend dev port: AH_DEV_PORT (default 4000)
 *
 * The legacy names AGENT_HEALTH_PORT and AGENT_HEALTH_DEV_PORT are still
 * accepted for one release with a deprecation warning.
 */

import { readEnv } from './envCompat';

export const DEFAULT_BACKEND_PORT = 4001;
export const DEFAULT_DEV_PORT = 4000;

/**
 * Resolve the backend server port from AH_PORT env var (legacy: AGENT_HEALTH_PORT).
 */
export function resolveBackendPort(): number {
  const port = readEnv('AH_PORT', 'AGENT_HEALTH_PORT');
  if (port) {
    const parsed = parseInt(port, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_BACKEND_PORT;
}

/**
 * Resolve the frontend dev server port from AH_DEV_PORT env var (legacy: AGENT_HEALTH_DEV_PORT).
 */
export function resolveDevPort(): number {
  const port = readEnv('AH_DEV_PORT', 'AGENT_HEALTH_DEV_PORT');
  if (port) {
    const parsed = parseInt(port, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_DEV_PORT;
}

/**
 * Get the full backend URL (http://localhost:<port>).
 */
export function getBackendUrl(): string {
  return `http://localhost:${resolveBackendPort()}`;
}
