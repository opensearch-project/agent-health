/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * consolidate() — cluster staged fixes by signature so a run raises ONE PR per
 * fix-class instead of one per ticket.
 *
 * This is intentionally conservative: it groups only on an exact signature
 * match. Loose clustering risks merging two genuinely-different bugs into one
 * confused PR, so the default bias is split-not-merge. Swap in an embedding /
 * correlation backend later without changing the workflow surface.
 */

import type { Cluster, StagedItem } from './types.js';

export async function consolidate(staged: StagedItem[]): Promise<Cluster[]> {
  const bySignature = new Map<string, StagedItem[]>();
  for (const s of staged) {
    const key = s.signature || 'unknown';
    const bucket = bySignature.get(key) ?? [];
    bucket.push(s);
    bySignature.set(key, bucket);
  }

  const clusters: Cluster[] = [];
  for (const [signature, items] of bySignature) {
    const tickets = items.map((i) => i.item);
    const traceIds = [...new Set(items.flatMap((i) => i.run.traceIds))];
    clusters.push({
      label: signature,
      signature,
      items,
      tickets,
      traceIds,
      fix: {
        summary:
          `Candidate fix for "${signature}" derived from ${tickets.length} ` +
          `ticket(s): ${tickets.map((t) => t.id).join(', ')}.`,
      },
    });
  }

  // Largest clusters first — the highest-leverage fixes surface at the top.
  clusters.sort((a, b) => b.items.length - a.items.length);
  return clusters;
}
