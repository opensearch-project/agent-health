/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { migrateLegacyPreferences, PREFS_KEYS } from '@/lib/preferences';

const PREFIX = 'agent-health:';

function set(key: string, value: unknown): void {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}
function get(key: string): unknown {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? null : JSON.parse(raw);
}

describe('migrateLegacyPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is a no-op when no legacy keys exist', () => {
    migrateLegacyPreferences();
    for (const key of Object.values(PREFS_KEYS)) {
      expect(get(key)).toBeNull();
    }
  });

  it('migrates `quick-run:agentKey` into `prefs:agentKey` and removes the legacy key', () => {
    set('quick-run:agentKey', 'observio');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.agentKey)).toBe('observio');
    expect(localStorage.getItem(PREFIX + 'quick-run:agentKey')).toBeNull();
  });

  it('prefers `quick-run:agentKey` over `new-run:agentKey`', () => {
    set('quick-run:agentKey', 'observio');
    set('new-run:agentKey', 'demo');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.agentKey)).toBe('observio');
  });

  it('falls back to `new-run:agentKey` when `quick-run:agentKey` is absent', () => {
    set('new-run:agentKey', 'demo');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.agentKey)).toBe('demo');
  });

  it('does not overwrite an existing `prefs:*` value', () => {
    set(PREFS_KEYS.agentKey, 'observio');
    set('quick-run:agentKey', 'demo');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.agentKey)).toBe('observio');
    // Legacy key is still removed once a value has been seen
    expect(localStorage.getItem(PREFIX + 'quick-run:agentKey')).toBeNull();
  });

  it('migrates the most-relevant legacy timeRange and clears the rest', () => {
    set('eval-runs:timeRange', '7d');
    set('benchmarks:timeRange', 'all');
    set('test-cases:timeRange', '30d');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.timeRange)).toBe('7d');
    expect(localStorage.getItem(PREFIX + 'eval-runs:timeRange')).toBeNull();
    expect(localStorage.getItem(PREFIX + 'benchmarks:timeRange')).toBeNull();
    expect(localStorage.getItem(PREFIX + 'test-cases:timeRange')).toBeNull();
  });

  it('migrates agent filter from any of the three list pages', () => {
    set('benchmarks:selectedAgent', 'observio');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.agentFilter)).toBe('observio');
  });

  it('migrates legacy unprefixed `agentTraces.selectedAgent` directly into `prefs:agentFilter`', () => {
    // Pre-namespacing key, no JSON wrapping
    localStorage.setItem('agentTraces.selectedAgent', 'observio');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.agentFilter)).toBe('observio');
    expect(localStorage.getItem('agentTraces.selectedAgent')).toBeNull();
  });

  it('migrates legacy unprefixed `agentTraces.timeRange` to the page-specific key', () => {
    localStorage.setItem('agentTraces.timeRange', '4320');
    migrateLegacyPreferences();
    // Page-specific key (not shared, units differ)
    expect(get('agent-traces:timeRange')).toBe('4320');
    expect(localStorage.getItem('agentTraces.timeRange')).toBeNull();
  });

  it('migrates viewMode preference', () => {
    set('test-cases:viewMode', 'grouped');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.viewMode)).toBe('grouped');
  });

  it('migrates benchmarkFilter preference', () => {
    set('test-cases:selectedBenchmark', 'bm-123');
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.benchmarkFilter)).toBe('bm-123');
  });

  it('is idempotent when called multiple times', () => {
    set('quick-run:agentKey', 'observio');
    migrateLegacyPreferences();
    migrateLegacyPreferences();
    migrateLegacyPreferences();
    expect(get(PREFS_KEYS.agentKey)).toBe('observio');
  });

  it('does not crash when localStorage throws (quota / disabled)', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = jest.fn(() => { throw new Error('quota exceeded'); });
    expect(() => migrateLegacyPreferences()).not.toThrow();
    Storage.prototype.setItem = original;
  });
});
