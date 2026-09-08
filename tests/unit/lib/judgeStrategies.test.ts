/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  extractJsonFromResponse,
  normalizeImprovementStrategies,
  recoverImprovementStrategies,
  resolveImprovementStrategies,
  soleJudgeMatcherIndex,
  buildImprovementStrategiesBackfillPatch,
} from '@/lib/judgeStrategies';

const STRATEGIES = [
  { category: 'Payload Economy', issue: 'Too chatty', recommendation: 'Return compact records', priority: 'medium' },
  { category: 'Provenance', issue: 'Bare ids', recommendation: 'Inline the doc id per fact', priority: 'low' },
];

/** Shape the agentic trace judge persisted while it forced `[]` on the way out. */
function uncapturedReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report-1',
    judgeModelId: 'agent-trace-judge',
    improvementStrategies: [],
    llmJudgeResponse: {
      modelId: 'agent-trace-judge',
      rawResponse: '```json\n' + JSON.stringify({
        pass_fail_status: 'passed',
        reasoning: 'fine',
        improvement_strategies: STRATEGIES,
      }) + '\n```',
      improvementStrategies: [],
    },
    matcherResults: [
      { description: 'true to equal true', pass: true, method: 'code-assertion' },
      { description: 'judge: 2 expected outcomes', pass: true, method: 'llm-judge', improvementStrategies: [] },
    ],
    ...overrides,
  };
}

