/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TestCase } from '@/types';

export interface DescribeGroup {
  /** `describePath[0]` — the outermost describe() title. */
  title: string;
  /** Test-case ids in this group (insertion order). */
  ids: string[];
}

export interface DescribeGrouping {
  /** Groups in first-seen order. Empty when no case carries a describe chain. */
  groups: DescribeGroup[];
  /** Cases with no (or an empty) `describePath` — shown without a group. */
  ungroupedIds: string[];
}

/**
 * Group a benchmark's cases by the OUTERMOST describe() title. Cases whose
 * `describePath` is absent, empty, or malformed are "ungrouped" — they never
 * produce an `"undefined"` bucket (legacy imports predate the field).
 */
export function groupCasesByDescribe(
  testCases: Array<Pick<TestCase, 'id' | 'describePath'>>,
): DescribeGrouping {
  const byTitle = new Map<string, string[]>();
  const ungroupedIds: string[] = [];
  for (const tc of testCases) {
    const first = Array.isArray(tc.describePath) ? tc.describePath[0] : undefined;
    if (typeof first !== 'string' || first.length === 0) {
      ungroupedIds.push(tc.id);
      continue;
    }
    const list = byTitle.get(first) ?? [];
    list.push(tc.id);
    byTitle.set(first, list);
  }
  return {
    groups: [...byTitle.entries()].map(([title, ids]) => ({ title, ids })),
    ungroupedIds,
  };
}
