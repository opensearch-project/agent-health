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
 * Whether the backend port was *explicitly* configured (AH_PORT /
 * AGENT_HEALTH_PORT set) vs. silently defaulted to {@link DEFAULT_BACKEND_PORT}.
 *
 * Callers that dial the backend over HTTP (e.g. the SDK `judge()` matcher
 * run outside the server lifecycle) use this to warn before defaulting to
 * 4001 — where a foreign instance (a live demo, another checkout) may be
 * listening. See AGENTS.md → server lifecycle.
 *
 * Only a value that parses to a valid integer counts as explicit — a
 * garbage `AH_PORT=abc` silently falls back to the default in
 * {@link resolveBackendPort}, so the warn-once must still fire for it.
 */
export function isBackendPortExplicit(): boolean {
  const port = readEnv('AH_PORT', 'AGENT_HEALTH_PORT');
  return !!port && !isNaN(parseInt(port, 10));
}

/**
 * Get the full backend URL (http://localhost:<port>).
 */
export function getBackendUrl(): string {
  return `http://localhost:${resolveBackendPort()}`;
}