describe('lib/judgeStrategies', () => {
  describe('extractJsonFromResponse', () => {
    it('unwraps a ```json fence', () => {
      expect(extractJsonFromResponse('here:\n```json\n{"a":1}\n```\nbye')).toBe('{"a":1}');
    });
    it('slices bare JSON with surrounding prose', () => {
      expect(extractJsonFromResponse('Result: {"a":1, "b":2} done')).toBe('{"a":1, "b":2}');
    });
    it('returns undefined without an object', () => {
      expect(extractJsonFromResponse('no json here')).toBeUndefined();
    });
  });

  describe('normalizeImprovementStrategies', () => {
    it('returns [] for non-arrays', () => {
      expect(normalizeImprovementStrategies(undefined)).toEqual([]);
      expect(normalizeImprovementStrategies('x')).toEqual([]);
      expect(normalizeImprovementStrategies({})).toEqual([]);
    });
    it('passes well-formed entries through and fills gaps', () => {
      const out = normalizeImprovementStrategies([
        STRATEGIES[0],
        { issue: 'no category or priority' },
        { category: 'x', issue: 'bad priority', recommendation: 'r', priority: 'urgent' },
      ]);
      expect(out).toEqual([
        STRATEGIES[0],
        { category: 'general', issue: 'no category or priority', recommendation: '', priority: 'medium' },
        { category: 'x', issue: 'bad priority', recommendation: 'r', priority: 'medium' },
      ]);
    });
    it('coerces bare strings and drops junk', () => {
      expect(normalizeImprovementStrategies(['be terser', 42, null, '   '])).toEqual([
        { category: 'general', issue: 'be terser', recommendation: '', priority: 'medium' },
      ]);
    });
  });

  describe('recoverImprovementStrategies', () => {
    it('recovers the array from fenced raw judge text', () => {
      expect(recoverImprovementStrategies(uncapturedReport().llmJudgeResponse.rawResponse)).toEqual(STRATEGIES);
    });
    it('returns [] for missing / non-JSON / empty-array raw text', () => {
      expect(recoverImprovementStrategies(undefined)).toEqual([]);
      expect(recoverImprovementStrategies('')).toEqual([]);
      expect(recoverImprovementStrategies('improvement_strategies but not json {')).toEqual([]);
      expect(recoverImprovementStrategies('{"improvement_strategies": []}')).toEqual([]);
      expect(recoverImprovementStrategies('{"reasoning": "no strategies key"}')).toEqual([]);
    });
    it('never throws on malformed JSON that mentions the key', () => {
      expect(() => recoverImprovementStrategies('{"improvement_strategies": [ {broken')).not.toThrow();
      expect(recoverImprovementStrategies('{"improvement_strategies": [ {broken')).toEqual([]);
    });
  });

  describe('resolveImprovementStrategies', () => {
    it('prefers the persisted array and reports recovered=false', () => {
      const stored = [STRATEGIES[1]];
      expect(resolveImprovementStrategies(uncapturedReport({ improvementStrategies: stored })))
        .toEqual({ strategies: stored, recovered: false });
    });
    it('falls back to the raw text and reports recovered=true', () => {
      expect(resolveImprovementStrategies(uncapturedReport()))
        .toEqual({ strategies: STRATEGIES, recovered: true });
    });
    it('normalizes a malformed persisted array instead of passing it through', () => {
      const r = uncapturedReport({ improvementStrategies: [{ issue: 'no category' }, 'bare string', 42] as any });
      expect(resolveImprovementStrategies(r)).toEqual({
        strategies: [
          { category: 'general', issue: 'no category', recommendation: '', priority: 'medium' },
          { category: 'general', issue: 'bare string', recommendation: '', priority: 'medium' },
        ],
        recovered: false,
      });
    });
    it('is empty/not-recovered when neither surface has strategies', () => {
      const r = uncapturedReport({ llmJudgeResponse: { rawResponse: '{"improvement_strategies": []}' } });
      expect(resolveImprovementStrategies(r)).toEqual({ strategies: [], recovered: false });
      expect(resolveImprovementStrategies({})).toEqual({ strategies: [], recovered: false });
    });
  });

  describe('soleJudgeMatcherIndex', () => {
    it('returns the index of the single llm-judge row', () => {
      expect(soleJudgeMatcherIndex(uncapturedReport())).toBe(1);
    });
    it('is undefined with zero or several judge rows', () => {
      expect(soleJudgeMatcherIndex({ matcherResults: [] })).toBeUndefined();
      expect(soleJudgeMatcherIndex({})).toBeUndefined();
      expect(soleJudgeMatcherIndex({ matcherResults: [{ method: 'llm-judge' }, { method: 'llm-judge' }] })).toBeUndefined();
    });
  });

  describe('buildImprovementStrategiesBackfillPatch', () => {
    it('fills the top-level array, the llmJudgeResponse mirror and the single empty llm-judge matcher row', () => {
      const report = uncapturedReport();
      const patch = buildImprovementStrategiesBackfillPatch(report)!;
      expect(patch).not.toBeNull();
      expect(patch.improvementStrategies).toEqual(STRATEGIES);
      // Nested object is sent whole (PATCH shallow-merges top-level keys).
      expect(patch.llmJudgeResponse).toEqual({ ...report.llmJudgeResponse, improvementStrategies: STRATEGIES });
      expect(patch.matcherResults).toEqual([
        report.matcherResults[0], // code matcher untouched
        { ...report.matcherResults[1], improvementStrategies: STRATEGIES },
      ]);
      // Exactly these three keys — nothing else on the report is rewritten.
      expect(Object.keys(patch).sort()).toEqual(['improvementStrategies', 'llmJudgeResponse', 'matcherResults']);
    });

    it('leaves an already-populated llm-judge matcher row alone (matcherResults omitted from the patch)', () => {
      const own = [STRATEGIES[1]];
      const report = uncapturedReport({
        matcherResults: [{ description: 'judge', pass: false, method: 'llm-judge', improvementStrategies: own }],
      });
      const patch = buildImprovementStrategiesBackfillPatch(report)!;
      expect(patch.improvementStrategies).toEqual(STRATEGIES);
      expect('matcherResults' in patch).toBe(false);
    });

    it('omits matcherResults when the report has none', () => {
      const report = uncapturedReport({ matcherResults: undefined });
      const patch = buildImprovementStrategiesBackfillPatch(report)!;
      expect(patch.matcherResults).toBeUndefined();
      expect('matcherResults' in patch).toBe(false);
    });

    it('never stamps the report-level array onto several judge rows (per-claim rows are not a mirror of the last judge call)', () => {
      const report = uncapturedReport({
        matcherResults: [
          { description: 'judge: claim A', pass: true, method: 'llm-judge', improvementStrategies: [] },
          { description: 'judge: claim B', pass: false, method: 'llm-judge', improvementStrategies: [] },
        ],
      });
      const patch = buildImprovementStrategiesBackfillPatch(report)!;
      expect(patch.improvementStrategies).toEqual(STRATEGIES); // report level still recovered
      expect('matcherResults' in patch).toBe(false);          // rows left alone
    });

    it('is idempotent: applying the patch makes the next call return null', () => {
      const report = uncapturedReport();
      const patch = buildImprovementStrategiesBackfillPatch(report)!;
      expect(buildImprovementStrategiesBackfillPatch({ ...report, ...patch })).toBeNull();
    });

    it('returns null when nothing is recoverable', () => {
      expect(buildImprovementStrategiesBackfillPatch(uncapturedReport({ llmJudgeResponse: undefined }))).toBeNull();
      expect(buildImprovementStrategiesBackfillPatch(
        uncapturedReport({ llmJudgeResponse: { rawResponse: '{"improvement_strategies": []}' } })
      )).toBeNull();
    });
  });
});
