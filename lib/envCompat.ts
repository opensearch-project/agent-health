/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment Variable Compatibility Layer
 *
 * Soft-deprecation helper for the `AGENT_HEALTH_*` → `AH_*` env var rename.
 *
 * Read sites should prefer the new `AH_*` name but fall back to the old
 * `AGENT_HEALTH_*` name for one release. Old names emit a one-time
 * deprecation warning per process.
 *
 * Example:
 *
 *   const port = readEnv('AH_PORT', 'AGENT_HEALTH_PORT');
 *
 * The old name is scheduled for removal in a future major release.
 */

const warned = new Set<string>();

/**
 * Read an env var, preferring `newName`, falling back to `oldName`.
 * Returns `undefined` when neither is set.
 *
 * On first use of the old name in the current process, prints a one-time
 * deprecation warning to stderr.
 */
export function readEnv(newName: string, oldName: string): string | undefined {
  const newVal = process.env[newName];
  if (newVal !== undefined) return newVal;

  const oldVal = process.env[oldName];
  if (oldVal !== undefined) {
    warnDeprecated(oldName, newName);
    return oldVal;
  }

  return undefined;
}

/**
 * Whether the old name is currently set (regardless of the new name).
 * Useful for tests that exercise deprecation paths without triggering reads.
 */
export function isLegacyEnvSet(oldName: string): boolean {
  return process.env[oldName] !== undefined;
}

/**
 * Emit a one-time deprecation warning for an old env var name.
 * Subsequent calls for the same `oldName` are no-ops.
 *
 * Suppressed when AH_QUIET_DEPRECATIONS=1 (also accepts the old prefix
 * AGENT_HEALTH_QUIET_DEPRECATIONS=1) so tests and CI can stay quiet.
 */
export function warnDeprecated(oldName: string, newName: string): void {
  if (warned.has(oldName)) return;
  warned.add(oldName);

  if (
    process.env.AH_QUIET_DEPRECATIONS === '1' ||
    process.env.AGENT_HEALTH_QUIET_DEPRECATIONS === '1'
  ) {
    return;
  }

  // Use console.warn so this surfaces in normal stderr but doesn't crash
  // structured-logging consumers. Prefix matches the rest of the codebase.
  console.warn(
    `[agent-health] Deprecated env var ${oldName} is set; please rename it to ${newName}. ` +
    `The old name will be removed in a future release.`
  );
}

/**
 * TEST-ONLY: reset the warned set so a single test process can exercise
 * multiple deprecation paths without one suppressing the next.
 */
export function _resetDeprecationCacheForTests(): void {
  warned.clear();
}
