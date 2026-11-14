/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Isolated `import.meta.env` access (Vite-only, browser-side).
 *
 * Kept in its own tiny module so this is the ONLY place `import.meta`
 * syntax appears in lib/pageLatency.ts's dependency chain. Jest's ts-jest
 * transform (CommonJS output) cannot parse `import.meta` at all, so -- same
 * pattern as `lib/config.ts` / `lib/packagePaths.ts` -- this module is
 * mocked wholesale in tests (see jest.config.cjs `moduleNameMapper`)
 * instead of being transpiled.
 */
export function isViteDev(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof window !== 'undefined' && !!(import.meta as any)?.env?.DEV;
  } catch {
    return false;
  }
}
