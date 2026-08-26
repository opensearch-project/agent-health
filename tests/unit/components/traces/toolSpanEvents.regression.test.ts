/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for issue #319 — tool span input/output never displayed.
 *
 * The OTel GenAI conventions convey tool-call arguments/results via span
 * EVENTS (`gen_ai.tool.message` for arguments, `gen_ai.choice` for the
 * result) — not attributes. Three trace-UI components each failed to
 * surface them:
 *
 *   1. SimpleSpanAttributesTable rendered only `span.attributes`, never
 *      `span.events`, so the run-detail drawer showed no tool I/O at all.
 *   2. SpanInputOutput's extractSpanIO checked the non-spec attribute
 *      names `gen_ai.tool.input` / `gen_ai.tool.output` and never read
 *      the event convention.
 *   3. SpanDetailsPanel had the same non-spec-attribute blind spot.
 *
 * These are source-level guards (matching the pattern of
 * spanDetailsDrawer.regression.test.ts) so a refactor that drops event
 * handling fails CI. Behavioral coverage of the extraction logic itself
 * lives in SpanInputOutput.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('Tool span I/O from OTel GenAI events — regression #319', () => {
  describe('SimpleSpanAttributesTable folds span.events into the table', () => {
    let source: string;
    beforeAll(() => {
      source = read('components/traces/SimpleSpanAttributesTable.tsx');
    });

    it('iterates span.events when building table entries', () => {
      expect(source).toMatch(/span\.events/);
    });

    it('keys event rows as <event-name>.<field>', () => {
      expect(source).toMatch(/\$\{event\.name\}\.\$\{k\}/);
    });

    it('recomputes entries when span.events changes', () => {
      expect(source).toMatch(/\[span\.attributes,\s*span\.events,\s*valueMode\]/);
    });
  });

  describe('SpanInputOutput reads the event-based tool convention', () => {
    let source: string;
    beforeAll(() => {
      source = read('components/traces/SpanInputOutput.tsx');
    });

    it('reads gen_ai.tool.message events for tool arguments', () => {
      expect(source).toMatch(/getEventContent\(span,\s*'gen_ai\.tool\.message'\)/);
    });

    it('reads gen_ai.choice events for tool results', () => {
      expect(source).toMatch(/getEventContent\(span,\s*'gen_ai\.choice'\)/);
    });

    it('parses tool_call / tool_call_response parts from message attributes', () => {
      expect(source).toMatch(/tool_call_response/);
      expect(source).toMatch(/gen_ai\.input\.messages/);
      expect(source).toMatch(/gen_ai\.output\.messages/);
    });
  });

  describe('SpanDetailsPanel reads the event-based tool convention', () => {
    let source: string;
    beforeAll(() => {
      source = read('components/traces/SpanDetailsPanel.tsx');
    });

    it('reads gen_ai.tool.message / gen_ai.choice events', () => {
      expect(source).toMatch(/gen_ai\.tool\.message/);
      expect(source).toMatch(/gen_ai\.choice/);
    });

    it('checks the spec attributes gen_ai.tool.call.arguments/.result', () => {
      expect(source).toMatch(/gen_ai\.tool\.call\.arguments/);
      expect(source).toMatch(/gen_ai\.tool\.call\.result/);
    });
  });
});
