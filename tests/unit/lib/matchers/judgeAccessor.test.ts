/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getJudgeMatcherResults,
  getJudgeReasoningText,
  buildJudgeMatcherEntries,
  recordJudgeMatcherResult,
} from '@/lib/matchers/judgeAccessor';
import type { MatcherResult } from '@/lib/matchers/types';

const judgeEntry = (overrides: Partial<MatcherResult> = {}): MatcherResult => ({
  description: 'judge: identifies the root cause',
  pass: true,
  method: 'llm-judge',
  durationMs: 1234,
  score: 1,
  reasoning: 'The agent correctly identified the failing dependency.',
  ...overrides,
});

const codeEntry = (): MatcherResult => ({
  description: 'trajectory to have at least one step of type \'action\'',
  pass: true,
  method: 'code-assertion',
});

describe('getJudgeMatcherResults — the read accessor', () => {
  it('returns existing [llm-judge] entries when present', () => {
    const j1 = judgeEntry({ description: 'judge: claim 1' });
    const j2 = judgeEntry({ description: 'judge: claim 2', pass: false, reasoning: 'no' });
    const report = { matcherResults: [codeEntry(), j1, codeEntry(), j2] };
    const out = getJudgeMatcherResults(report);
    expect(out).toEqual([j1, j2]);
  });

  it('synthesizes a virtual entry from llmJudgeReasoning on a legacy report', () => {
    const report = {
      llmJudgeReasoning: 'The agent correctly traced the issue back to a config drift.',
      passFailStatus: 'passed' as const,
    };
    const out = getJudgeMatcherResults(report as any);
    expect(out).toHaveLength(1);
    expect(out[0].method).toBe('llm-judge');
    expect(out[0].pass).toBe(true);
    expect(out[0].reasoning).toBe(report.llmJudgeReasoning);
    expect(out[0].description).toMatch(/judge:/);
  });

  it('infers pass from passFailStatus when present', () => {
    const failing = {
      llmJudgeReasoning: 'Did not satisfy.',
      passFailStatus: 'failed' as const,
    };
    expect(getJudgeMatcherResults(failing as any)[0].pass).toBe(false);

    const passing = {
      llmJudgeReasoning: 'Satisfied.',
      passFailStatus: 'passed' as const,
    };
    expect(getJudgeMatcherResults(passing as any)[0].pass).toBe(true);
  });

  it('infers pass from metrics.accuracy when passFailStatus is missing', () => {
    const high = { llmJudgeReasoning: 'good', metrics: { accuracy: 85 } };
    const low = { llmJudgeReasoning: 'bad', metrics: { accuracy: 30 } };
    expect(getJudgeMatcherResults(high as any)[0].pass).toBe(true);
    expect(getJudgeMatcherResults(low as any)[0].pass).toBe(false);
  });

  it('returns [] for a report with no judge data at all', () => {
    expect(getJudgeMatcherResults({ matcherResults: [codeEntry()] })).toEqual([]);
    expect(getJudgeMatcherResults({})).toEqual([]);
  });

  it('returns [] when llmJudgeReasoning is empty or whitespace', () => {
    expect(getJudgeMatcherResults({ llmJudgeReasoning: '' })).toEqual([]);
    expect(getJudgeMatcherResults({ llmJudgeReasoning: '   \n\t  ' })).toEqual([]);
  });

  it('treats the trace-mode placeholder as "no judge ran" (issue #230)', () => {
    // Pre-fix this would have synthesized a virtual entry containing the
    // placeholder string and the UI would have rendered a fake judge
    // verdict. Post-fix the accessor recognises the placeholder and
    // returns [] so the UI knows there's nothing to show.
    const report = { llmJudgeReasoning: 'Waiting for traces to become available...' };
    expect(getJudgeMatcherResults(report)).toEqual([]);

    // Variations are also caught.
    expect(
      getJudgeMatcherResults({ llmJudgeReasoning: 'waiting for traces' })
    ).toEqual([]);
  });

  it('prefers existing matcher entries over the legacy field (no double-counting)', () => {
    // A hybrid report (already migrated, legacy field still populated)
    // must not produce duplicate entries.
    const j = judgeEntry();
    const report = {
      matcherResults: [j],
      llmJudgeReasoning: 'this should NOT be returned as a duplicate',
    };
    const out = getJudgeMatcherResults(report);
    expect(out).toEqual([j]);
  });
});

