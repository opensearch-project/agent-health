/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared test configuration for integration tests.
 * Reads AH_PORT to determine the backend URL.
 */

const DEFAULT_PORT = 4001;

export function getTestBackendUrl(): string {
  const port = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || String(DEFAULT_PORT);
  return `http://localhost:${port}`;
}
