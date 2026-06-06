/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { cn, getLabelColor, getDifficultyColor, formatDate, formatRelativeTime, getModelName, truncate, getRunShortId, getRunDisplayName, getRunOverallScore } from '@/lib/utils';

describe('lib/utils', () => {
  describe('cn', () => {
    it('should merge class names', () => {
      const result = cn('class1', 'class2');
      expect(result).toContain('class1');
      expect(result).toContain('class2');
    });

    it('should handle conditional classes', () => {
      const result = cn('base', true && 'active', false && 'disabled');
      expect(result).toContain('base');
      expect(result).toContain('active');
      expect(result).not.toContain('disabled');
    });

    it('should merge tailwind classes correctly', () => {
      // twMerge should deduplicate conflicting classes
      const result = cn('p-2', 'p-4');
      // Last one wins
      expect(result).toBe('p-4');
    });

    it('should handle undefined and null', () => {
      const result = cn('class1', undefined, null, 'class2');
      expect(result).toContain('class1');
      expect(result).toContain('class2');
    });

    it('should handle empty input', () => {
      const result = cn();
      expect(result).toBe('');
    });
  });

  describe('getLabelColor', () => {
    it('should return specific color for difficulty:Easy', () => {
      const color = getLabelColor('difficulty:Easy');
      expect(color).toContain('blue');
    });

    it('should return specific color for difficulty:Medium', () => {
      const color = getLabelColor('difficulty:Medium');
      expect(color).toContain('yellow');
    });

    it('should return specific color for difficulty:Hard', () => {
      const color = getLabelColor('difficulty:Hard');
      expect(color).toContain('red');
    });

    it('should return hash-based color for other labels', () => {
      const color1 = getLabelColor('category:RCA');
      const color2 = getLabelColor('type:test');

      // Should return valid color classes
      expect(color1).toMatch(/bg-\w+/);
      expect(color2).toMatch(/bg-\w+/);
    });

    it('should return consistent colors for same label', () => {
      const color1 = getLabelColor('custom:label');
      const color2 = getLabelColor('custom:label');
      expect(color1).toBe(color2);
    });

    it('should return different colors for different labels', () => {
      // Different labels should generally get different colors (hash-based)
      const color1 = getLabelColor('category:A');
      const color2 = getLabelColor('category:B');
      // They might occasionally collide due to hash, but typically different
      expect(color1).toBeDefined();
      expect(color2).toBeDefined();
    });
  });

  describe('getDifficultyColor', () => {
    it('should return blue color for Easy', () => {
      const color = getDifficultyColor('Easy');
      expect(color).toContain('blue');
    });

    it('should return yellow color for Medium', () => {
      const color = getDifficultyColor('Medium');
      expect(color).toContain('yellow');
    });

    it('should return red color for Hard', () => {
      const color = getDifficultyColor('Hard');
      expect(color).toContain('red');
    });

    it('should default to Medium color for unknown difficulty', () => {
      const color = getDifficultyColor('Unknown' as any);
      expect(color).toContain('yellow');
    });
  });

  describe('formatDate', () => {
    const testTimestamp = '2024-06-15T14:30:45.000Z';

    it('should format date only when variant is date', () => {
      const result = formatDate(testTimestamp, 'date');
      expect(result).toContain('Jun');
      expect(result).toContain('15');
      expect(result).toContain('2024');
      // Should not contain time
      expect(result).not.toMatch(/:\d{2}/);
    });

    it('should format date with time when variant is datetime (default)', () => {
      const result = formatDate(testTimestamp);
      expect(result).toContain('Jun');
      expect(result).toContain('15');
      expect(result).toContain('2024');
      // Should contain hours and minutes
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should format date with seconds when variant is detailed', () => {
      const result = formatDate(testTimestamp, 'detailed');
      expect(result).toContain('Jun');
      // Should contain seconds
      expect(result).toMatch(/:\d{2}:\d{2}/);
    });

    it('should handle different timestamps', () => {
      // Use mid-day times to avoid timezone edge cases
      const result1 = formatDate('2024-01-15T12:00:00.000Z', 'date');
      expect(result1).toContain('Jan');
      expect(result1).toContain('15');

      const result2 = formatDate('2024-12-15T12:00:00.000Z', 'date');
      expect(result2).toContain('Dec');
      expect(result2).toContain('15');
    });
  });

  describe('formatRelativeTime', () => {
    it('should return "Just now" for very recent timestamps', () => {
      const now = new Date();
      const result = formatRelativeTime(now.toISOString());
      expect(result).toBe('Just now');
    });

    it('should return minutes ago for timestamps less than an hour', () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const result = formatRelativeTime(fiveMinutesAgo.toISOString());
      expect(result).toBe('5m ago');
    });

    it('should return hours ago for timestamps less than a day', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const result = formatRelativeTime(threeHoursAgo.toISOString());
      expect(result).toBe('3h ago');
    });

    it('should return days ago for timestamps less than a week', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const result = formatRelativeTime(twoDaysAgo.toISOString());
      expect(result).toBe('2d ago');
    });

    it('should return formatted date for timestamps older than a week', () => {
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const result = formatRelativeTime(twoWeeksAgo.toISOString());
      // Should contain month abbreviation (formatted date)
      expect(result).toMatch(/[A-Z][a-z]{2}/);
    });
  });

  describe('getModelName', () => {
    it('should return display name for known model', () => {
      const name = getModelName('claude-sonnet-4');
      expect(name).toBe('Claude Sonnet 4');
    });

    it('should return display name for claude-sonnet-4.5', () => {
      const name = getModelName('claude-sonnet-4.5');
      expect(name).toBe('Claude Sonnet 4.5');
    });

    it('should return display name for claude-haiku-3.5', () => {
      const name = getModelName('claude-haiku-3.5');
      expect(name).toBe('Claude Haiku 3.5');
    });

    it('should return modelId for unknown model', () => {
      const name = getModelName('unknown-model');
      expect(name).toBe('unknown-model');
    });
  });

  describe('truncate', () => {
    it('should not truncate short text', () => {
      const result = truncate('Hello', 10);
      expect(result).toBe('Hello');
    });

    it('should truncate long text with ellipsis', () => {
      const result = truncate('Hello World This is a long text', 10);
      expect(result).toBe('Hello Worl...');
      expect(result.length).toBe(13); // 10 chars + '...'
    });

    it('should handle exact length match', () => {
      const result = truncate('Hello', 5);
      expect(result).toBe('Hello');
    });

    it('should handle empty string', () => {
      const result = truncate('', 10);
      expect(result).toBe('');
    });

    it('should trim whitespace before adding ellipsis', () => {
      const result = truncate('Hello    World', 8);
      // Should trim trailing spaces before ellipsis
      expect(result).toBe('Hello...');
    });
  });

  // ============================================================================
  // Run display helpers
  //
  // These two helpers back the new runs-list rendering on the Test Case detail
  // page, where every persisted run is expected to show a stable, human-readable
  // label — either the user-supplied name or an auto-generated `Run <short-id>`
  // fallback for legacy data created before `TestCaseRun.name` existed.
  // Regression-locking them prevents the UI from sliding back into the old
  // `report-178…` id-slice rendering.
  // ============================================================================
  describe('getRunShortId', () => {
    it('returns the trailing 6 characters for typical report ids', () => {
      // Storage adapter shape: `report-<timestamp>-<random>` — the random
      // suffix is the visually distinguishing part, so trimming to the
      // tail keeps short-ids unique within a session.
      expect(getRunShortId('report-1780000000000-j0tutlwx1')).toBe('utlwx1');
    });

    it('returns the full id when shorter than 6 characters (legacy/short ids)', () => {
      expect(getRunShortId('abc')).toBe('abc');
      expect(getRunShortId('123456')).toBe('123456');
    });

    it('returns an empty string for an empty id rather than throwing', () => {
      expect(getRunShortId('')).toBe('');
    });
  });

  describe('getRunDisplayName', () => {
    it('prefers the persisted run name when set', () => {
      expect(getRunDisplayName({ id: 'report-1780000000000-j0tutlwx1', name: 'Baseline' })).toBe('Baseline');
    });

    it('trims the persisted name to avoid leading/trailing whitespace bleed', () => {
      expect(getRunDisplayName({ id: 'report-x', name: '  Claude_02  ' })).toBe('Claude_02');
    });

    it('falls back to `Run <short-id>` when name is missing (legacy data)', () => {
      expect(getRunDisplayName({ id: 'report-1780000000000-j0tutlwx1' })).toBe('Run utlwx1');
    });

    it('falls back when name is an empty / whitespace-only string', () => {
      expect(getRunDisplayName({ id: 'report-1780000000000-j0tutlwx1', name: '' })).toBe('Run utlwx1');
      expect(getRunDisplayName({ id: 'report-1780000000000-j0tutlwx1', name: '   ' })).toBe('Run utlwx1');
    });
  });

  // Regression-locks the bug that made every run in the runs list show `0%`:
  // the UI used to read `run.metrics?.accuracy ?? 0`, but only the RCA Default
  // evaluator emits an `accuracy` metric — every other evaluator emits its
  // own metric names (`tool_selection_accuracy`, `reasoning_coherence`, etc.).
  // `getRunOverallScore` averages whatever numeric metrics exist so the runs
  // list shows a meaningful number for any evaluator.
  describe('getRunOverallScore', () => {
    it('returns the rounded mean of populated numeric metrics', () => {
      // Mixed evaluator: tool-use + safety metrics in one run
      expect(getRunOverallScore({
        tool_selection_accuracy: 80,
        redundant_calls: 90,
        tool_ordering: 70,
      })).toBe(80);
    });

    it('rounds to the nearest integer', () => {
      // (33 + 34) / 2 = 33.5 → 34
      expect(getRunOverallScore({ a: 33, b: 34 })).toBe(34);
      // (10 + 20 + 30) / 3 = 20
      expect(getRunOverallScore({ a: 10, b: 20, c: 30 })).toBe(20);
    });

    it('ignores undefined / non-numeric metric values without skewing the mean', () => {
      // Used to be: `|| 0` defaults turned undefined into 0 and dragged the
      // mean down. Now those entries are simply skipped.
      expect(getRunOverallScore({
        accuracy: 100,
        faithfulness: undefined,
        latency_score: undefined,
        trajectory_alignment_score: undefined,
      })).toBe(100);
    });

    it('ignores NaN and Infinity (defensive against bad data)', () => {
      expect(getRunOverallScore({
        a: 50,
        b: NaN as any,
        c: Infinity as any,
      })).toBe(50);
    });

    it('returns null when no numeric metrics are present', () => {
      // Critical: this is what makes the UI render `—` instead of `0%` for
      // runs that haven't been judged yet, or whose evaluator emitted nothing.
      expect(getRunOverallScore({})).toBeNull();
      expect(getRunOverallScore(undefined)).toBeNull();
      expect(getRunOverallScore(null)).toBeNull();
      expect(getRunOverallScore({ a: undefined, b: undefined })).toBeNull();
    });

    it('preserves a legitimate zero score (does not collapse to null)', () => {
      // 0% is a real outcome — the helper must not treat it as missing.
      expect(getRunOverallScore({ accuracy: 0 })).toBe(0);
      expect(getRunOverallScore({ a: 0, b: 0 })).toBe(0);
    });
  });
});