describe('getJudgeReasoningText — flat-string convenience', () => {
  it('returns empty string when no judge ran', () => {
    expect(getJudgeReasoningText({})).toBe('');
    expect(getJudgeReasoningText({ llmJudgeReasoning: '' })).toBe('');
  });

  it('returns the single matcher reasoning verbatim', () => {
    const report = { matcherResults: [judgeEntry({ reasoning: 'hello' })] };
    expect(getJudgeReasoningText(report)).toBe('hello');
  });

  it('joins multiple matcher reasonings with a markdown separator', () => {
    const report = {
      matcherResults: [
        judgeEntry({ description: 'judge: claim A', pass: true, reasoning: 'reason A' }),
        judgeEntry({ description: 'judge: claim B', pass: false, reasoning: 'reason B' }),
      ],
    };
    const out = getJudgeReasoningText(report);
    expect(out).toContain('PASS');
    expect(out).toContain('claim A');
    expect(out).toContain('reason A');
    expect(out).toContain('FAIL');
    expect(out).toContain('claim B');
    expect(out).toContain('reason B');
    expect(out).toContain('---');
  });

  it('falls back to legacy reasoning for old reports', () => {
    expect(
      getJudgeReasoningText({
        llmJudgeReasoning: 'old verbatim reasoning',
        passFailStatus: 'passed' as any,
      } as any)
    ).toBe('old verbatim reasoning');
  });
});

