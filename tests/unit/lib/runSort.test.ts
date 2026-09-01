/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mostRecentTime, sortGroupsByRecency } from '@/lib/runSort';

describe('mostRecentTime', () => {
  it('returns 0 for an empty list', () => {
    expect(mostRecentTime([])).toBe(0);
  });

  it('returns the max createdAt across items', () => {
    const items = [
      { createdAt: '2024-01-01T00:00:00Z' },
      { createdAt: '2024-06-01T00:00:00Z' },
      { createdAt: '2024-03-01T00:00:00Z' },
    ];
    expect(mostRecentTime(items)).toBe(new Date('2024-06-01T00:00:00Z').getTime());
  });

  it('ignores unparseable dates rather than throwing', () => {
    const items = [
      { createdAt: 'not-a-date' },
      { createdAt: '2024-01-01T00:00:00Z' },
    ];
    expect(mostRecentTime(items)).toBe(new Date('2024-01-01T00:00:00Z').getTime());
  });
});

describe('sortGroupsByRecency', () => {
  it('orders groups by their most recent run, not alphabetically', () => {
    // Regression for the owner-reported bug: grouping used to sort groups
    // alphabetically by benchmark name, then time within each group — so a
    // benchmark named "Zebra" run seconds ago sorted BELOW a "Apple" group
    // whose latest run is a week old. Newest overall activity must win.
    const groups = [
      { name: 'Apple', runs: [{ createdAt: '2024-01-01T00:00:00Z' }] },
      { name: 'Zebra', runs: [{ createdAt: '2024-06-01T00:00:00Z' }] },
      { name: 'Mango', runs: [{ createdAt: '2024-03-01T00:00:00Z' }] },
    ];
    const sorted = sortGroupsByRecency(groups, g => g.runs);
    expect(sorted.map(g => g.name)).toEqual(['Zebra', 'Mango', 'Apple']);
  });

  it('uses the max run time within a group, not the first/last run', () => {
    const groups = [
      { name: 'A', runs: [{ createdAt: '2024-01-01T00:00:00Z' }, { createdAt: '2024-01-05T00:00:00Z' }] },
      { name: 'B', runs: [{ createdAt: '2024-01-03T00:00:00Z' }] },
    ];
    const sorted = sortGroupsByRecency(groups, g => g.runs);
    // A's latest run (Jan 5) is more recent than B's only run (Jan 3).
    expect(sorted.map(g => g.name)).toEqual(['A', 'B']);
  });

  it('treats an empty group as least recent', () => {
    const groups = [
      { name: 'Empty', runs: [] as { createdAt: string }[] },
      { name: 'HasRuns', runs: [{ createdAt: '2024-01-01T00:00:00Z' }] },
    ];
    const sorted = sortGroupsByRecency(groups, g => g.runs);
    expect(sorted.map(g => g.name)).toEqual(['HasRuns', 'Empty']);
  });

  it('does not mutate the input array', () => {
    const groups = [
      { name: 'A', runs: [{ createdAt: '2024-01-01T00:00:00Z' }] },
      { name: 'B', runs: [{ createdAt: '2024-06-01T00:00:00Z' }] },
    ];
    const original = [...groups];
    sortGroupsByRecency(groups, g => g.runs);
    expect(groups).toEqual(original);
  });
});
