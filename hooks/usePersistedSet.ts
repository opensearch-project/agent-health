/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react';
import { usePersistedState } from './usePersistedState';

/**
 * Set-shaped variant of usePersistedState. Persists the contents as a JSON
 * array under `agent-health:<key>` and exposes a `Set<T>` to consumers so
 * call sites that already use `Set.has(...)`, `Set.size`, etc. can migrate
 * with minimal churn.
 *
 * Usage:
 *   const [collapsedGroups, setCollapsedGroups] =
 *     usePersistedSet<string>('eval-runs:collapsedGroups');
 *
 *   // Functional update — receives and returns a Set, just like useState
 *   setCollapsedGroups(prev => {
 *     const n = new Set(prev);
 *     n.has(id) ? n.delete(id) : n.add(id);
 *     return n;
 *   });
 *
 * Notes:
 *  - The on-disk format is `T[]` (a JSON array), so it survives `JSON.parse`
 *    round-trips. Order within the Set is not preserved across reloads.
 *  - The returned Set instance is referentially stable per underlying array
 *    via useMemo, so React effect deps that depend on the Set won't fire on
 *    every render unless the contents actually changed.
 */
export function usePersistedSet<T>(
  key: string,
  defaultValue: ReadonlyArray<T> = []
): [Set<T>, (value: Set<T> | ((prev: Set<T>) => Set<T>)) => void] {
  const [arr, setArr] = usePersistedState<T[]>(key, [...defaultValue]);

  const set = useMemo(() => new Set<T>(arr), [arr]);

  const setSet = useCallback(
    (value: Set<T> | ((prev: Set<T>) => Set<T>)) => {
      setArr(prevArr => {
        const prevSet = new Set<T>(prevArr);
        const nextSet = typeof value === 'function'
          ? (value as (prev: Set<T>) => Set<T>)(prevSet)
          : value;
        return Array.from(nextSet);
      });
    },
    [setArr]
  );

  return [set, setSet];
}
