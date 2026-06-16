/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * mapPool — run an async fn over items with bounded concurrency.
 *
 * The concurrency cap is the workflow's primary cost + blast-radius control:
 * in `new` mode it bounds how many live agent investigations run at once.
 * Returns results in input order; rejects on the first error.
 */

export interface PoolStats {
  /** Highest number of simultaneously-active tasks observed. */
  peakConcurrency: number;
}

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  stats?: PoolStats
): Promise<R[]> {
  const max = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let next = 0;
  let active = 0;
  let settled = 0;
  let rejected = false;

  return new Promise<R[]>((resolve, reject) => {
    if (items.length === 0) return resolve(results);

    const pump = () => {
      if (rejected) return;
      while (active < max && next < items.length) {
        const i = next++;
        active++;
        if (stats) stats.peakConcurrency = Math.max(stats.peakConcurrency, active);
        Promise.resolve(fn(items[i], i))
          .then((r) => {
            results[i] = r;
            active--;
            settled++;
            if (settled === items.length) resolve(results);
            else pump();
          })
          .catch((err) => {
            rejected = true;
            reject(err);
          });
      }
    };

    pump();
  });
}
