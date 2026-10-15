/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The compare page's selected runs, IN SELECTION (URL) ORDER.
 *
 * `?runs=X,Y` means A = X, B = Y: the scoreboard rows, the table columns, the
 * deep-dive header/narrative and the deep-dive job's report order all derive
 * from this list, so they agree with each other and with the URL. The page
 * used to filter the run POOL by the selection instead, which silently
 * re-ordered the pair to the pool's order (typically newest first) — A/B came
 * out reversed from the URL, and "Swap A↔B" (which reorders the selection)
 * changed the URL but nothing on the page.
 *
 * Ids the pool does not (yet) contain are skipped; duplicates keep their
 * first position only.
 */
export function orderSelectedRuns<R extends { id: string }>(pool: readonly R[], selectedRunIds: readonly string[]): R[] {
  const byId = new Map(pool.map((r) => [r.id, r] as const));
  const seen = new Set<string>();
  const out: R[] = [];
  for (const id of selectedRunIds) {
    const run = byId.get(id);
    if (run && !seen.has(id)) { seen.add(id); out.push(run); }
  }
  return out;
}