describe('buildJudgeMatcherEntries — structured outcome mapping', () => {
  const baseResult = {
    passFailStatus: 'failed' as const,
    metrics: { accuracy: 50 },
    llmJudgeReasoning: 'One of two outcomes was achieved.',
  };

  it('maps every structured outcome to its own llm-judge matcher', () => {
    const entries = buildJudgeMatcherEntries({
      ...baseResult,
      outcomeResults: [
        { outcome: 'Find the root cause', pass: true, evidence: 'The final answer names the failed cache.' },
        { outcome: 'Do not edit files', pass: false, evidence: 'The trajectory contains a write call.' },
      ],
    }, { expectedOutcomes: ['Find the root cause', 'Do not edit files'] });

    expect(entries).toEqual([
      {
        description: 'Find the root cause',
        pass: true,
        reasoning: 'The final answer names the failed cache.',
        method: 'llm-judge',
      },
      {
        description: 'Do not edit files',
        pass: false,
        reasoning: 'The trajectory contains a write call.',
        method: 'llm-judge',
      },
    ]);
  });

  it('falls back to the aggregate matcher when the outcomes array is absent', () => {
    expect(buildJudgeMatcherEntries(baseResult)).toEqual([
      expect.objectContaining({
        description: 'judge: expected outcomes',
        pass: false,
        reasoning: baseResult.llmJudgeReasoning,
        method: 'llm-judge',
        score: 0.5,
      }),
    ]);
  });

  it('falls back when the array does not cover the expected outcomes verbatim', () => {
    const entries = buildJudgeMatcherEntries({
      ...baseResult,
      outcomeResults: [
        { outcome: 'Only one outcome', pass: true, evidence: 'Grounded.' },
      ],
    }, { expectedOutcomes: ['First outcome', 'Second outcome'] });
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('judge: expected outcomes');
  });

  it('falls back instead of persisting a partially malformed outcomes array', () => {
    const entries = buildJudgeMatcherEntries({
      ...baseResult,
      outcomeResults: [
        { outcome: 'Valid', pass: true, evidence: 'Grounded.' },
        { outcome: '', pass: false, evidence: '' },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('judge: expected outcomes');
  });
});

describe('recordJudgeMatcherResult — the write helper', () => {
  it('appends a new [llm-judge] entry to matcherResults and keeps llmJudgeReasoning in sync (Option B BC shim)', () => {
    const report: any = {};
    const judgeResult = {
      passFailStatus: 'passed' as const,
      metrics: { accuracy: 100 },
      llmJudgeReasoning: 'Agent satisfied the claim.',
      judgeDurationMs: 4200,
    };

    const entry = recordJudgeMatcherResult(report, judgeResult, {
      claim: 'identifies the root cause',
      model: 'claude-sonnet',
    });

    // Returned entry has the right shape
    expect(entry).toMatchObject({
      description: 'judge: identifies the root cause',
      pass: true,
      method: 'llm-judge',
      durationMs: 4200,
      score: 1,
      reasoning: 'Agent satisfied the claim.',
      model: 'claude-sonnet',
    });
    // No errorMessage on a passing entry
    expect((entry as any).errorMessage).toBeUndefined();

    // Persisted on the report
    expect(report.matcherResults).toEqual([entry]);

    // Legacy field populated as a derived shim — Option B backward compat.
    expect(report.llmJudgeReasoning).toBe('Agent satisfied the claim.');
  });

  it('does NOT mirror reasoning into errorMessage on failure (reasoning is canonical; the mirror caused double-rendering)', () => {
    const report: any = { matcherResults: [] };
    const entry = recordJudgeMatcherResult(report, {
      passFailStatus: 'failed' as const,
      metrics: { accuracy: 0 },
      llmJudgeReasoning: 'Did not satisfy.',
    });
    expect(entry.pass).toBe(false);
    expect(entry.errorMessage).toBeUndefined();
    expect(entry.reasoning).toBe('Did not satisfy.');
  });

  it('preserves existing matcherResults entries when appending', () => {
    const code = codeEntry();
    const report: any = { matcherResults: [code] };
    const entry = recordJudgeMatcherResult(report, {
      passFailStatus: 'passed' as const,
      metrics: { accuracy: 100 },
      llmJudgeReasoning: 'ok',
    });
    expect(report.matcherResults).toEqual([code, entry]);
  });

  it('round-trips through getJudgeMatcherResults (write then read sees the same entry)', () => {
    const report: any = {};
    const entry = recordJudgeMatcherResult(
      report,
      {
        passFailStatus: 'passed' as const,
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'ok',
        judgeDurationMs: 1000,
      },
      { claim: 'finds the bug' }
    );
    expect(getJudgeMatcherResults(report)).toEqual([entry]);
    expect(getJudgeReasoningText(report)).toBe('ok');
  });

  it('uses default claim text when not provided', () => {
    const report: any = {};
    const entry = recordJudgeMatcherResult(report, {
      passFailStatus: 'passed' as const,
      metrics: { accuracy: 100 },
      llmJudgeReasoning: 'r',
    });
    expect(entry.description).toBe('judge: expected outcomes');
  });

  it('omits score when accuracy is missing/non-numeric', () => {
    const report: any = {};
    const entry = recordJudgeMatcherResult(report, {
      passFailStatus: 'passed' as const,
      metrics: {} as any,
      llmJudgeReasoning: 'r',
    });
    expect(entry.score).toBeUndefined();
  });

  it('preserves improvementStrategies and judgeMetrics on the matcher entry (no truncation — follow-up to the unification)', () => {
    const report: any = {};
    const strategies = [
      { category: 'Reasoning', issue: 'x', recommendation: 'y', priority: 'high' as const },
      { category: 'Communication', issue: 'p', recommendation: 'q', priority: 'medium' as const },
    ];
    const entry = recordJudgeMatcherResult(
      report,
      {
        passFailStatus: 'failed' as const,
        metrics: { accuracy: 0, faithfulness: 30, latency_score: 80, trajectory_alignment_score: 50 },
        llmJudgeReasoning: 'reasoning',
        improvementStrategies: strategies,
        judgeDurationMs: 1234,
      },
      { claim: 'finds the bug' }
    );
    expect(entry.improvementStrategies).toEqual(strategies);
    expect((entry as any).judgeMetrics).toEqual({
      accuracy: 0, faithfulness: 30, latency_score: 80, trajectory_alignment_score: 50,
    });
    // Round-trip through the read accessor preserves them too.
    expect(getJudgeMatcherResults(report)[0].improvementStrategies).toEqual(strategies);
  });
});

describe('formatExpectedOutcomesAsClaim — string[] and legacy object shapes', () => {
  // import is at top of file
  const { formatExpectedOutcomesAsClaim } = require('@/lib/matchers/judgeAccessor');

  it('handles undefined / null / empty', () => {
    expect(formatExpectedOutcomesAsClaim(undefined)).toBe('expected outcomes');
    expect(formatExpectedOutcomesAsClaim(null)).toBe('expected outcomes');
    expect(formatExpectedOutcomesAsClaim([])).toBe('expected outcomes');
    expect(formatExpectedOutcomesAsClaim({})).toBe('expected outcomes');
  });

  it('returns single string verbatim', () => {
    expect(formatExpectedOutcomesAsClaim(['identifies the bug'])).toBe('identifies the bug');
  });

  it('summarises multiple strings', () => {
    expect(formatExpectedOutcomesAsClaim(['a', 'b', 'c'])).toBe('3 expected outcomes');
  });

  it('flattens the legacy { rootCauses, requiredFacts, conclusions } shape', () => {
    // This shape ships on persisted TestCase docs (see browserRecovery test
    // fixtures); the formatter must not throw on it.
    const out = formatExpectedOutcomesAsClaim({
      rootCauses: ['rc1'],
      requiredFacts: ['rf1', 'rf2'],
      conclusions: ['c1'],
    });
    expect(out).toBe('4 expected outcomes');
  });

  it('ignores non-string entries inside arrays', () => {
    expect(formatExpectedOutcomesAsClaim(['a', null as any, 42 as any, '', '  '])).toBe('a');
  });
});
