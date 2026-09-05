/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseJudgeResponse,
  extractJsonFromResponse,
} from '@/server/services/judgeResponseParser';
import type { Evaluator } from '@/types';

/** Minimal Evaluator stub matching the fields the parser actually consults. */
function makeEvaluator(metricNames: string[]): Evaluator {
  return {
    id: 'eval-test',
    name: 'Test',
    description: '',
    isSystem: false,
    systemPrompt: '',
    scoringConfig: {
      metrics: metricNames.map((name) => ({ name, description: '', weight: 1, scale: 100 })),
      passThreshold: 70,
      scale: 100,
    },
    inferenceConfig: {},
  } as unknown as Evaluator;
}

describe('judgeResponseParser', () => {
  describe('extractJsonFromResponse', () => {
    it('pulls JSON out of a markdown ```json fence', () => {
      const input = 'prose\n```json\n{"a":1}\n```\ntrailer';
      expect(extractJsonFromResponse(input)).toBe('{"a":1}');
    });

    it('pulls bare {...} JSON out of surrounding prose', () => {
      // Some models still emit prose despite being told not to. The parser
      // must not blow up on that.
      const input = 'Here you go: {"a":1, "b":2} (cheers)';
      expect(extractJsonFromResponse(input)).toBe('{"a":1, "b":2}');
    });

    it('returns undefined when there is no JSON object at all', () => {
      expect(extractJsonFromResponse('no json here')).toBeUndefined();
    });
  });

  describe('parseJudgeResponse', () => {
    it('captures rawResponse exactly as provided', () => {
      const raw = '{"pass_fail_status":"passed","reasoning":"ok","accuracy":90}';
      const out = parseJudgeResponse(raw);
      expect(out.rawResponse).toBe(raw);
    });

    it('coerces pass_fail_status, reasoning, improvement_strategies', () => {
      const raw = JSON.stringify({
        pass_fail_status: 'passed',
        reasoning: 'looks good',
        improvement_strategies: [
          { category: 'tools', issue: 'x', recommendation: 'y', priority: 'low' },
        ],
        accuracy: 85,
      });
      const out = parseJudgeResponse(raw);
      expect(out.passFailStatus).toBe('passed');
      expect(out.llmJudgeReasoning).toBe('looks good');
      expect(out.improvementStrategies).toHaveLength(1);
    });

    it('sanitizes malformed improvement_strategies entries instead of passing raw model JSON through (defense against strategy.category.replace()-style UI crashes)', () => {
      const raw = JSON.stringify({
        pass_fail_status: 'failed',
        reasoning: 'bad output',
        improvement_strategies: [
          // Fully valid entry — passed through untouched.
          { category: 'reliability', issue: 'flaky retries', recommendation: 'add backoff', priority: 'high' },
          // Missing every field.
          {},
          // Wrong types / unknown priority.
          { category: 42, issue: null, recommendation: {}, priority: 'urgent' },
          // Legacy bare-string shape — coerced into a valid entry (issue = the string), not dropped.
          'a bare string',
          // Genuinely useless / non-object, non-string junk — dropped entirely.
          '',
          '   ',
          null,
          123,
        ],
      });
      const out = parseJudgeResponse(raw);
      // The empty-string/null/number entries are dropped; the object
      // entries and the bare string survive, coerced to safe defaults.
      expect(out.improvementStrategies).toHaveLength(4);
      expect(out.improvementStrategies[0]).toEqual({
        category: 'reliability',
        issue: 'flaky retries',
        recommendation: 'add backoff',
        priority: 'high',
      });
      expect(out.improvementStrategies[1]).toEqual({
        category: 'general',
        issue: '',
        recommendation: '',
        priority: 'medium',
      });
      expect(out.improvementStrategies[2]).toEqual({
        category: 'general',
        issue: '',
        recommendation: '',
        priority: 'medium',
      });
      expect(out.improvementStrategies[3]).toEqual({
        category: 'general',
        issue: 'a bare string',
        recommendation: '',
        priority: 'medium',
      });
      // No entry has a priority outside the typed union — the UI keys
      // (priorityColors[strategy.priority] etc.) can never miss.
      for (const s of out.improvementStrategies) {
        expect(['high', 'medium', 'low']).toContain(s.priority);
        expect(typeof s.category).toBe('string');
      }
    });

    it('returns [] (not undefined, not a crash) when improvement_strategies is missing or not an array', () => {
      for (const value of [undefined, null, 'not-an-array', 42, {}]) {
        const raw = JSON.stringify({ pass_fail_status: 'passed', reasoning: 'ok', improvement_strategies: value });
        expect(parseJudgeResponse(raw).improvementStrategies).toEqual([]);
      }
    });

    it('treats anything other than literal "passed" as failed', () => {
      // Defensive: model occasionally emits "FAIL" / "fail" / "false". The
      // typed wire shape is binary, so anything not exactly "passed" must
      // become "failed" \u2014 which is the safe default.
      for (const status of ['failed', 'FAIL', 'fail', '', null, undefined]) {
        const raw = JSON.stringify({ pass_fail_status: status, reasoning: 'r', accuracy: 0 });
        expect(parseJudgeResponse(raw).passFailStatus).toBe('failed');
      }
    });

    describe('with evaluator (dynamic metrics)', () => {
      it('extracts metrics declared by the evaluator from top-level keys', () => {
        const evaluator = makeEvaluator(['custom_score', 'tool_correctness']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 80,
          tool_correctness: 95,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics).toEqual({ custom_score: 80, tool_correctness: 95 });
      });

      it('extracts metrics from nested `metrics` object (legacy shape)', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          metrics: { custom_score: 72 },
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics.custom_score).toBe(72);
      });

      it('extracts metrics from a rubric-style `scores` object', () => {
        // The AES Oncall evaluator (and other rubric-style judges) emit
        // dimension scores under a `scores` key. Without this fallback the
        // declared metrics would be silently missing even though the values
        // are clearly in the JSON.
        const evaluator = makeEvaluator(['tool_correctness', 'diagnostic_completeness']);
        const raw = JSON.stringify({
          pass_fail_status: 'failed',
          reasoning: 'r',
          scores: { tool_correctness: 30, diagnostic_completeness: 40, calibration: 60 },
          weighted_score: 35,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics.tool_correctness).toBe(30);
        expect(out.metrics.diagnostic_completeness).toBe(40);
        // `calibration` wasn't declared so it lands in extraFields.scores_unmapped,
        // not in `metrics`.
        expect(out.metrics).not.toHaveProperty('calibration');
        expect(out.extraFields?.scores_unmapped).toEqual({ calibration: 60 });
        // `weighted_score` is a typical extra field on rubric prompts.
        expect(out.extraFields?.weighted_score).toBe(35);
      });

      it('drops missing metrics silently (does not synthesize a 0)', () => {
        // If the model didn't emit a metric, downstream UIs need to be able
        // to tell the difference between "scored 0" and "didn't score". We
        // chose not-emitted = absent.
        const evaluator = makeEvaluator(['custom_score', 'never_present']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 50,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics).toEqual({ custom_score: 50 });
      });

      it('coerces stringified numbers ("85") to numbers', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: '85',
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.metrics.custom_score).toBe(85);
      });
    });

    describe('without evaluator (legacy fallback)', () => {
      it('extracts the legacy 4-metric set so old standalone callers keep working', () => {
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          accuracy: 88,
          metrics: { faithfulness: 90, latency_score: 70, trajectory_alignment_score: 80 },
        });
        const out = parseJudgeResponse(raw);
        expect(out.metrics.accuracy).toBe(88);
        expect(out.metrics.faithfulness).toBe(90);
        expect(out.metrics.latency_score).toBe(70);
        expect(out.metrics.trajectory_alignment_score).toBe(80);
      });

      it('defaults accuracy to 0 when absent (legacy shape contract)', () => {
        // Pre-fix code had `accuracy ?? 0` baked into every spawned-CLI
        // service; preserve that fallback in the legacy-no-evaluator path
        // so back-compat callers (the unit test that exercises
        // parsePiJudgeJson standalone) keep getting accuracy=0.
        const raw = JSON.stringify({ pass_fail_status: 'passed', reasoning: 'r' });
        const out = parseJudgeResponse(raw);
        expect(out.metrics.accuracy).toBe(0);
      });
    });

    describe('extraFields capture (the prompt-iteration escape hatch)', () => {
      it('captures top-level keys the model emitted that are not typed', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 80,
          // these are NEW prompt outputs the user added
          improvement_candidates: ['call search_logs sooner'],
          failure_tags: ['budget-overshoot'],
          confidence: 0.72,
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.extraFields).toEqual({
          improvement_candidates: ['call search_logs sooner'],
          failure_tags: ['budget-overshoot'],
          confidence: 0.72,
        });
      });

      it('captures metrics keys the evaluator did not declare into metrics_unmapped', () => {
        const evaluator = makeEvaluator(['custom_score']);
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          custom_score: 80,
          metrics: {
            custom_score: 80,             // declared \u2014 consumed
            confidence: 90,               // not declared and not legacy \u2014 captured
          },
        });
        const out = parseJudgeResponse(raw, { evaluator });
        expect(out.extraFields?.metrics_unmapped).toEqual({ confidence: 90 });
      });

      it('returns extraFields=undefined when the model emitted ONLY typed fields', () => {
        const raw = JSON.stringify({
          pass_fail_status: 'passed',
          reasoning: 'r',
          accuracy: 90,
          improvement_strategies: [],
        });
        const out = parseJudgeResponse(raw);
        expect(out.extraFields).toBeUndefined();
      });
    });

    it('throws a labelled error when the response has no JSON object', () => {
      expect(() => parseJudgeResponse('not json', { source: 'TestSrc' })).toThrow(/TestSrc/);
    });

    it('throws a labelled error when the JSON is malformed', () => {
      expect(() => parseJudgeResponse('{bad json', { source: 'TestSrc' })).toThrow(/TestSrc/);
    });
  });
});

