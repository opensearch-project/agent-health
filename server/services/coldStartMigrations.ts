/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cold-start migrations.
 *
 * Run idempotently on server boot after the storage backend is up. Each
 * migration is a small, focused, no-op-safe operation that brings stored
 * documents up to the current schema.
 *
 * Adding a migration:
 * 1. Implement an `async function migrateXxx(storage): Promise<MigrationStat>`
 * 2. Append it to `runColdStartMigrations` below
 * 3. Make it idempotent — if the data is already migrated, the function
 *    must short-circuit without writes.
 *
 * Migration status is surfaced in two places:
 * - Boot log (this module's `console.log` calls)
 * - GET /api/server-info (consumed by the UI banner)
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationReport, TestCase } from '../../types/index.js';
import { migrateLegacyFieldsToLabels, hasLabelPrefix } from '../../lib/testCaseLabels.js';
import { getJudgeVerdict } from '../../lib/reportVerdict.js';

export interface MigrationStat {
  name: string;
  ran: boolean;
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
  durationMs: number;
  notes?: string[];
}

let lastMigrationStats: MigrationStat[] = [];

export function getLastMigrationStats(): MigrationStat[] {
  return lastMigrationStats;
}

/**
 * Run all cold-start migrations. Logs a one-line summary per migration.
 *
 * Failures in individual migrations are logged but do not crash the server.
 * Storage errors that prevent reading test cases are surfaced as the
 * migration's `errors` count.
 */
export async function runColdStartMigrations(storage: IStorageModule): Promise<MigrationStat[]> {
  const migrations = [migrateCategoryDifficultyToLabels, migratePoisonedReportVerdicts];
  const stats: MigrationStat[] = [];

  for (const migration of migrations) {
    try {
      const stat = await migration(storage);
      stats.push(stat);
      logMigrationStat(stat);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const stat: MigrationStat = {
        name: migration.name,
        ran: false,
        scanned: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
        durationMs: 0,
        notes: [errMsg],
      };
      stats.push(stat);
      console.warn(`[migrations] ${migration.name} failed: ${errMsg}`);
    }
  }

  lastMigrationStats = stats;
  return stats;
}

function logMigrationStat(stat: MigrationStat): void {
  if (!stat.ran) {
    console.log(`[migrations] ${stat.name}: skipped`);
    return;
  }
  if (stat.updated === 0 && stat.errors === 0) {
    console.log(
      `[migrations] ${stat.name}: scanned=${stat.scanned} no-op (already migrated) [${stat.durationMs}ms]`
    );
    return;
  }
  console.log(
    `[migrations] ${stat.name}: scanned=${stat.scanned} updated=${stat.updated} skipped=${stat.skipped} errors=${stat.errors} [${stat.durationMs}ms]`
  );
}

/**
 * Migrate legacy top-level `category` / `difficulty` / `subcategory` fields
 * on TestCase documents into the unified `labels` array. The migration is
 * idempotent: it reads each test case, builds the merged labels with
 * migrateLegacyFieldsToLabels, and writes back ONLY if the labels actually
 * change.
 *
 * The legacy fields are NOT deleted by this migration — they remain for
 * back-compat with older clients. A follow-up migration can remove them
 * once the UI no longer reads them anywhere.
 */
