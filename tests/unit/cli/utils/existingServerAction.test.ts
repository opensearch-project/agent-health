/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the ensureServer() "server already running" decision table
 * (`decideExistingServerAction`, cli/utils/serverOwnership.ts — pure module,
 * see serverOwnership.test.ts for why the logic lives outside serverLifecycle.ts).
 *
 * Motivating failure: the CLI e2e harness (tests/e2e/cli) drives
 * `node bin/cli.js benchmark …` against the server Playwright already started
 * on `AH_PORT`. GitHub Actions sets `CI=true`, which makes
 * `reuseExistingServer` default to `false`, and the CLI refused with
 * "Server already running on port 4001. In CI mode (reuseExistingServer=false),
 * this is an error." — on every retry. The CI guard exists to stop a CLI from
 * talking to a stray server BY ACCIDENT; a port the operator named explicitly
 * (`AH_PORT` / `server.port`) is explicit intent and must be honoured.
 */

import { decideExistingServerAction } from '@/cli/utils/serverOwnership';

describe('decideExistingServerAction — CI × explicit port × version match', () => {
  const table: Array<[boolean, boolean, boolean, ReturnType<typeof decideExistingServerAction>]> = [
    // reuseExistingServer (dev default = !CI), portExplicit, versionMatches → action
    [true,  false, true,  'reuse'],
    [true,  true,  true,  'reuse'],
    [true,  false, false, 'restart'],
    [true,  true,  false, 'restart'],
    [false, true,  true,  'reuse-explicit-port'],   // CI + AH_PORT/server.port + healthy matching server → reuse
    [false, false, true,  'error-running'],         // CI + defaulted port → the guard stays
    [false, true,  false, 'error-version'],         // CI: never reuse (and never kill) a mismatched server
    [false, false, false, 'error-version'],
  ];

  it.each(table)(
    'reuseExistingServer=%s portExplicit=%s versionMatches=%s → %s',
    (reuseExistingServer, portExplicit, versionMatches, expected) => {
      expect(decideExistingServerAction({ reuseExistingServer, portExplicit, versionMatches })).toBe(expected);
    }
  );

  it('an explicit port never causes a kill/restart in CI mode', () => {
    for (const versionMatches of [true, false]) {
      const action = decideExistingServerAction({ reuseExistingServer: false, portExplicit: true, versionMatches });
      expect(action).not.toBe('restart');
    }
  });
});
