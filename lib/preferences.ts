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
 * Storage layout is intentionally a flat, JSON-serialisable key/value
 * map: each preference is its own localStorage entry. That keeps the
 * format portable so prefs can be exported, copied across environments,
 * or backed up to a server store later without rewriting call sites.
 *
 * Helpers `getPreferencesSnapshot()` / `applyPreferencesSnapshot()`
 * below give a single-call dump and restore for that bundle, which is
 * the natural shape to send over the network.
 */

/** Stable, user-facing namespace for all cross-page preferences. */
export const PREFS_KEYS = {
  /** Run-config: agent the user wants to RUN (QuickRunModal, NewRunPage). */
  agentKey: 'prefs:agentKey',
  /** Run-config: model the user wants to RUN (QuickRunModal, NewRunPage). */
  modelId: 'prefs:modelId',
  /** Time-range filter, shared by evaluation list pages and Agent Traces. */
  timeRange: 'prefs:timeRange',
  /** Agent filter dropdown shared by Benchmarks and Eval Runs. Defaults to `'all'`. */
  agentFilter: 'prefs:agentFilter',
  /** Benchmark filter dropdown shared by Test Cases (and any future page). */
  benchmarkFilter: 'prefs:benchmarkFilter',
  /** Flat / grouped view mode shared by list pages. */
  viewMode: 'prefs:viewMode',
} as const;

/** Possible string values for {@link PREFS_KEYS.timeRange}. */
export type SharedTimeRange = '1h' | '6h' | '1d' | '7d' | '30d' | 'all';

/**
 * Convert a {@link SharedTimeRange} to a "minutes ago" cutoff suitable
 * for the AgentTraces query. `'all'` is mapped to a very large window
 * (90d) so that there's always *some* finite cutoff sent to the server.
 */
export function sharedTimeRangeToMinutes(range: SharedTimeRange): number {
  switch (range) {
    case '1h': return 60;
    case '6h': return 360;
    case '1d': return 1440;
    case '7d': return 10080;
    case '30d': return 43200;
    case 'all': return 60 * 24 * 90; // 90 days as a practical "all"
  }
}

const STORAGE_PREFIX = 'agent-health:';

/**
 * Return a portable snapshot of every cross-page preference currently
 * stored in localStorage. Keys are the unprefixed identifiers (e.g.
 * `'prefs:timeRange'`) and values are already JSON-decoded.
 *
 * Use this to copy a user's preferences to clipboard, persist them
 * server-side, or assert against them in tests.
 */
export function getPreferencesSnapshot(): Record<string, unknown> {
  if (typeof window === 'undefined') return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.values(PREFS_KEYS)) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      if (raw === null) continue;
      out[key] = JSON.parse(raw);
    } catch {
      // Skip entries we can't decode; the caller will treat them as
      // missing and the corresponding page will fall back to its default.
    }
  }
  return out;
}

/**
 * Apply a snapshot produced by {@link getPreferencesSnapshot}.
 * Unknown keys are ignored so the snapshot format stays forward-
 * compatible with future preferences. Pass an empty object to clear
 * every preference (sets nothing — call {@link clearPreferences} for
 * an explicit reset).
 */
export function applyPreferencesSnapshot(snapshot: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const known = new Set<string>(Object.values(PREFS_KEYS));
  for (const [key, value] of Object.entries(snapshot)) {
    if (!known.has(key)) continue;
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Quota / storage disabled — ignore.
    }
  }
}

/**
 * Remove every preference from localStorage. Useful for "Reset
 * preferences" buttons and tests.
 */
export function clearPreferences(): void {
  if (typeof window === 'undefined') return;
  for (const key of Object.values(PREFS_KEYS)) {
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      // ignore
    }
  }
}
