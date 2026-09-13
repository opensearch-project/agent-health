/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest mock for lib/viteEnv -- avoids parsing `import.meta` (see
 * lib/viteEnv.ts's header comment). Tests that care about the "dev build"
 * path drive it via `isDebugEnabled()` (lib/debug.ts) instead, which covers
 * the same `isPageLatencyActive()` OR-branch without needing import.meta.
 */
export function isViteDev(): boolean {
  return false;
}
