/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-page user preferences.
 *
 * Each entry below is a single localStorage key (under the
 * `agent-health:` prefix) shared by every page that exposes the
 * corresponding control, so e.g. picking "30d" on the Eval Runs page is
 * also reflected on Benchmarks and Test Cases.
 *
 * `migrateLegacyPreferences()` (called once at app boot, see App.tsx) fills
 * each new key from the most likely pre-existing per-page key, so users do
 * not lose their previously-saved selections on upgrade.
 */

/** Stable, user-facing namespace for all cross-page preferences. */
export const PREFS_KEYS = {
  /** Run-config: agent the user wants to RUN (QuickRunModal, NewRunPage). */
  agentKey: 'prefs:agentKey',
  /** Run-config: model the user wants to RUN (QuickRunModal, NewRunPage). */
  modelId: 'prefs:modelId',
  /** Time-range filter, shared by evaluation list pages. */
  timeRange: 'prefs:timeRange',
  /** Agent filter dropdown shared by list pages (defaults to `'all'`). */
  agentFilter: 'prefs:agentFilter',
  /** Benchmark filter dropdown shared by list pages (defaults to `'all'`). */
  benchmarkFilter: 'prefs:benchmarkFilter',
  /** Flat / grouped view mode shared by list pages. */
  viewMode: 'prefs:viewMode',
} as const;

const STORAGE_PREFIX = 'agent-health:';

/**
 * Per-shared-key list of legacy keys to scavenge from when migrating, in
 * priority order. The first legacy key that has a value wins — this is a
 * heuristic ("the user probably configured the most-recently-touched page
 * first") and means a user can lose state on rare cross-page disagreements.
 * The trade-off is acceptable because:
 *   - A reasonable fallback is restored on the page they care about.
 *   - The legacy keys are only deleted *after* a successful migration.
 *   - Default values are unaffected (we only migrate non-empty values).
 *
 * Each entry is an *unprefixed* key. By default the lookup uses the
 * `agent-health:` prefix, but pre-namespacing keys (e.g. the very old
 * `agentTraces.*` ones) are listed in `LEGACY_RAW_MAP` below.
 */
const LEGACY_MAP: Record<string, string[]> = {
  [PREFS_KEYS.agentKey]: ['quick-run:agentKey', 'new-run:agentKey'],
  [PREFS_KEYS.modelId]: ['quick-run:modelId', 'new-run:modelId'],
  [PREFS_KEYS.timeRange]: ['eval-runs:timeRange', 'benchmarks:timeRange', 'test-cases:timeRange'],
  [PREFS_KEYS.agentFilter]: ['eval-runs:selectedAgent', 'benchmarks:selectedAgent', 'agent-traces:selectedAgent'],
  [PREFS_KEYS.benchmarkFilter]: ['test-cases:selectedBenchmark'],
  [PREFS_KEYS.viewMode]: ['eval-runs:viewMode', 'test-cases:viewMode'],
};

/**
 * Pre-namespacing legacy keys (no `agent-health:` prefix). These were
 * written by an older version of the app before keys were unified.
 * Each maps to a *full* localStorage key (whatever's in the browser today)
 * and a target unprefixed key inside our standard namespace.
 */
const LEGACY_RAW_MAP: Array<{ from: string; to: string }> = [
  // Pre-unification: AgentTracesPage wrote raw `agentTraces.*` keys.
  // The agent filter is now shared with other list pages, so it goes
  // straight to the new shared `prefs:agentFilter` key.
  { from: 'agentTraces.selectedAgent', to: PREFS_KEYS.agentFilter },
  // Time range stays page-specific (minute-based units, not the day-based
  // values used by the eval list pages).
  { from: 'agentTraces.timeRange', to: 'agent-traces:timeRange' },
];

/**
 * Run once at app boot. Idempotent — safe to call repeatedly.
 *
 * For each shared key:
 *   1. If the new `prefs:*` key already has a value, leave it.
 *   2. Otherwise scavenge from legacy per-page keys in priority order.
 *   3. After all keys have been considered, delete the legacy keys so the
 *      shared key is the single source of truth going forward.
 */
export function migrateLegacyPreferences(): void {
  if (typeof window === 'undefined') return;
  try {
    // Step 1 — promote pre-namespacing raw keys into our `agent-health:`
    // namespace. The legacy keys stored unencoded strings, so JSON-encode
    // them here so subsequent reads via `usePersistedState` (which goes
    // through `JSON.parse`) get the original string back unchanged.
    for (const { from, to } of LEGACY_RAW_MAP) {
      const fullTo = STORAGE_PREFIX + to;
      if (localStorage.getItem(fullTo) !== null) continue;
      const raw = localStorage.getItem(from);
      if (raw === null) continue;
      localStorage.setItem(fullTo, JSON.stringify(raw));
      localStorage.removeItem(from);
    }

    // Step 2 — scavenge new `prefs:*` keys from per-page legacy keys.
    for (const [newKey, legacyKeys] of Object.entries(LEGACY_MAP)) {
      const fullNewKey = STORAGE_PREFIX + newKey;
      if (localStorage.getItem(fullNewKey) !== null) continue;
      for (const legacyKey of legacyKeys) {
        const value = localStorage.getItem(STORAGE_PREFIX + legacyKey);
        if (value !== null) {
          localStorage.setItem(fullNewKey, value);
          break;
        }
      }
    }
    // Step 3 — drop legacy keys *after* every shared key has had a chance
    // to migrate so we don't lose state if multiple new keys read from the
    // same legacy key (none currently do, but the ordering is the safe one).
    for (const legacyKeys of Object.values(LEGACY_MAP)) {
      for (const legacyKey of legacyKeys) {
        localStorage.removeItem(STORAGE_PREFIX + legacyKey);
      }
    }
  } catch {
    // localStorage unavailable / quota exceeded — fall back silently.
  }
}
