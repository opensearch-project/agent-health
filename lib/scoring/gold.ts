/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Gold-id resolution for deterministic evaluators.
 *
 * Three outcomes, which the scoring engine treats differently:
 *   - gold ids            → `{ ids: [...], rule }`  ranked metrics apply.
 *   - EXPLICITLY no gold  → `{ ids: [], rule }`     the right answer is
 *                           "nothing"; only the `abstain` metric applies.
 *   - gold NOT DECLARED   → `null`                  every metric is
 *                           unevaluable (never 0, never a fake abstain).
 *
 * Precedence, per report/test case:
 *   1. `testCase.expected.ids` (structured) — wins when NON-empty.
 *   2. When the evaluator declares `gold.source: 'expectedOutcomes-pattern'`:
 *      the FIRST `expectedOutcomes` line matching the pattern is
 *      authoritative. Its single capture group is the id list: any
 *      parenthesised text is dropped first (`290226, 116770 (Some Name;
 *      Other Name)` → `290226`, `116770` — gold lines routinely carry the
 *      human-readable names after the ids), then the remainder is split on
 *      `,` `;` and whitespace; a capture that is empty or one of
 *      {@link GOLD_EMPTY_TOKENS} (`none`, `n/a`, `-`) means "explicitly no
 *      gold".
 *   3. Under the same source, when NO line matches the pattern but a line
 *      IS an explicit no-gold marker — `NONE` / `No gold` / `No gold ids` as
 *      the whole line or followed only by punctuation / a dash
 *      ({@link GOLD_NONE_LINE_RE}: `NONE — the anchor has no edges…`,
 *      `No gold: abstain expected`) → explicitly no gold: the right answer
 *      is "nothing" — an ABSTAIN case, never "gold not declared". Prose that
 *      merely begins with the word (`None of the distractors should be
 *      returned`, `No gold standard exists for …`) is NOT a declaration.
 *      (Owner incident: `NONE — the anchor has no … edges` was reported as
 *      "no gold ids on the test case" and the case marked not evaluable.)
 *   4. When the evaluator declares `gold.source: 'testCase.expected.ids'`
 *      and the field is present but EMPTY (`[]`) → explicitly no gold. Under
 *      the pattern source an empty structured list is NOT read as "no gold":
 *      clients routinely serialize `[]` for "unset", and only an evaluator
 *      that opted into the structured field gets to interpret it.
 *   5. Nothing → `null` (gold not declared).
 *
 * The pattern is evaluator DATA: Agent Health does not know what any
 * particular benchmark's gold line looks like.
 */

import type { DeterministicEvaluatorInputs, TestCase } from '@/types';
import { dedupeIds } from '@/lib/metrics/index';

export type GoldRule = 'expected.ids' | 'expected-outcomes-pattern' | 'expected-outcomes-none';

export interface ResolvedGold {
  /** Gold ids; EMPTY means the test case explicitly declares "no gold" (an abstain case). */
  ids: string[];
  rule: GoldRule;
  /** Index of the `expectedOutcomes` line the ids (or the explicit "none") came from; absent for `expected.ids`. */
  lineIndex?: number;
}

/** Captured gold values (case-insensitive, trimmed) that mean "explicitly no gold". */
export const GOLD_EMPTY_TOKENS: ReadonlyArray<string> = ['none', 'n/a', '-', '—', '[]', 'null'];

/**
 * An `expectedOutcomes` line that, on its own, declares "the right answer is
 * nothing": the marker must be the whole line or be followed by punctuation
 * / a dash — never by another word (`None of the …` is prose).
 */
export const GOLD_NONE_LINE_RE = /^\s*(?:none|no gold(?:\s+ids?)?)\s*(?:$|[—–\-:;.,(])/i;

/** Drop every `(…)` group — gold lines carry the human names after the ids. */
export function stripParenthesised(text: string): string {
  let out = String(text ?? '');
  // Iterate so nested groups collapse from the inside out.
  for (let i = 0; i < 5 && /\([^()]*\)/.test(out); i++) out = out.replace(/\([^()]*\)/g, ' ');
  // An unbalanced opening paren: everything after it is annotation.
  const open = out.indexOf('(');
  if (open >= 0) out = out.slice(0, open);
  return out.trim();
}

/**
 * Ids from a captured gold string: parenthesised annotation removed, then
 * split on `,` `;` and whitespace; trimmed and deduped. Empty / no-gold
 * tokens yield `[]`.
 */
export function splitGoldIds(captured: string): string[] {
  const text = stripParenthesised(captured);
  if (!text || GOLD_EMPTY_TOKENS.includes(text.toLowerCase())) return [];
  const tokens = text.split(/[,;\s]+/).filter(Boolean);
  if (tokens.length > 0 && GOLD_EMPTY_TOKENS.includes(tokens[0].toLowerCase())) return [];
  return dedupeIds(tokens);
}

/** Compile the evaluator's gold pattern; throws a descriptive error on an invalid regex. */
export function compileGoldPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (e: any) {
    throw new Error(`inputs.gold.pattern is not a valid regular expression: ${e?.message ?? e}`);
  }
}

export function resolveGold(
  testCase: Pick<TestCase, 'expected' | 'expectedOutcomes'> | null | undefined,
  gold: DeterministicEvaluatorInputs['gold']
): ResolvedGold | null {
  const structured = testCase?.expected?.ids;
  const structuredIds = Array.isArray(structured) ? dedupeIds(structured) : null;
  if (structuredIds && structuredIds.length > 0) return { ids: structuredIds, rule: 'expected.ids' };

  if (gold.source === 'expectedOutcomes-pattern') {
    const re = compileGoldPattern(gold.pattern);
    const lines = testCase?.expectedOutcomes ?? [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (typeof line !== 'string') continue;
      const m = re.exec(line);
      if (!m) continue;
      // First matching line is authoritative: ids, or an explicit "none".
      return { ids: splitGoldIds(m[1] ?? ''), rule: 'expected-outcomes-pattern', lineIndex: i };
    }
    // No gold line — but an explicit "NONE …" line is a declaration too.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (typeof line === 'string' && GOLD_NONE_LINE_RE.test(line)) {
        return { ids: [], rule: 'expected-outcomes-none', lineIndex: i };
      }
    }
  }
  // `expected.ids: []` is "explicitly no gold" only for evaluators that read that field.
  if (structuredIds && gold.source === 'testCase.expected.ids') return { ids: [], rule: 'expected.ids' };
  return null;
}
