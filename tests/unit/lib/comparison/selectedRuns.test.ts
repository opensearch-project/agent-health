/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * lib/comparison/selectedRuns.ts — the compare page's A/B/C… order is the
 * SELECTION (URL) order, not the run pool's. Owner report: `?runs=<X>,<Y>`
 * rendered A = Y, B = X because the page filtered the (newest-first) pool by
 * the selection instead of mapping the selection onto the pool.
 */

import { orderSelectedRuns } from '@/lib/comparison/selectedRuns';

const pool = [{ id: 'newest' }, { id: 'mid' }, { id: 'oldest' }];

describe('orderSelectedRuns', () => {
  it('returns the selected runs in selection order, whatever the pool order is', () => {
    expect(orderSelectedRuns(pool, ['oldest', 'newest']).map((r) => r.id)).toEqual(['oldest', 'newest']);
    expect(orderSelectedRuns(pool, ['newest', 'oldest']).map((r) => r.id)).toEqual(['newest', 'oldest']);
    expect(orderSelectedRuns(pool, ['mid', 'oldest', 'newest']).map((r) => r.id)).toEqual(['mid', 'oldest', 'newest']);
  });

  it('a swap of the first two ids swaps A and B', () => {
    const ids = ['oldest', 'newest', 'mid'];
    const swapped = [ids[1], ids[0], ...ids.slice(2)];
    expect(orderSelectedRuns(pool, swapped).map((r) => r.id)).toEqual(['newest', 'oldest', 'mid']);
  });

  it('skips ids the pool does not contain and keeps only the first occurrence of a duplicate', () => {
    expect(orderSelectedRuns(pool, ['ghost', 'mid', 'mid', 'oldest']).map((r) => r.id)).toEqual(['mid', 'oldest']);
    expect(orderSelectedRuns(pool, [])).toEqual([]);
    expect(orderSelectedRuns([], ['mid'])).toEqual([]);
  });

  it('returns the pool\'s own objects (no copies), so downstream identity-based memoisation keeps working', () => {
    expect(orderSelectedRuns(pool, ['mid'])[0]).toBe(pool[1]);
  });
});
