/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PREFS_KEYS,
  applyPreferencesSnapshot,
  clearPreferences,
  getPreferencesSnapshot,
  sharedTimeRangeToMinutes,
} from '@/lib/preferences';

const PREFIX = 'agent-health:';

function set(key: string, value: unknown): void {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}
function get(key: string): unknown {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? null : JSON.parse(raw);
}

describe('preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('PREFS_KEYS', () => {
    it('exposes a stable, namespaced key for every shared preference', () => {
      // The shape of these constants is part of the public contract:
      // call sites and exported snapshots reference them by string.
      expect(PREFS_KEYS).toEqual({
        agentKey: 'prefs:agentKey',
        modelId: 'prefs:modelId',
        timeRange: 'prefs:timeRange',
        agentFilter: 'prefs:agentFilter',
        benchmarkFilter: 'prefs:benchmarkFilter',
        viewMode: 'prefs:viewMode',
      });
    });
  });

  describe('sharedTimeRangeToMinutes', () => {
    it('translates each enum value to the expected minute count', () => {
      expect(sharedTimeRangeToMinutes('1h')).toBe(60);
      expect(sharedTimeRangeToMinutes('6h')).toBe(360);
      expect(sharedTimeRangeToMinutes('1d')).toBe(1440);
      expect(sharedTimeRangeToMinutes('7d')).toBe(10080);
      expect(sharedTimeRangeToMinutes('30d')).toBe(43200);
    });

    it("treats 'all' as a 90-day window so the AgentTraces query still has a finite cutoff", () => {
      expect(sharedTimeRangeToMinutes('all')).toBe(60 * 24 * 90);
    });
  });

  describe('getPreferencesSnapshot', () => {
    it('returns an empty object when nothing is stored', () => {
      expect(getPreferencesSnapshot()).toEqual({});
    });

    it('returns every known preference as a JSON-decoded value', () => {
      set(PREFS_KEYS.agentKey, 'observio');
      set(PREFS_KEYS.modelId, 'claude-sonnet-4.5');
      set(PREFS_KEYS.timeRange, '7d');
      set(PREFS_KEYS.agentFilter, 'all');
      set(PREFS_KEYS.benchmarkFilter, 'bm-123');
      set(PREFS_KEYS.viewMode, 'grouped');

      expect(getPreferencesSnapshot()).toEqual({
        [PREFS_KEYS.agentKey]: 'observio',
        [PREFS_KEYS.modelId]: 'claude-sonnet-4.5',
        [PREFS_KEYS.timeRange]: '7d',
        [PREFS_KEYS.agentFilter]: 'all',
        [PREFS_KEYS.benchmarkFilter]: 'bm-123',
        [PREFS_KEYS.viewMode]: 'grouped',
      });
    });

    it('skips entries with malformed JSON without throwing', () => {
      set(PREFS_KEYS.agentKey, 'observio');
      localStorage.setItem(PREFIX + PREFS_KEYS.timeRange, 'not-json{{{');
      expect(getPreferencesSnapshot()).toEqual({
        [PREFS_KEYS.agentKey]: 'observio',
      });
    });

    it('ignores non-prefs keys in the namespace', () => {
      // Set a non-prefs key — it must NOT appear in the snapshot
      localStorage.setItem(PREFIX + 'eval-runs:search', JSON.stringify('foo'));
      set(PREFS_KEYS.agentKey, 'observio');
      const snap = getPreferencesSnapshot();
      expect(snap).toEqual({ [PREFS_KEYS.agentKey]: 'observio' });
      expect((snap as Record<string, unknown>)['eval-runs:search']).toBeUndefined();
    });
  });

  describe('applyPreferencesSnapshot', () => {
    it('writes every known key into localStorage as JSON-encoded values', () => {
      applyPreferencesSnapshot({
        [PREFS_KEYS.agentKey]: 'observio',
        [PREFS_KEYS.timeRange]: '30d',
        [PREFS_KEYS.viewMode]: 'grouped',
      });
      expect(get(PREFS_KEYS.agentKey)).toBe('observio');
      expect(get(PREFS_KEYS.timeRange)).toBe('30d');
      expect(get(PREFS_KEYS.viewMode)).toBe('grouped');
    });

    it('overwrites any existing value for known keys', () => {
      set(PREFS_KEYS.agentKey, 'demo');
      applyPreferencesSnapshot({ [PREFS_KEYS.agentKey]: 'observio' });
      expect(get(PREFS_KEYS.agentKey)).toBe('observio');
    });

    it('ignores unknown keys for forward-compatibility', () => {
      applyPreferencesSnapshot({
        [PREFS_KEYS.agentKey]: 'observio',
        'prefs:future-key-we-have-not-added-yet': 'someValue',
      });
      expect(get(PREFS_KEYS.agentKey)).toBe('observio');
      expect(localStorage.getItem(PREFIX + 'prefs:future-key-we-have-not-added-yet')).toBeNull();
    });

    it('round-trips with getPreferencesSnapshot()', () => {
      const original = {
        [PREFS_KEYS.agentKey]: 'observio',
        [PREFS_KEYS.timeRange]: '7d',
        [PREFS_KEYS.viewMode]: 'flat',
      };
      applyPreferencesSnapshot(original);
      expect(getPreferencesSnapshot()).toEqual(original);
    });

    it('does not throw when localStorage rejects writes (quota / disabled)', () => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = jest.fn(() => { throw new Error('quota exceeded'); });
      expect(() => applyPreferencesSnapshot({ [PREFS_KEYS.agentKey]: 'observio' })).not.toThrow();
      Storage.prototype.setItem = original;
    });
  });

  describe('clearPreferences', () => {
    it('removes every shared key from localStorage', () => {
      for (const key of Object.values(PREFS_KEYS)) {
        set(key, 'sentinel');
      }
      clearPreferences();
      expect(getPreferencesSnapshot()).toEqual({});
    });

    it('leaves non-prefs keys alone', () => {
      set(PREFS_KEYS.agentKey, 'observio');
      localStorage.setItem(PREFIX + 'eval-runs:search', JSON.stringify('foo'));
      clearPreferences();
      expect(localStorage.getItem(PREFIX + 'eval-runs:search')).toBe(JSON.stringify('foo'));
    });
  });
});
