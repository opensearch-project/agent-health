/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end CLI integration test for the stdout/stderr contract of
 * `list <resource> --output json`.
 *
 * Why this test exists
 * ────────────────────
 * `--output json` must emit ONLY parseable JSON on stdout so that
 * `agent-health list connectors --output json | jq` /
 * `... | python -m json.tool` work. Diagnostics (`[Connectors] …`,
 * `[Config] …`) must go to stderr.
 *
 * The original fix (PR #315) routed the `[Connectors]` registration
 * logs to stderr but MISSED the `[Config]` loader logs, which still
 * printed to stdout and broke `JSON.parse(stdout)`. This test pins the
 * full contract so neither source regresses:
 *
 *   1. `JSON.parse(stdout)` succeeds and yields an array.
 *   2. stdout contains NO `[Connectors]` / `[Config]` diagnostic lines.
 *   3. stderr DOES carry those startup diagnostics.
 *
 * `list connectors` is fully offline — it reads the in-process
 * connector registry, so no backend or credentials are required.
 *
 * Prerequisites
 * ─────────────
 *   • CLI bundle built (npm run build:cli). The test builds it if missing.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const TEST_TIMEOUT = 120_000;
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CLI_BUNDLE = join(REPO_ROOT, 'cli', 'dist', 'index.js');

function ensureCliBundle(): void {
  if (existsSync(CLI_BUNDLE)) return;
  const built = spawnSync('npm', ['run', 'build:cli'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (built.status !== 0) throw new Error('npm run build:cli failed; cannot continue');
  if (!existsSync(CLI_BUNDLE)) throw new Error(`CLI bundle still missing at ${CLI_BUNDLE} after build`);
}

describe('CLI --output json — stdout carries only JSON, diagnostics on stderr', () => {
  beforeAll(() => {
    ensureCliBundle();
  }, TEST_TIMEOUT);

  it(
    'list connectors --output json: stdout is parseable JSON, [Connectors]/[Config] go to stderr',
    () => {
      const result = spawnSync(
        process.execPath,
        [CLI_BUNDLE, 'list', 'connectors', '--output', 'json'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

      expect(result.status).toBe(0);

      // 1. stdout must be valid JSON (the whole point of --output json).
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(result.stdout);
      }).not.toThrow();
      expect(Array.isArray(parsed)).toBe(true);

      // 2. stdout must NOT contain any diagnostic noise.
      expect(result.stdout).not.toMatch(/\[Connectors\]/);
      expect(result.stdout).not.toMatch(/\[Config\]/);

      // 3. stderr carries the startup diagnostics.
      expect(result.stderr).toMatch(/\[Connectors\]/);
      expect(result.stderr).toMatch(/\[Config\]/);
    },
    TEST_TIMEOUT,
  );
});
