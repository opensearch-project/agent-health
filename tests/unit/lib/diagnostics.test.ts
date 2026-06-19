/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { canLogStartupDiagnosticsToStdout } from '@/lib/diagnostics';

describe('canLogStartupDiagnosticsToStdout', () => {
  const origArgv = process.argv;
  const origIsTTY = process.stdout.isTTY;
  const origEnv = process.env.AGENT_HEALTH_SERVER;

  function setup(opts: { argv?: string[]; isTTY?: boolean; server?: boolean }) {
    process.argv = ['node', opts.server ? '/app/server/dist/index.js' : '/app/cli/dist/index.js', ...(opts.argv ?? [])];
    Object.defineProperty(process.stdout, 'isTTY', { value: opts.isTTY ?? false, configurable: true });
    if (opts.server) process.env.AGENT_HEALTH_SERVER = '1';
    else delete process.env.AGENT_HEALTH_SERVER;
  }

  afterEach(() => {
    process.argv = origArgv;
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    if (origEnv === undefined) delete process.env.AGENT_HEALTH_SERVER;
    else process.env.AGENT_HEALTH_SERVER = origEnv;
  });

  it('suppresses when --output json is requested (even on a TTY)', () => {
    setup({ argv: ['list', 'connectors', '--output', 'json'], isTTY: true });
    expect(canLogStartupDiagnosticsToStdout()).toBe(false);
  });

  it('suppresses for -o json and --output=json', () => {
    setup({ argv: ['list', 'connectors', '-o', 'json'], isTTY: true });
    expect(canLogStartupDiagnosticsToStdout()).toBe(false);
    setup({ argv: ['list', 'connectors', '--output=json'], isTTY: true });
    expect(canLogStartupDiagnosticsToStdout()).toBe(false);
  });

  it('suppresses with --quiet / -q', () => {
    setup({ argv: ['list', 'connectors', '--quiet'], isTTY: true });
    expect(canLogStartupDiagnosticsToStdout()).toBe(false);
    setup({ argv: ['list', 'connectors', '-q'], isTTY: true });
    expect(canLogStartupDiagnosticsToStdout()).toBe(false);
  });

  it('suppresses when stdout is piped/redirected (non-TTY)', () => {
    setup({ argv: ['list', 'connectors'], isTTY: false });
    expect(canLogStartupDiagnosticsToStdout()).toBe(false);
  });

  it('allows interactive use (TTY, no structured/quiet flag)', () => {
    setup({ argv: ['list', 'connectors'], isTTY: true });
    expect(canLogStartupDiagnosticsToStdout()).toBe(true);
  });

  it('does NOT suppress for non-json structured values (e.g. --output table)', () => {
    setup({ argv: ['list', 'connectors', '--output', 'table'], isTTY: true });
    expect(canLogStartupDiagnosticsToStdout()).toBe(true);
  });

  it('always allows the server process, even non-TTY (its stdout is its log stream)', () => {
    setup({ server: true, isTTY: false });
    expect(canLogStartupDiagnosticsToStdout()).toBe(true);
  });
});