export async function migrateCategoryDifficultyToLabels(
  storage: IStorageModule
): Promise<MigrationStat> {
  const startedAt = Date.now();
  const stat: MigrationStat = {
    name: 'category-difficulty-to-labels',
    ran: true,
    scanned: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
    notes: [],
  };

  // Page through test cases. The IStorageModule supports getAll with
  // pagination; we scan in batches to avoid loading everything in memory
  // for very large stores.
  const PAGE_SIZE = 500;
  let from = 0;
  while (true) {
    let page;
    try {
      page = await storage.testCases.getAll({ from, size: PAGE_SIZE });
    } catch (err: any) {
      stat.errors++;
      stat.notes!.push(`getAll failed at from=${from}: ${err?.message || err}`);
      break;
    }

    const items = page.items || [];
    if (items.length === 0) break;

    for (const tc of items) {
      stat.scanned++;
      const merged = computeMergedLabels(tc);
      if (!merged.changed) {
        stat.skipped++;
        continue;
      }
      try {
        await storage.testCases.update(tc.id, { labels: merged.labels });
        stat.updated++;
      } catch (err: any) {
        stat.errors++;
        stat.notes!.push(`update ${tc.id} failed: ${err?.message || err}`);
      }
    }

    if (items.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  stat.durationMs = Date.now() - startedAt;
  return stat;
}

/**
 * Decide whether a test case's labels need to be rewritten.
 *
 * Returns the merged labels and a `changed` flag. The merged labels are
 * the existing labels plus any missing `category:` / `difficulty:` /
 * `subcategory:` facets derived from the legacy top-level fields.
 *
 * Exported for unit testing.
 */
/**
 * Heal reports written by the old trace-timeout path after a judge verdict had
 * already landed. That path cleared passFailStatus, replaced real metrics with
 * zeroes, and set metricsStatus=error even though matcherResults retained the
 * authoritative verdict.
 *
 * Only a non-errored, gating llm-judge matcher can trigger this migration.
 * Reports with only errored/observe matchers remain genuine evaluator errors.
 */
export async function migratePoisonedReportVerdicts(
  storage: IStorageModule
): Promise<MigrationStat> {
  const startedAt = Date.now();
  const stat: MigrationStat = {
    name: 'poisoned-report-verdicts',
    ran: true,
    scanned: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
    notes: [],
  };

  const PAGE_SIZE = 500;
  let from = 0;
  while (true) {
    let page;
    try {
      page = await storage.runs.getAll({ from, size: PAGE_SIZE });
    } catch (err: any) {
      stat.errors++;
      stat.notes!.push(`getAll failed at from=${from}: ${err?.message || err}`);
      break;
    }

    const items = page.items || [];
    if (items.length === 0) break;

    for (const report of items) {
      stat.scanned++;
      const patch = deriveHistoricalVerdictPatch(report);
      if (!patch) {
        stat.skipped++;
        continue;
      }
      try {
        await storage.runs.update(report.id, patch);
        stat.updated++;
      } catch (err: any) {
        stat.errors++;
        stat.notes!.push(`update ${report.id} failed: ${err?.message || err}`);
      }
    }

    if (items.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  stat.durationMs = Date.now() - startedAt;
  return stat;
}

/**
 * Compute the smallest idempotent patch for one historical report.
 * Exported for focused unit tests and migration audits.
 */
export function deriveHistoricalVerdictPatch(
  report: EvaluationReport
): Partial<EvaluationReport> | null {
  const verdict = getJudgeVerdict(report);
  // The migration is intentionally matcher-only. A flat passFailStatus cannot
  // prove that an error-stamped document was judged successfully.
  if (!verdict || verdict.source !== 'matcherResults') return null;

  const patch: Partial<EvaluationReport> = {};
  if (report.passFailStatus !== verdict.status) {
    patch.passFailStatus = verdict.status;
  }

  if (verdict.score !== null) {
    const accuracy = report.metrics?.accuracy;
    // A timeout patch replaced every metric with zeros. On error-stamped
    // reports rebuild from matcher judgeMetrics (rather than preserving those
    // fabricated zeroes); otherwise make the smallest accuracy correction.
    if (report.metricsStatus === 'error' || accuracy !== verdict.score) {
      const matcherMetrics = (report.matcherResults ?? [])
        .filter(result => result.method === 'llm-judge' && !result.errored && result.role !== 'observe')
        .reduce<Record<string, number>>((all, result) => {
          for (const [key, value] of Object.entries(result.judgeMetrics ?? {})) {
            if (typeof value === 'number' && Number.isFinite(value)) all[key] = value;
          }
          return all;
        }, {});
      patch.metrics = report.metricsStatus === 'error'
        ? { ...matcherMetrics, accuracy: verdict.score }
        : { ...(report.metrics || {}), accuracy: verdict.score };
    }
  }

  if (report.metricsStatus === 'error') {
    patch.metricsStatus = 'ready';
    // Preserve the old timeout as secondary diagnostic metadata so row and
    // Overview surfaces explain why trace data is absent after healing.
    if (!report.traceStatus) patch.traceStatus = 'unavailable';
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function computeMergedLabels(tc: Partial<TestCase>): {
  labels: string[];
  changed: boolean;
} {
  const existingLabels = tc.labels ?? [];
  const merged = migrateLegacyFieldsToLabels({
    category: tc.category as string | undefined,
    difficulty: tc.difficulty as string | undefined,
    subcategory: (tc as any).subcategory as string | undefined,
    labels: existingLabels,
  });

  // Idempotency: if every legacy facet is already represented in the
  // existing labels, return unchanged.
  const haveAllFacets =
    (!tc.category || hasLabelPrefix(existingLabels, 'category')) &&
    (!tc.difficulty || hasLabelPrefix(existingLabels, 'difficulty')) &&
    (!(tc as any).subcategory || hasLabelPrefix(existingLabels, 'subcategory'));

  if (haveAllFacets && merged.length === existingLabels.length) {
    return { labels: existingLabels, changed: false };
  }
  // Defensive: if neither category nor difficulty is set on the doc and
  // labels were unchanged, mark as no-op too.
  if (merged.length === existingLabels.length && merged.every((l, i) => l === existingLabels[i])) {
    return { labels: existingLabels, changed: false };
  }
  return { labels: merged, changed: true };
}
