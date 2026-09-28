/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `--help` option inventory
 *
 * The flags a customer's scripts depend on. Each subcommand's `--help` must
 * still list EVERY flag below (additions are fine; a flag disappearing or
 * being renamed fails the test). No server is needed for `--help`, so this
 * also pins that help never tries to connect.
 */

import { runCli } from '../../helpers/surfaceMatrix';

const OPTION_RE = /^\s+(?:-[A-Za-z], )?(--[a-z][a-z-]*)/gm;

function longFlags(helpText: string): string[] {
  return [...helpText.matchAll(OPTION_RE)].map((m) => m[1]);
}

/** command → long flags that must keep existing. */
const PINNED: Record<string, string[]> = {
  '': ['--version', '--port', '--env-file', '--no-browser', '--headless', '--api-key', '--agent-path', '--help'],
  serve: ['--port', '--no-browser', '--headless', '--api-key', '--agent-path', '--help'],
  benchmark: [
    '--name', '--file', '--dir', '--test-case', '--label', '--agent', '--evaluator', '--judge-model',
    '--output', '--export', '--format', '--concurrency', '--verbose', '--stop-server', '--agent-path', '--help',
  ],
  run: ['--test-case', '--agent', '--evaluator', '--judge-model', '--output', '--verbose', '--agent-path', '--help'],
  export: ['--benchmark', '--output', '--stdout', '--help'],
  report: ['--benchmark', '--runs', '--format', '--output', '--stdout', '--help'],
  list: ['--output', '--help'],
  import: ['--from', '--source', '--output', '--dry-run', '--repo', '--branch', '--help'],
};

/** Short aliases customers type by hand. */
const PINNED_SHORT: Record<string, string[]> = {
  benchmark: ['-n, --name', '-f, --file', '-d, --dir', '-t, --test-case', '-a, --agent', '-e, --evaluator', '-o, --output', '-c, --concurrency', '-v, --verbose'],
  run: ['-t, --test-case', '-a, --agent', '-e, --evaluator', '-o, --output', '-v, --verbose'],
  export: ['-b, --benchmark', '-o, --output'],
  report: ['-b, --benchmark', '-r, --runs', '-f, --format', '-o, --output'],
  serve: ['-p, --port'],
  '': ['-p, --port', '-e, --env-file', '-V, --version'],
};

describe('surface-matrix · CLI · --help option inventory', () => {
  for (const [command, flags] of Object.entries(PINNED)) {
    it(`\`agent-health ${command || '(root)'} --help\` still lists ${flags.length} pinned flags`, async () => {
      const args = command ? [command, '--help'] : ['--help'];
      const result = await runCli(args, { timeoutMs: 60_000, env: { AH_PORT: '1' } }); // AH_PORT=1: help must not need a server
      expect(result.code).toBe(0);
      const found = longFlags(result.out);
      const missing = flags.filter((f) => !found.includes(f));
      expect(missing).toEqual([]);
      for (const short of PINNED_SHORT[command] ?? []) expect(result.out).toContain(short);
    });
  }

  it('root --help lists every subcommand a customer can invoke', async () => {
    const result = await runCli(['--help'], { timeoutMs: 60_000, env: { AH_PORT: '1' } });
    expect(result.code).toBe(0);
    for (const cmd of ['agent-health run', 'agent-health benchmark', 'agent-health list', 'agent-health report', 'agent-health export', 'agent-health serve', 'agent-health doctor', 'agent-health init', 'agent-health import']) {
      expect(result.out).toContain(cmd);
    }
  });
});
