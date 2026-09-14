/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { groupCasesByDescribe } from '@/lib/describeGroups';

describe('groupCasesByDescribe', () => {
  it('groups by describePath[0] in first-seen order and keeps legacy cases ungrouped', () => {
    const r = groupCasesByDescribe([
      { id: 'a', describePath: ['Suite A', 'Inner'] },
      { id: 'legacy' },                           // imported before the field existed
      { id: 'b', describePath: ['Suite B'] },
      { id: 'top', describePath: [] },            // code test at file top level
      { id: 'a2', describePath: ['Suite A'] },
      { id: 'bad', describePath: 'Suite A' as unknown as string[] }, // malformed → ungrouped, never "undefined"
    ]);
    expect(r.groups).toEqual([
      { title: 'Suite A', ids: ['a', 'a2'] },
      { title: 'Suite B', ids: ['b'] },
    ]);
    expect(r.ungroupedIds).toEqual(['legacy', 'top', 'bad']);
    expect(r.groups.some(g => g.title === 'undefined')).toBe(false);
  });

  it('returns no groups when nothing carries a describe chain', () => {
    expect(groupCasesByDescribe([{ id: 'x' }, { id: 'y', describePath: [] }])).toEqual({ groups: [], ungroupedIds: ['x', 'y'] });
  });
});
