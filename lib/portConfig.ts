/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Port Configuration - Single source of truth for all port settings.
 *
 * Backend port: AGENT_HEALTH_PORT (default 4001)
 * Frontend dev port: AGENT_HEALTH_DEV_PORT (default 4000)
 */

export const DEFAULT_BACKEND_PORT = 4001;
export const DEFAULT_DEV_PORT = 4000;

/**
 * Resolve the backend server port from AGENT_HEALTH_PORT env var.
 */
export function resolveBackendPort(): number {
  const port = process.env.AGENT_HEALTH_PORT;
  if (port) {
    const parsed = parseInt(port, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_BACKEND_PORT;
}

/**
 * Resolve the frontend dev server port from AGENT_HEALTH_DEV_PORT env var.
 */
export function resolveDevPort(): number {
  const port = process.env.AGENT_HEALTH_DEV_PORT;
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
