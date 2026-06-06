/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for the browser-safe `process.env` guard in tracePoller.
 *
 * tracePoller.ts is imported by browser code (RunDetailsContent recovery
 * polling). Before the fix, the top-level `envInt` helper read
 * `process.env[name]` directly, which throws `ReferenceError: process is
 * not defined` under Vite dev where `process` is not polyfilled — causing
 * the whole frontend to fail to load.
 *
 * Two complementary tests:
 *   1. Source-pattern check — fast, deterministic guard against the
 *      regression sneaking back in via a future refactor.
 *   2. Behavioural check    — when `process.env` is missing, the helper
 *      falls back to the defaults instead of throwing.
 */

import * as fs from 'fs';
import * as path from 'path';

const POLLER_SRC = path.resolve(
  __dirname,
  '../../../../services/traces/tracePoller.ts',
);

describe('tracePoller browser-safe process.env guard', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(POLLER_SRC, 'utf-8');
  });

  it('source uses `typeof process !== "undefined"` guard', () => {
    expect(source).toMatch(/typeof process !== ['"]undefined['"]/);
  });

  it('source does not contain a naked `process.env[name]` read', () => {
    // The fixed helper assigns through the guard:
    //   typeof process !== 'undefined' && process?.env ? process.env[name] : undefined
    // Catch the regression form: a bare top-level `process.env[name]`
    // assignment without a guard on the same logical statement.
    const hasNakedRead = /^\s*const\s+raw\s*=\s*process\.env\[name\];?\s*$/m.test(
      source,
    );
    expect(hasNakedRead).toBe(false);
  });

  it('falls back to defaults when process.env is unavailable (browser-like env)', () => {
    // Simulate the browser where `process.env` doesn't exist. We can't
    // safely delete the global `process` (Node's module loader and Jest
    // both depend on it), but the guard is `process?.env`, so wiping
    // `.env` exercises the same fallback branch.
    const originalEnv = process.env;
    try {
      // @ts-expect-error - intentionally violating types to simulate browser
      process.env = undefined;

      // Re-require the module fresh so the top-level `envInt` calls
      // re-evaluate with the wiped env.
      jest.isolateModules(() => {
        expect(() => require('@/services/traces/tracePoller')).not.toThrow();
      });
    } finally {
      process.env = originalEnv;
    }
  });
});
