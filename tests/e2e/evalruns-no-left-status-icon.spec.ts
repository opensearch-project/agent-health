/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the Evaluation Runs list row used to render a redundant
 * pass/fail/pending status icon on the LEFT of each row (CheckCircle2 /
 * XCircle / Clock) in addition to the pass/fail counts already shown on the
 * RIGHT of the row. The left icon added no information and cluttered the
 * row — removed, keeping only the right-side counts.
 */

import { test, expect } from './fixtures/test-fixtures';

const RUN_ID = `eval-run-e2e-lefticon-${Date.now()}`;
const RUN_NAME = `E2E Left-Icon Run ${Date.now()}`;
const TC = `tc-e2e-lefticon-${Date.now()}`;

function evalRunDoc() {
  return {
    id: RUN_ID,
    docType: 'evaluation-run',
    name: RUN_NAME,
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    results: { [TC]: { reportId: `report-${RUN_ID}`, status: 'completed', passFailStatus: 'passed' } },
    stats: { passed: 1, failed: 0, total: 1 },
  };
}

test.describe('Evaluation Runs list — no left-side status icon', () => {
  test.beforeAll(async ({ request }) => {
    const r = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, { data: evalRunDoc() });
    expect(r.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
  });

  test('run row has no left status icon — first data cell is the run name, and pass/fail counts remain on the right', async ({ page }) => {
    await page.goto('/evaluations/runs');
    // Flat view puts every run (grouped or not) in one table, avoiding
    // benchmark-group collapsing complications.
    await page.click('[data-testid="viewmode-flat"]');
    await page.waitForTimeout(1000);

    const row = page.locator('[data-testid="run-row"]', { hasText: RUN_NAME });
    await expect(row).toBeVisible({ timeout: 15000 });

    // First <td> is the selection checkbox; the SECOND <td> must be the run
    // name/id cell directly — not a separate icon-only status cell.
    const secondCell = row.locator('td').nth(1);
    await expect(secondCell).toContainText(RUN_NAME);
    // No lucide status icon (CheckCircle2/XCircle/Clock) rendered inside
    // that second cell. The seeded run is `completed`, so the only icon the
    // name cell may legitimately host is the inline-rename pencil
    // (`lucide-pencil`, PR #460) — anything else is the redundant status
    // icon this spec guards against.
    await expect(secondCell.locator('svg:not(.lucide-pencil)')).toHaveCount(0);

    // Right-side pass/fail counts are still present somewhere in the row.
    await expect(row).toContainText('1'); // passed count
    await expect(row).toContainText('0'); // failed count
  });
});
