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
 *      authoritative. Its single capture group is split on `,` `;` and
 *      whitespace into ids; a capture that is empty or one of
 *      {@link GOLD_EMPTY_TOKENS} (`none`, `n/a`, `-`) means "explicitly no
 *      gold".
 *   3. When the evaluator declares `gold.source: 'testCase.expected.ids'`
 *      and the field is present but EMPTY (`[]`) → explicitly no gold. Under
 *      the pattern source an empty structured list is NOT read as "no gold":
 *      clients routinely serialize `[]` for "unset", and only an evaluator
 *      that opted into the structured field gets to interpret it.
 *   4. Nothing → `null` (gold not declared).
 *
 * The pattern is evaluator DATA: Agent Health does not know what any
 * particular benchmark's gold line looks like.
 */

import type { DeterministicEvaluatorInputs, TestCase } from '@/types';
import { dedupeIds } from '@/lib/metrics/index';

export type GoldRule = 'expected.ids' | 'expected-outcomes-pattern';

export interface ResolvedGold {
  /** Gold ids; EMPTY means the test case explicitly declares "no gold" (an abstain case). */
  ids: string[];
  rule: GoldRule;
}

/** Captured gold values (case-insensitive, trimmed) that mean "explicitly no gold". */
export const GOLD_EMPTY_TOKENS: ReadonlyArray<string> = ['none', 'n/a', '-', '—', '[]', 'null'];

/** Split a captured gold-id string on `,` `;` and whitespace; trims and dedupes. Empty tokens yield `[]`. */
export function splitGoldIds(captured: string): string[] {
  const text = String(captured ?? '').trim();
  if (GOLD_EMPTY_TOKENS.includes(text.toLowerCase())) return [];
  return dedupeIds(text.split(/[,;\s]+/));
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
    for (const line of testCase?.expectedOutcomes ?? []) {
      if (typeof line !== 'string') continue;
      const m = re.exec(line);
      if (!m) continue;
      // First matching line is authoritative: ids, or an explicit "none".
      return { ids: splitGoldIds(m[1] ?? ''), rule: 'expected-outcomes-pattern' };
    }
  }
  // `expected.ids: []` is "explicitly no gold" only for evaluators that read that field.
  if (structuredIds && gold.source === 'testCase.expected.ids') return { ids: [], rule: 'expected.ids' };
  return null;
}
