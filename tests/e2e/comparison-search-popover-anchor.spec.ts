/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

// Regression: the run-selector popover ("N of M runs" trigger, with
// Benchmark/Run/Test Case tabs) used to position its panel via hand-rolled
// `position: absolute; top-full` CSS relative to a wrapper div that lives
// inside the page's `position: sticky` toolbar. That combination rendered
// the panel detached from its trigger — a large vertical gap, floating over
// the scoreboard table below — instead of anchored directly beneath the
// trigger/tab row. The fix swaps the hand-rolled positioning for Radix's
// Popover primitive (portaled + Floating-UI-computed, like the rest of the
// app's Select/DropdownMenu), which keeps the panel's geometry glued to its
// trigger regardless of ancestor scroll/sticky context.
//
// This test seeds two standalone evaluation runs (no benchmark) via the
// storage API — same pattern as comparison-eval-runs.spec.ts — so the
// scoreboard + a real ≥2-run selector renders hermetically, independent of
// whatever benchmark/run data exists in the target environment.

const RUN_A = 'eval-run-e2e-popover-aaaaaa';
const RUN_B = 'eval-run-e2e-popover-bbbbbb';
const RUN_C = 'eval-run-e2e-popover-cccccc';
// Reuse the same test-case id as comparison-eval-runs.spec.ts. The shared
// dev/CI OpenSearch cluster's evaluation-runs index maps `results.<id>` as a
// dynamic per-testcase-id field; a brand-new id here would add yet another
// mapped field and can trip the cluster's total-fields cap on a
// long-lived shared index. Reusing an id that's already mapped avoids that.
const TC = 'tc-e2e-cmp-001';

function evalRunDoc(id: string, name: string, agentKey: string) {
  return {
    id,
    docType: 'evaluation-run',
    name,
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    results: { [TC]: { reportId: `report-${id}`, status: 'completed' } },
    stats: { passed: 1, failed: 0, total: 1 },
  };
}

test.describe('Comparison run-selector popover — anchoring', () => {
  test('panel anchors directly beneath the trigger and click-outside closes it', async ({ page }) => {
    const api = page.request;
    try {
      const a = await api.put(`/api/storage/evaluation-runs/${RUN_A}`, { data: evalRunDoc(RUN_A, 'E2E Popover Run A', 'agent-alpha') });
      const b = await api.put(`/api/storage/evaluation-runs/${RUN_B}`, { data: evalRunDoc(RUN_B, 'E2E Popover Run B', 'agent-beta') });
      const c = await api.put(`/api/storage/evaluation-runs/${RUN_C}`, { data: evalRunDoc(RUN_C, 'E2E Popover Run C', 'agent-gamma') });
      expect(a.ok()).toBeTruthy();
      expect(b.ok()).toBeTruthy();
      expect(c.ok()).toBeTruthy();

      await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
      await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
      await page.waitForTimeout(1500);

      const trigger = page.locator('[data-testid="comparison-search"]');
      await expect(trigger).toBeVisible();
      await trigger.click();

      const panel = page.locator('[data-testid="comparison-search-panel"]');
      await expect(panel).toBeVisible();

      const triggerBox = await trigger.boundingBox();
      expect(triggerBox).not.toBeNull();
      const triggerBottom = triggerBox!.y + triggerBox!.height;

      // PopoverContent animates in (zoom-in-95 from the panel center, see
      // components/ui/popover.tsx), so a single boundingBox() sample taken
      // right after toBeVisible() can land mid-transition — the top edge is
      // still translated ~8px down and the "gap" reads ~12.35px instead of
      // the settled sideOffset. Poll until the geometry settles instead of
      // asserting a single frame.
      const measureGap = async () => {
        const panelBox = await panel.boundingBox();
        return panelBox ? panelBox.y - triggerBottom : Number.NaN;
      };
      // Panel's top must sit close beneath the trigger's bottom — not above
      // it (would mean it's floating somewhere else on the page, e.g.
      // detached over the scoreboard) and not a large, page-spanning gap.
      await expect.poll(measureGap, { timeout: 5000 }).toBeLessThanOrEqual(12);
      const gap = await measureGap();
      expect(gap).toBeGreaterThanOrEqual(0);

      // Interacting inside the panel (switching tabs) must not close it.
      const runTab = page.locator('[data-testid="comparison-search-scope-run"]');
      await runTab.click();
      await expect(panel).toBeVisible();

      // Click-outside closes it.
      await page.mouse.click(20, 20);
      await expect(panel).toBeHidden();
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_A}`).catch(() => {});
      await api.delete(`/api/storage/evaluation-runs/${RUN_B}`).catch(() => {});
      await api.delete(`/api/storage/evaluation-runs/${RUN_C}`).catch(() => {});
    }
  });
});
