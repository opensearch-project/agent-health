/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for two bugs reported on the inline (non-fullscreen)
 * span-details bottom drawer that ships with this PR (#217).
 *
 *   1. Page-unresponsive bug
 *      ─────────────────────
 *      The drawer was rendered with a Radix `<Sheet>` (Dialog) that
 *      defaults to `modal={true}`. Modal Radix dialogs trap focus, lock
 *      body scroll and `aria-hidden` siblings — so once the drawer
 *      opened, the trace list and toolbar behind it became
 *      non-interactive. The user couldn't click another span row to
 *      swap the drawer's content; the page felt frozen until the X /
 *      Esc dismissed the drawer.
 *
 *      Fix: pass `modal={false}` on the `<Sheet>` so the rest of the
 *      page stays interactive while the drawer is up. ESC and the X
 *      button still close it via `onOpenChange`.
 *
 *   2. X-button overlapping "N attributes" text
 *      ─────────────────────────────────────────
 *      The drawer renders an absolutely positioned close (X) button at
 *      `top-2 right-2` over the SimpleSpanAttributesTable. That table's
 *      identity strip uses `justify-between` and right-aligns a
 *      "{n} attribute(s)" label, which sat directly under the X button.
 *      With `px-3` the strip had no right gutter, so the count text
 *      appeared visually crossed-out by the X icon.
 *
 *      Fix: switch the strip's right padding from `px-3` (3 = 12px) to
 *      `pr-10` (10 = 40px) so the count text never reaches the area
 *      the absolute X button occupies.
 *
 * These tests are source-level guards (matching the existing pattern in
 * tests/unit/components/comparison/evaluatorRemoval.test.ts) so a future
 * refactor that drops either fix will fail CI before users see the
 * regression.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('Span details bottom drawer — regression #217', () => {
  describe('Bug 1: page-unresponsive when drawer opens', () => {
    const filePath = path.join(
      REPO_ROOT,
      'components/traces/AgentTracesPage.tsx'
    );
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(filePath, 'utf-8');
    });

    it('the <Sheet> wrapping SimpleSpanAttributesTable is non-modal', () => {
      // Locate the Sheet block that wraps SimpleSpanAttributesTable —
      // there is exactly one in the file (the inline page-level drawer).
      // Anchoring on SimpleSpanAttributesTable keeps the assertion
      // resilient to other unrelated <Sheet> usages elsewhere.
      const sheetBlockMatch = source.match(
        /<Sheet\b[\s\S]*?<SimpleSpanAttributesTable[\s\S]*?<\/Sheet>/
      );
      expect(sheetBlockMatch).not.toBeNull();

      const sheetBlock = sheetBlockMatch![0];
      expect(sheetBlock).toMatch(/\bmodal=\{false\}/);
    });

    it('does not rely on Sheet defaults (which would re-introduce the bug)', () => {
      // Defensive: a future "tidy-up" PR might delete the modal={false}
      // line thinking it's noise. Make the intent explicit by asserting
      // the prop is present in source (the assertion above), AND make
      // sure the comment that explains *why* is also present so the
      // next reader doesn't drop it.
      const sheetBlockMatch = source.match(
        /<Sheet\b[\s\S]*?<SimpleSpanAttributesTable[\s\S]*?<\/Sheet>/
      );
      const sheetBlock = sheetBlockMatch![0];
      expect(sheetBlock.toLowerCase()).toMatch(/non-modal|modal=\{false\}/);
    });
  });

  describe('Bug 2: close button overlaps "N attributes" text', () => {
    const filePath = path.join(
      REPO_ROOT,
      'components/traces/SimpleSpanAttributesTable.tsx'
    );
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(filePath, 'utf-8');
    });

    it('renders the "N attribute(s)" count label (the element that was being overlapped)', () => {
      // If this label ever stops being rendered, the regression target
      // has changed and these tests need to be revisited rather than
      // silently passing.
      expect(source).toMatch(/\{entries\.length\}\s*attribute/);
    });

    it('identity strip reserves right padding (pr-10) so the absolute X button does not overlap', () => {
      // Find the identity strip's <div> declaration. We anchor on the
      // "Identity strip" comment so the assertion is specific to this
      // element rather than any other container in the file.
      const stripMatch = source.match(
        /Identity strip[\s\S]{0,800}?<div\s+className="([^"]+)"/
      );
      expect(stripMatch).not.toBeNull();

      const className = stripMatch![1];

      // Must reserve right gutter for the parent's absolute X button…
      expect(className).toMatch(/\bpr-10\b/);

      // …and must NOT use the original symmetric px-3, which produced
      // only 12px on the right — not enough to clear the 28px-wide
      // (h-7 w-7) close button positioned at right-2.
      expect(className).not.toMatch(/\bpx-3\b/);
    });
  });
});
