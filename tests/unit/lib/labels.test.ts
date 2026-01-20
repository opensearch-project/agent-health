/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for labels.ts - unified label system utilities
 */

import {
  extractPrefix,
  extractValue,
  createLabel,
  getLabelDisplayName,
  hasPrefix,
  getUniquePrefixes,
  filterByPrefix,
  groupByPrefix,
  isDifficultyLabel,
  parseLabels,
  buildLabels,
  DIFFICULTY_VALUES,
} from '@/lib/labels';

describe('extractPrefix', () => {
  it('extracts prefix from prefixed label', () => {
    expect(extractPrefix('difficulty:Easy')).toBe('difficulty');
    expect(extractPrefix('category:RCA')).toBe('category');
    expect(extractPrefix('custom:value')).toBe('custom');
  });

  it('returns null for unprefixed label', () => {
    expect(extractPrefix('NoPrefix')).toBeNull();
    expect(extractPrefix('')).toBeNull();
  });

  it('handles label with multiple colons', () => {
    expect(extractPrefix('prefix:value:extra')).toBe('prefix');
  });

  it('returns null if colon is at start', () => {
    expect(extractPrefix(':value')).toBeNull();
  });
});

describe('extractValue', () => {
  it('extracts value from prefixed label', () => {
    expect(extractValue('difficulty:Easy')).toBe('Easy');
    expect(extractValue('category:RCA')).toBe('RCA');
  });

  it('returns full label if no prefix', () => {
    expect(extractValue('NoPrefix')).toBe('NoPrefix');
    expect(extractValue('')).toBe('');
  });

  it('handles label with multiple colons', () => {
    expect(extractValue('prefix:value:extra')).toBe('value:extra');
  });
});

describe('createLabel', () => {
  it('creates prefixed label', () => {
    expect(createLabel('difficulty', 'Easy')).toBe('difficulty:Easy');
    expect(createLabel('category', 'RCA')).toBe('category:RCA');
  });

  it('handles empty values', () => {
    expect(createLabel('prefix', '')).toBe('prefix:');
  });
});

describe('getLabelDisplayName', () => {
  it('returns value for prefixed labels', () => {
    expect(getLabelDisplayName('difficulty:Easy')).toBe('Easy');
  });

  it('returns full label for unprefixed labels', () => {
    expect(getLabelDisplayName('SimpleLabel')).toBe('SimpleLabel');
  });
});

describe('hasPrefix', () => {
  it('returns true for matching prefix', () => {
    expect(hasPrefix('difficulty:Easy', 'difficulty')).toBe(true);
    expect(hasPrefix('difficulty:Easy', 'difficulty:')).toBe(true);
  });

  it('returns false for non-matching prefix', () => {
    expect(hasPrefix('difficulty:Easy', 'category')).toBe(false);
    expect(hasPrefix('category:RCA', 'difficulty')).toBe(false);
  });

  it('returns false for unprefixed labels', () => {
    expect(hasPrefix('NoPrefix', 'any')).toBe(false);
  });
});

describe('getUniquePrefixes', () => {
  it('extracts unique prefixes from labels', () => {
    const labels = ['difficulty:Easy', 'difficulty:Hard', 'category:RCA', 'custom:val'];
    const prefixes = getUniquePrefixes(labels);
    expect(prefixes).toEqual(['category', 'custom', 'difficulty']);
  });

  it('returns empty array for empty input', () => {
    expect(getUniquePrefixes([])).toEqual([]);
  });

  it('excludes unprefixed labels', () => {
    const labels = ['difficulty:Easy', 'NoPrefixLabel'];
    const prefixes = getUniquePrefixes(labels);
    expect(prefixes).toEqual(['difficulty']);
  });

  it('returns sorted results', () => {
    const labels = ['z:1', 'a:2', 'm:3'];
    expect(getUniquePrefixes(labels)).toEqual(['a', 'm', 'z']);
  });
});

describe('filterByPrefix', () => {
  it('filters labels by prefix', () => {
    const labels = ['difficulty:Easy', 'difficulty:Hard', 'category:RCA'];
    expect(filterByPrefix(labels, 'difficulty')).toEqual(['difficulty:Easy', 'difficulty:Hard']);
  });

  it('accepts prefix with or without colon', () => {
    const labels = ['difficulty:Easy'];
    expect(filterByPrefix(labels, 'difficulty')).toEqual(['difficulty:Easy']);
    expect(filterByPrefix(labels, 'difficulty:')).toEqual(['difficulty:Easy']);
  });

  it('returns empty array when no matches', () => {
    expect(filterByPrefix(['category:RCA'], 'difficulty')).toEqual([]);
  });
});

