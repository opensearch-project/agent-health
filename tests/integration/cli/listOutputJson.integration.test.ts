/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end CLI integration test for the stdout machine-readable contract of
 * `list <resource>`.
 *
 * Why this test exists
 * ────────────────────
 * `--output json` must emit ONLY parseable JSON on stdout so that
 * `agent-health list connectors --output json | jq` /
 * `... | python -m json.tool` work. The informational startup lines
 * (`[Connectors] …`, `[Config] …`) must NOT corrupt that output.
 *
 * The fix gates those diagnostics (see lib/diagnostics.ts): they print to
 * stdout only for interactive use; they are suppressed when `--output json` /
 * `--quiet` is requested or stdout is piped/redirected (non-TTY). spawnSync
 * pipes stdout (non-TTY), which mirrors the `| jq` scenario.
 *
 * The original fix (PR #315) first routed only the `[Connectors]` logs to
 * stderr and MISSED the `[Config]` loader logs, which still broke
 * `JSON.parse(stdout)`. This test pins BOTH sources across both code paths.
 *
 * `list connectors` is fully offline — it reads the in-process connector
 * registry, so no backend or credentials are required.
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

function runCli(args: string[]) {
  return spawnSync(process.execPath, [CLI_BUNDLE, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('CLI stdout machine-readable contract — diagnostics never corrupt stdout', () => {
  beforeAll(() => {
    ensureCliBundle();
  }, TEST_TIMEOUT);

  it(
    'list connectors --output json: stdout is parseable JSON with no [Connectors]/[Config] noise',
    () => {
      const result = runCli(['list', 'connectors', '--output', 'json']);
      expect(result.status).toBe(0);

      // stdout must be valid JSON (the whole point of --output json).
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(result.stdout);
      }).not.toThrow();
      expect(Array.isArray(parsed)).toBe(true);

      // No diagnostic noise on stdout.
      expect(result.stdout).not.toMatch(/\[Connectors\]/);
      expect(result.stdout).not.toMatch(/\[Config\]/);
    },
    TEST_TIMEOUT,
  );

  it(
    'list connectors (default table, piped/non-TTY): diagnostics are suppressed from stdout',
    () => {
      // spawnSync pipes stdout → non-TTY → same path as `| jq`.
      const result = runCli(['list', 'connectors']);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/\[Connectors\]/);
      expect(result.stdout).not.toMatch(/\[Config\]/);
    },
    TEST_TIMEOUT,
  );
});
