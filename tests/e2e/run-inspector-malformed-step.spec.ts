/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';
import {
  MALFORMED_CONTENT_SHAPES,
  MALFORMED_STEP_TOOL_NAME,
  REAL_SHAPED_STEP_COUNT,
  STEP_AFTER_MALFORMED_TEXT,
  STEP_BEFORE_MALFORMED_TEXT,
  FINAL_RESPONSE_TEXT,
  buildReportWithMalformedStep,
} from '../helpers/trajectoryFixtures';

/**
 * Regression — the Run inspector (`/runs/:id`, and the same RunDetailsContent
 * inside the benchmark-results inspector panel) rendered a BLANK page when a
 * persisted trajectory contained an `action` step whose `content` was not a
 * string: `TrajectoryView` read `step.content.length` (and handed the value
 * to react-markdown, which throws on non-string children) with no error
 * boundary anywhere above it, so React unmounted the whole route.
 *
 * Seeds one real-shaped 12-step report per malformed shape through the real
 * storage API, opens the inspector in a real browser (real react-markdown),
 * and asserts the page renders with every other step visible.
 */
test.describe('Run inspector — trajectory step without a string `content` must not blank the page', () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reportIds: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    for (const shape of MALFORMED_CONTENT_SHAPES) {
      const id = `e2e-trajcontent-${shape}-${runId}`;
      reportIds[shape] = id;
      const res = await request.post('/api/storage/runs', {
        data: buildReportWithMalformedStep(id, shape),
      });
      expect(res.ok(), `seed ${shape}: ${res.status()}`).toBeTruthy();
    }
    // One more: no content AND no toolArgs → the "(no text)" placeholder.
    reportIds['no-text'] = `e2e-trajcontent-notext-${runId}`;
    const res = await request.post('/api/storage/runs', {
      data: buildReportWithMalformedStep(reportIds['no-text'], 'null', { withToolArgs: false }),
    });
    expect(res.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of Object.values(reportIds)) {
      await request.delete(`/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
  });

  for (const shape of MALFORMED_CONTENT_SHAPES) {
    test(`content=${shape}: the inspector renders all ${REAL_SHAPED_STEP_COUNT} steps and the malformed step shows its arguments`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      await page.goto(`/runs/${reportIds[shape]}`);

      // The page is NOT blank: the tab strip and the trajectory heading render.
      await expect(page.getByRole('heading', { name: 'Test Case Output' })).toBeVisible({ timeout: 15000 });

      const steps = page.getByTestId('trajectory-step');
      await expect(steps).toHaveCount(REAL_SHAPED_STEP_COUNT);
      // No step fell back to the error card.
      await expect(page.getByTestId('render-error-boundary')).toHaveCount(0);

      // Neighbours of the malformed step (and the final answer) are visible.
      await expect(page.getByText(STEP_BEFORE_MALFORMED_TEXT)).toBeVisible();
      await expect(page.getByText(STEP_AFTER_MALFORMED_TEXT)).toBeVisible();
      await expect(page.getByText(FINAL_RESPONSE_TEXT)).toBeVisible();

      // The malformed action step is labelled with its tool and shows the
      // serialized arguments (nested object), not an empty card.
      const malformed = steps.filter({ hasText: `action · ${MALFORMED_STEP_TOOL_NAME}` });
      await expect(malformed).toHaveCount(1);
      await expect(malformed).toContainText('orders-2026.*');

      // Nothing escaped to window.onerror.
      expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    });
  }

  test('a step with no content and no toolArgs shows a neutral "(no text)" body', async ({ page }) => {
    await page.goto(`/runs/${reportIds['no-text']}`);
    await expect(page.getByRole('heading', { name: 'Test Case Output' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('trajectory-step')).toHaveCount(REAL_SHAPED_STEP_COUNT);
    const malformed = page.getByTestId('trajectory-step').filter({ hasText: `action · ${MALFORMED_STEP_TOOL_NAME}` });
    await expect(malformed.getByTestId('trajectory-step-no-text')).toHaveText('(no text)');
  });

  test('long object content is collapsible and expands to the serialized JSON', async ({ page }) => {
    await page.goto(`/runs/${reportIds['object']}`);
    await expect(page.getByRole('heading', { name: 'Test Case Output' })).toBeVisible({ timeout: 15000 });
    const malformed = page.getByTestId('trajectory-step').filter({ hasText: `action · ${MALFORMED_STEP_TOOL_NAME}` });
    // Pretty-printed JSON of the nested args is > 200 chars → collapsible preview with a char count.
    await expect(malformed.getByText(/\(\d+ chars\)/)).toBeVisible();
    await malformed.getByRole('button').click();
    await expect(malformed).toContainText('"status": "failed"');
    await expect(malformed).toContainText('"size": 50');
  });
});