describe('groupByPrefix', () => {
  it('groups labels by prefix', () => {
    const labels = ['difficulty:Easy', 'difficulty:Hard', 'category:RCA'];
    const groups = groupByPrefix(labels);
    expect(groups).toEqual({
      difficulty: ['difficulty:Easy', 'difficulty:Hard'],
      category: ['category:RCA'],
    });
  });

  it('groups unprefixed labels under empty string', () => {
    const labels = ['difficulty:Easy', 'NoPrefix', 'Another'];
    const groups = groupByPrefix(labels);
    expect(groups['']).toEqual(['NoPrefix', 'Another']);
    expect(groups['difficulty']).toEqual(['difficulty:Easy']);
  });

  it('returns empty object for empty input', () => {
    expect(groupByPrefix([])).toEqual({});
  });
});

describe('isDifficultyLabel', () => {
  it('returns true for difficulty labels', () => {
    expect(isDifficultyLabel('difficulty:Easy')).toBe(true);
    expect(isDifficultyLabel('difficulty:Medium')).toBe(true);
    expect(isDifficultyLabel('difficulty:Hard')).toBe(true);
  });

  it('returns false for non-difficulty labels', () => {
    expect(isDifficultyLabel('category:RCA')).toBe(false);
    expect(isDifficultyLabel('NoPrefix')).toBe(false);
  });
});

describe('parseLabels', () => {
  it('extracts difficulty from labels', () => {
    const result = parseLabels(['difficulty:Easy']);
    expect(result.difficulty).toBe('Easy');
  });

  it('extracts category from labels', () => {
    const result = parseLabels(['category:RCA']);
    expect(result.category).toBe('RCA');
  });

  it('extracts subcategory from labels', () => {
    const result = parseLabels(['subcategory:Logs']);
    expect(result.subcategory).toBe('Logs');
  });

  it('puts other labels in generic array', () => {
    const result = parseLabels(['custom:value', 'plain']);
    expect(result.generic).toEqual(['custom:value', 'plain']);
  });

  it('handles all label types together', () => {
    const labels = ['difficulty:Medium', 'category:RCA', 'subcategory:Logs', 'custom'];
    const result = parseLabels(labels);
    expect(result.difficulty).toBe('Medium');
    expect(result.category).toBe('RCA');
    expect(result.subcategory).toBe('Logs');
    expect(result.generic).toEqual(['custom']);
  });

  it('returns empty generic array for empty input', () => {
    expect(parseLabels([]).generic).toEqual([]);
  });

  it('only accepts valid difficulty values', () => {
    const result = parseLabels(['difficulty:Invalid']);
    expect(result.difficulty).toBeUndefined();
    expect(result.generic).toEqual([]);
  });

  it('validates all DIFFICULTY_VALUES', () => {
    for (const difficulty of DIFFICULTY_VALUES) {
      const result = parseLabels([`difficulty:${difficulty}`]);
      expect(result.difficulty).toBe(difficulty);
    }
  });
});

describe('buildLabels', () => {
  it('builds labels from difficulty field', () => {
    const labels = buildLabels({ difficulty: 'Easy' });
    expect(labels).toContain('difficulty:Easy');
  });

  it('builds labels from category field', () => {
    const labels = buildLabels({ category: 'RCA' });
    expect(labels).toContain('category:RCA');
  });

  it('builds labels from subcategory field', () => {
    const labels = buildLabels({ subcategory: 'Logs' });
    expect(labels).toContain('subcategory:Logs');
  });

  it('includes generic labels', () => {
    const labels = buildLabels({ generic: ['custom', 'another'] });
    expect(labels).toContain('custom');
    expect(labels).toContain('another');
  });

  it('builds from all fields', () => {
    const labels = buildLabels({
      difficulty: 'Medium',
      category: 'RCA',
      subcategory: 'Metrics',
      generic: ['extra'],
    });
    expect(labels).toEqual([
      'difficulty:Medium',
      'category:RCA',
      'subcategory:Metrics',
      'extra',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(buildLabels({})).toEqual([]);
  });
});
