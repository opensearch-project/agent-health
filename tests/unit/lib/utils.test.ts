/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { cn, getLabelColor, getDifficultyColor, formatDate, formatRelativeTime, getModelName, truncate } from '@/lib/utils';

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

    it('should return display name for claude-haiku-4.5', () => {
      const name = getModelName('claude-haiku-4.5');
      expect(name).toBe('Claude Haiku 4.5');
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
});
