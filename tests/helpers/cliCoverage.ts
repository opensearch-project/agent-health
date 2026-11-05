/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opt-in V8 coverage for the CLI subprocesses integration tests spawn.
 *
 * Jest instruments only code it loads in-process, so the CLI sources — which the
 * integration suites exercise by spawning the real `cli/dist/index.js` bundle —
 * used to report no coverage at all. Node can record coverage for any process
 * started with `NODE_V8_COVERAGE=<dir>`; `npm run coverage:cli` (c8) then maps
 * those raw dumps through the bundle's source map back onto the cli/ sources.
 *
 * Tests wrap the env they hand to `spawn`/`spawnSync` in `withCliCoverage()`.
 * When `AH_CLI_V8_COVERAGE_DIR` is unset (local runs) the env is returned
 * unchanged; when set (CI's integration job) each CLI child gets
 * `NODE_V8_COVERAGE` pointing at that directory (absolute, because the child's
 * cwd is often a temp project dir). The jest processes themselves are NOT
 * started with `NODE_V8_COVERAGE` — only the children are — so no multi-MB
 * dump of jest's own code pollutes the report.
 */

import { resolve } from 'path';

export const CLI_COVERAGE_DIR_VAR = 'AH_CLI_V8_COVERAGE_DIR';

export function withCliCoverage<T extends Record<string, string | undefined>>(env: T): T {
  const dir = process.env[CLI_COVERAGE_DIR_VAR];
  if (!dir) return env;
  return { ...env, NODE_V8_COVERAGE: resolve(dir) };
}
