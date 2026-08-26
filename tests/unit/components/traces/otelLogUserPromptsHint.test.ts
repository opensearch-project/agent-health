/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source-level guard for the OTEL_LOG_USER_PROMPTS visibility hint.
 *
 * Context (PR #339, Code-Diff-Analyzer medium finding): Claude Code defaults
 * `OTEL_LOG_USER_PROMPTS=1` (opt-out with `=0`), so agent prompts/responses are
 * captured to OTel by default. Rather than flip the default off, the two Traces
 * empty states must *explain* that this env var governs input/output visibility,
 * so a user who sees no content knows why (it can be disabled) and how to
 * re-enable it. A refactor that drops the explanation would silently reintroduce
 * the "why are my inputs/outputs missing?" confusion — this test fails first.
 *
 * Matches the existing source-guard pattern in
 * tests/unit/components/traces/spanDetailsDrawer.regression.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('Traces empty states explain OTEL_LOG_USER_PROMPTS (#339)', () => {
  const cases = [
    'components/traces/SpanInputOutput.tsx',
    'components/traces/MessageHistoryView.tsx',
  ];

  for (const rel of cases) {
    describe(rel, () => {
      let source: string;
      beforeAll(() => {
        source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      });

      it('names OTEL_LOG_USER_PROMPTS in the no-content empty state', () => {
        expect(source).toContain('OTEL_LOG_USER_PROMPTS');
      });

      it('states it is on by default (so missing content reads as opt-out, not a bug)', () => {
        expect(source.toLowerCase()).toMatch(/on by default/);
      });
    });
  }
});
