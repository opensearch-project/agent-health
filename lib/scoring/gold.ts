/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Gold-id resolution for deterministic evaluators.
 *
 * Precedence, per report/test case:
 *   1. `testCase.expected.ids` (structured) — always wins when non-empty.
 *   2. When the evaluator declares `gold.source: 'expectedOutcomes-pattern'`:
 *      the FIRST `expectedOutcomes` line matching the pattern; the single
 *      capture group is split on `,` `;` and whitespace into ids.
 *   3. Nothing → `null` (every metric becomes unevaluable; never 0).
 *
 * The pattern is evaluator DATA: Agent Health does not know what any
 * particular benchmark's gold line looks like.
 */

import type { DeterministicEvaluatorInputs, TestCase } from '@/types';
import { dedupeIds } from '@/lib/metrics/index';

export type GoldRule = 'expected.ids' | 'expected-outcomes-pattern';

export interface ResolvedGold {
  ids: string[];
  rule: GoldRule;
}

/** Split a captured gold-id string on `,` `;` and whitespace; trims and dedupes. */
export function splitGoldIds(captured: string): string[] {
  return dedupeIds(String(captured ?? '').split(/[,;\s]+/));
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
  if (Array.isArray(structured)) {
    const ids = dedupeIds(structured);
    if (ids.length > 0) return { ids, rule: 'expected.ids' };
  }
  if (gold.source === 'expectedOutcomes-pattern') {
    const re = compileGoldPattern(gold.pattern);
    for (const line of testCase?.expectedOutcomes ?? []) {
      if (typeof line !== 'string') continue;
      const m = re.exec(line);
      if (!m) continue;
      const ids = splitGoldIds(m[1] ?? '');
      if (ids.length > 0) return { ids, rule: 'expected-outcomes-pattern' };
      // First matching line is authoritative even if it yielded nothing.
      return null;
    }
  }
  return null;
}
