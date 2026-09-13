/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression for a reported bug: on the run inspector
 * (`/evaluations/benchmarks/:benchmarkId/runs/:runId` → redirects to
 * `.../inspect`, and the equivalent `/evaluations/runs/:runId/inspect` for
 * SDK eval runs), a long run name overflowed its header cell and ran INTO
 * the right-hand metadata block (date · agent · model · pass/fail) instead
 * of truncating with an ellipsis.
 *
 * Root cause (components/evals3/InlineRenameField.tsx display mode): the
 * wrapper was `inline-flex` — a shrink-to-fit box whose min-content for
 * nowrap text IS the full text width, so the `min-w-0` already on the
 * wrapper was a no-op and the child `truncate` span never got a bounded
 * width to clip against. Fixed by making the wrapper block-level `flex`
 * (fills its already width-bounded parent, like any normal block box) and
 * adding the missing `min-w-0` on the truncate span itself (a flex item's
 * default minimum size is its own content size, which alone still blocks
 * shrinking even once the parent is bounded).
 *
 * This spec seeds a run with a long, generic (non-internal) name and
 * screenshots the header before asserting: (a) the rename text element is
 * actually clipped (`scrollWidth > clientWidth`) and (b) it never overlaps
 * the metadata block to its right. It also proves rename still works with a
 * long name (type, Enter, PATCH persists).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTIFACT_DIR = path.join(
  __dirname,
  '..',
  '..',
  '.pi',
  'web',
  'artifacts',
  'pr465'
);

function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

// Generic, non-internal long name: padded well past any reasonable column
// width so the pre-fix bug reproduces reliably regardless of viewport.
function longRunName(): string {
  const base = uniqueTestName('long-run-name-truncation-regression');
  const pad = 'lorem-ipsum-filler-segment-';
  let name = base;
  while (name.length < 180) name += `-${pad}`;
  return name.slice(0, 190);
}

test.describe('Run inspector header — long run name truncates instead of overlapping metadata', () => {
  const tracker = createTestDataTracker();

  async function seedEvalRun(request: any, name: string): Promise<string> {
    const id = `e2e-trunc-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const run = {
      id,
      name,
      status: 'completed',
      agentKey: 'demo',
      modelId: 'demo-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
      createdAt: new Date().toISOString(),
    };
    const res = await request.put(`/api/storage/evaluation-runs/${id}`, { data: run });
    expect(res.ok()).toBeTruthy();
    tracker.evaluationRun(id);
    return id;
  }

  test.afterAll(async () => {
    ensureArtifactDir();
    await tracker.cleanup();
  });

  test('long run name is truncated with an ellipsis and never overlaps the header metadata', async ({ page, request }) => {
    ensureArtifactDir();
    const longName = longRunName();
    const runId = await seedEvalRun(request, longName);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/evaluations/runs/${runId}/inspect`);

    const text = page.getByTestId('run-inspector-rename-text');
    await expect(text).toBeVisible({ timeout: 30_000 });
    const meta = page.getByTestId('run-inspector-header-meta');
    await expect(meta).toBeVisible();

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-long-name-header.png') });

    // (a) actually clipped, not just visually narrow -- scrollWidth (full
    // content) must exceed clientWidth (the box it's laid out into).
    const overflow = await text.evaluate((el: HTMLElement) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);

    // The full name is still reachable via the tooltip.
    await expect(text).toHaveAttribute('title', longName);

    // (b) no overlap with the metadata block: the text's right edge must
    // sit at or before the metadata block's left edge.
    const textBox = await text.boundingBox();
    const metaBox = await meta.boundingBox();
    expect(textBox).not.toBeNull();
    expect(metaBox).not.toBeNull();
    expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(metaBox!.x + 1); // 1px layout-rounding slack

    // Rename still works with a long name: type a new (also long) name,
    // Enter, and the PATCH actually persists.
    const editBtn = page.getByTestId('run-inspector-rename-edit-btn');
    await editBtn.click();
    const input = page.getByTestId('run-inspector-rename-input');
    const newLongName = longRunName();
    await input.fill(newLongName);
    await input.press('Enter');

    await expect(page.getByTestId('run-inspector-rename-text')).toHaveText(newLongName);
    await expect(page.getByTestId('run-inspector-rename-text')).toHaveAttribute('title', newLongName);

    const verify = await request.get(`/api/storage/evaluation-runs/${runId}`);
    expect((await verify.json()).name).toBe(newLongName);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-long-name-renamed.png') });
  });
});
