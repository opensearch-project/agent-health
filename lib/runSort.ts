/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparators for sorting evaluation-run rows and run-groups newest-first.
 *
 * Extracted from EvalRunsPage so the "grouped view sorts groups by most
 * recent run, not alphabetically by benchmark name" rule is a plain,
 * unit-testable function instead of logic buried inside a `useMemo`.
 */

export interface HasCreatedAt {
  createdAt: string;
}

/**
 * Most recent `createdAt` timestamp (ms since epoch) across a list of runs.
 * Empty/all-invalid input returns 0 so a group with no valid timestamps
 * sorts to the oldest position rather than throwing or sorting first.
 */
export function mostRecentTime(items: HasCreatedAt[]): number {
  let max = 0;
  for (const item of items) {
    const t = new Date(item.createdAt).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Sort groups (e.g. "runs grouped by benchmark") by each group's most
 * recent run — descending, so the group with the latest activity is first.
 * Ties (including empty groups, which compare equal at 0) preserve the
 * original relative order (stable sort).
 *
 * @param groups - the groups to sort
 * @param getItems - extracts the timestamped items (e.g. runs) from a group
 */
export function sortGroupsByRecency<T>(groups: T[], getItems: (group: T) => HasCreatedAt[]): T[] {
  return [...groups].sort((a, b) => mostRecentTime(getItems(b)) - mostRecentTime(getItems(a)));
}
