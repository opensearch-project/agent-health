/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LEGACY — covers the old `/benchmarks` route (BenchmarksPage / BenchmarkRunsPage)
 * which is no longer reachable from the sidebar (PR #147 removed the link).
 * The user-facing benchmarks experience now lives at `/evaluations/benchmarks`
 * and is covered by `evals3-benchmarks.spec.ts` and `evals3-benchmark-runs.spec.ts`.
 *
 * Skipped wholesale to make it explicit that this file is *not* protecting the
 * primary user flow. Re-enable only if you need to keep the legacy route alive
 * for backwards compatibility (currently still mounted in App.tsx).
 */

import { test } from './fixtures/test-fixtures';

test.describe.skip('Legacy /benchmarks route (orphaned — not in sidebar)', () => {
  test('see evals3-benchmarks.spec.ts and evals3-benchmark-runs.spec.ts for active coverage', () => {});
});