describe('computeWeightedOverall / overallScore', () => {
  function makeWeightedEvaluator(defs: Array<{ name: string; weight?: number }>): Evaluator {
    return {
      id: 'eval-weighted',
      name: 'Weighted',
      description: '',
      isSystem: false,
      systemPrompt: '',
      scoringConfig: {
        metrics: defs.map((d) => ({ name: d.name, description: '', weight: d.weight, scale: 100 })),
        passThreshold: 80,
        scale: 100,
      },
      inferenceConfig: {},
    } as unknown as Evaluator;
  }

  it('computes the weighted overall across declared metrics (logos-human-persona shape)', () => {
    // Real evaluator: answer_correctness 0.55, trust_honesty 0.30, readability 0.15.
    const evaluator = makeWeightedEvaluator([
      { name: 'answer_correctness', weight: 0.55 },
      { name: 'trust_honesty', weight: 0.3 },
      { name: 'readability', weight: 0.15 },
    ]);
    const raw = JSON.stringify({
      pass_fail_status: 'failed',
      answer_correctness: 55,
      trust_honesty: 45,
      readability: 75,
      reasoning: 'both gates missed',
    });
    const res = parseJudgeResponse(raw, { evaluator });
    // 0.55·55 + 0.30·45 + 0.15·75 = 55
    expect(res.overallScore).toBeCloseTo(55);
    expect(res.metrics.accuracy).toBeUndefined();
  });

  it('is all-or-nothing: a metric the judge failed to emit voids the overall (no flattering renormalization)', () => {
    const evaluator = makeWeightedEvaluator([
      { name: 'a', weight: 0.5 },
      { name: 'b', weight: 0.5 },
    ]);
    const raw = JSON.stringify({ pass_fail_status: 'passed', a: 80, reasoning: 'b missing' });
    const res = parseJudgeResponse(raw, { evaluator });
    // Renormalizing over emitted weights would report 80 — rewarding a
    // partial/malformed judge response with its best dimension.
    expect(res.overallScore).toBeUndefined();
  });

  it('defaults missing/invalid weights to 1', () => {
    const evaluator = makeWeightedEvaluator([{ name: 'a' }, { name: 'b', weight: 0 }]);
    const raw = JSON.stringify({ pass_fail_status: 'passed', a: 60, b: 100, reasoning: '' });
    const res = parseJudgeResponse(raw, { evaluator });
    expect(res.overallScore).toBeCloseTo(80);
  });

  it('omits overallScore when the evaluator declares no metrics (legacy path)', () => {
    const raw = JSON.stringify({ pass_fail_status: 'passed', accuracy: 90, reasoning: '' });
    const res = parseJudgeResponse(raw, {});
    expect(res.overallScore).toBeUndefined();
    expect(res.metrics.accuracy).toBe(90);
  });

  it('omits overallScore when none of the declared metrics were emitted', () => {
    const evaluator = makeWeightedEvaluator([{ name: 'a', weight: 1 }]);
    const raw = JSON.stringify({ pass_fail_status: 'failed', reasoning: 'nothing' });
    const res = parseJudgeResponse(raw, { evaluator });
    expect(res.overallScore).toBeUndefined();
  });
});
