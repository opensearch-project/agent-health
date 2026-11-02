/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * lib/judgement/checks.ts — the plain-language reading of matcher results
 * behind the Judge Evaluation tab: assertion-message parsing (title +
 * measured-vs-limit), the "not reached" marker, the verdict headline, and
 * judge-prose sectioning. Fixtures mirror the exact strings a code-SDK test
 * records (chai text in `description`, author message in `errorMessage`).
 */

import {
  parseAssertionMessage,
  checkTitle,
  checkEvidence,
  isNotReachedMarker,
  summarizeChecks,
  buildJudgementHeadline,
  splitReasoningSections,
  formatNumber,
  formatRatio,
} from '@/lib/judgement/checks';
import type { MatcherResult } from '@/lib/matchers/types';

const COST_MSG = 'AGENTIC cost/latency within the fix bar: totalTokens=339809 (bar ≤ 60000), time=92.3 s (bar ≤ 30 s), documents=1 (request f0b3b306-6a28-43a8-83eb-664a3f673091, mode AGENTIC): expected false to equal true';
const REFUSAL_MSG = 'synthesis answers from document content: answer=2479 chars, refusal=false, citations=4 (need ≥4), P-tagged items=0 (need ≥3), documents=5, totalTokens=488517 (request 347ce086, mode AGENTIC): expected false to equal true';
const NOT_REACHED_DESC = 'Test body did not complete: an error was thrown before reaching further matcher calls in source order, so any expect()/judge()/evaluate() calls after that point never executed.';

const m = (over: Partial<MatcherResult>): MatcherResult => ({ description: 'false to equal true', pass: false, method: 'code-assertion', ...over });

describe('parseAssertionMessage', () => {
  it('splits label, measured-vs-limit pairs (with ratio), free context and the chai clause', () => {
    const p = parseAssertionMessage(COST_MSG);
    expect(p.label).toBe('AGENTIC cost/latency within the fix bar');
    expect(p.expected).toBe('false to equal true');
    expect(p.context).toBe('request f0b3b306-6a28-43a8-83eb-664a3f673091, mode AGENTIC');
    expect(p.measurements).toEqual([
      { key: 'totalTokens', value: '339809', op: '≤', limit: '60000', ok: false, ratio: 339809 / 60000 },
      { key: 'time', value: '92.3 s', op: '≤', limit: '30 s', ok: false, ratio: 92.3 / 30 },
      { key: 'documents', value: '1' },
    ]);
  });

  it('handles ≥ limits, booleans and multi-word keys without swallowing the next pair', () => {
    const p = parseAssertionMessage(REFUSAL_MSG);
    expect(p.label).toBe('synthesis answers from document content');
    const byKey = Object.fromEntries(p.measurements.map(x => [x.key, x]));
    expect(byKey['citations']).toMatchObject({ value: '4', op: '≥', limit: '4', ok: true });
    expect(byKey['P-tagged items']).toMatchObject({ value: '0', op: '≥', limit: '3', ok: false, ratio: 0 });
    expect(byKey['refusal']).toMatchObject({ value: 'false' });
    expect(byKey['refusal'].ok).toBeUndefined(); // booleans are never judged from their key name
    expect(byKey['documents']).toMatchObject({ value: '5' });
    expect(byKey['totalTokens']).toMatchObject({ value: '488517' });
    expect(byKey['answer']).toMatchObject({ value: '2479 chars' });
  });

  it('a narrative with k=v but no "label:" becomes the label; chai-only text and plain prose stay unstructured', () => {
    const narrative = parseAssertionMessage('answer present with retrieval omitted; service chose SIMPLE, documents=0 (request 1175d3c2, mode SIMPLE): expected false to equal true');
    expect(narrative.structured).toBe(true);
    expect(narrative.label).toBe('answer present with retrieval omitted, service chose SIMPLE');
    expect(narrative.measurements).toEqual([{ key: 'documents', value: '0' }]);
    const chai = parseAssertionMessage('expected 47320 to be below 30000');
    expect(chai.structured).toBe(false);
    expect(chai.label).toBe('');
    // A bare error is NOT a label (it would otherwise hide the raw text behind a disclosure).
    const bare = parseAssertionMessage('ECONNRESET');
    expect(bare.structured).toBe(false);
    expect(bare.label).toBe('');
    expect(bare.rest).toBe('ECONNRESET');
  });

  it('bracketed values stay whole ("retrieval_paths=[…] from 87 spans") and are evidence without a limit', () => {
    const p = parseAssertionMessage('a vector path (knn/neural/hybrid) was used: retrieval_paths=[filter-only:3, lexical:16] from 87 spans (request d55c6e47, mode AGENTIC): expected false to equal true');
    expect(p.label).toBe('a vector path (knn/neural/hybrid) was used');
    expect(p.measurements).toEqual([{ key: 'retrieval_paths', value: '[filter-only:3, lexical:16] from 87 spans' }]);
    expect(checkEvidence(m({ errorMessage: p.label + ': retrieval_paths=[filter-only:3, lexical:16] from 87 spans' }))).toBe('retrieval_paths [filter-only:3, lexical:16] from 87 spans');
  });

  it('compares only like units, rejects exponents/percent-vs-plain, never scales suffixes', () => {
    const byKey = (msg: string) => Object.fromEntries(parseAssertionMessage(`x: ${msg}`).measurements.map(x => [x.key, x]));
    expect(byKey('latency=500 ms (bar ≤ 1 s)').latency.ok).toBeUndefined(); // unit mismatch → not judged
    expect(byKey('latency=500 ms (bar ≤ 900 ms)').latency.ok).toBe(true);
    expect(byKey('rate=50% (bar ≤ 60%)').rate).toMatchObject({ ok: true, limit: '60%' });
    expect(byKey('n=1e6 (bar ≤ 60000)').n.ok).toBeUndefined();
    expect(byKey('tokens=339.8k (bar ≤ 60000)').tokens.ok).toBeUndefined();
    expect(byKey('hits=5 (need ≥ 10)').hits).toMatchObject({ ok: false, ratio: 0.5 });
    expect(formatRatio(0.5)).toBe('50% short');
  });

  it('never throws on junk and refuses oversized messages (linear parse, raw shown instead)', () => {
    expect(parseAssertionMessage(undefined)).toEqual({ label: '', rest: '', measurements: [], structured: false });
    expect(parseAssertionMessage('')).toEqual({ label: '', rest: '', measurements: [], structured: false });
    expect(parseAssertionMessage(':::: === (((')).toBeTruthy();
    const huge = 'label: ' + 'a=1, '.repeat(5000);
    const t0 = Date.now();
    expect(parseAssertionMessage(huge).structured).toBe(false);
    const hostile = 'label: ' + 'a '.repeat(900) + '=' + ' b'.repeat(900);
    parseAssertionMessage(hostile);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe('checkTitle / checkEvidence / not-reached', () => {
  it('uses the author label as the title and the breached pairs as the evidence', () => {
    const r = m({ errorMessage: COST_MSG });
    expect(checkTitle(r)).toBe('AGENTIC cost/latency within the fix bar');
    expect(checkEvidence(r)).toBe('totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s');
  });

  it('falls back to the chai description when there is no author message', () => {
    expect(checkTitle(m({ description: '[ Array(1) ] to be empty', pass: true }))).toBe('[ Array(1) ] to be empty');
    expect(checkEvidence(m({ description: 'x', pass: true }))).toBe('');
  });

  it("recognises the runner's not-reached marker by flag or by text, and gives it a short title with no evidence", () => {
    const byText = m({ description: NOT_REACHED_DESC, errorMessage: COST_MSG });
    const byFlag = m({ description: 'expected x', notReached: true });
    expect(isNotReachedMarker(byText)).toBe(true);
    expect(isNotReachedMarker(byFlag)).toBe(true);
    expect(checkTitle(byText)).toBe('Later checks did not run');
    expect(checkEvidence(byText)).toBe('');
  });

  it('formats numbers and ratios for humans', () => {
    expect(formatNumber('339809')).toBe('339,809');
    expect(formatNumber('92.3 s')).toBe('92.3 s');
    expect(formatRatio(5.66)).toBe('5.7× over');
    expect(formatRatio(12.4)).toBe('12× over');
    expect(formatRatio(0.25)).toBe('75% short');
  });
});

describe('summarizeChecks + buildJudgementHeadline', () => {
  const codeSdk = {
    passFailStatus: 'failed', judgeProvider: 'none', llmJudgeReasoning: '',
    matcherResults: [
      m({ description: '[ Array(1) ] to be empty', pass: true }),
      m({ errorMessage: COST_MSG }),
      m({ description: NOT_REACHED_DESC, errorMessage: COST_MSG }),
    ],
  };

  it('counts the not-reached marker separately', () => {
    expect(summarizeChecks(codeSdk.matcherResults)).toEqual({ total: 2, passed: 1, failed: 1, errored: 0, notReached: 1, notApplicable: 0, llmJudgeCalls: 0 });
  });

  it('FAILED headline names the failing check with its evidence and says how it was decided', () => {
    const h = buildJudgementHeadline(codeSdk);
    expect(h.tone).toBe('failed');
    expect(h.title).toBe('FAILED — AGENTIC cost/latency within the fix bar: totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s');
    expect(h.how).toBe('Decided by 2 code checks written in the test (no LLM judge): 1 passed, 1 failed, 1 not reached.');
  });

  it('PASSED headline — and an honest one when the verdict passed despite a failed/errored check', () => {
    const h = buildJudgementHeadline({ passFailStatus: 'passed', judgeProvider: 'none', matcherResults: [m({ pass: true }), m({ pass: true })] });
    expect(h).toEqual({ tone: 'passed', title: 'PASSED — all 2 checks passed', how: 'Decided by 2 code checks written in the test (no LLM judge): 2 passed.' });
    const mixed = buildJudgementHeadline({ passFailStatus: 'passed', judgeProvider: 'none', matcherResults: [m({ pass: true }), m({ pass: false, role: 'observe' }), m({ pass: false, errored: true })] });
    expect(mixed.title).toBe('PASSED — 1 of 3 checks passed, 1 failed, 1 could not be evaluated');
    expect(mixed.how).toBe('Decided by 2 code checks written in the test (no LLM judge): 1 passed, 1 failed, 1 could not be evaluated.');
  });

  it('a test body that threw before any check failed: the marker\'s exception becomes the reason', () => {
    const h = buildJudgementHeadline({ passFailStatus: 'failed', judgeProvider: 'none', matcherResults: [
      m({ pass: true, description: 'ok' }),
      m({ description: NOT_REACHED_DESC, notReached: true, errorMessage: 'TypeError: Cannot read properties of undefined (reading \'documents\')' }),
    ] });
    expect(h.title).toBe("FAILED — the test threw before any check could fail: TypeError: Cannot read properties of undefined (reading 'documents')");
  });

  it("mixed deterministic + LLM judge: the judge's first sentence is the reason; counts both kinds", () => {
    const h = buildJudgementHeadline({
      passFailStatus: 'failed', llmJudgeReasoning: 'x',
      matcherResults: [
        m({ description: 'evaluate: recall@10', method: 'evaluator', errorMessage: 'recall_cap@10 = 2/min(10, 108) = 0.20 (pass at ≥ 0.8).' }),
        m({ description: 'judge: 3 claims', method: 'llm-judge', reasoning: '**Summary:**\nCritical failure: the agent returned only 2 records when 10 were required. More text.' }),
        m({ description: 'evaluate: hit@1', method: 'evaluator', pass: true }),
      ],
    });
    expect(h.tone).toBe('failed');
    expect(h.title).toContain('evaluate: recall@10: recall_cap@10 = 2/min(10, 108) = 0.20 (pass at ≥ 0.8).');
    expect(h.title).toContain('judge: Critical failure: the agent returned only 2 records when 10 were required');
    expect(h.how).toBe('Decided by 3 checks — 2 deterministic + 1 LLM judge: 1 passed, 2 failed.');
  });

  it('agent / judge errors are "Not judged", never a verdict', () => {
    expect(buildJudgementHeadline({ metricsStatus: 'error', failureStage: 'agent', error: 'HTTP_500 — endpoint rejected the request.' }))
      .toEqual({ tone: 'errored', title: 'Not judged — the agent request failed', how: 'HTTP_500 — endpoint rejected the request.' });
    expect(buildJudgementHeadline({ metricsStatus: 'error', failureStage: 'judge' }).title).toBe('Not judged — the judge could not produce a verdict');
    expect(buildJudgementHeadline({}).tone).toBe('pending');
  });

  it('caps long evidence in the headline', () => {
    const h = buildJudgementHeadline({ passFailStatus: 'failed', judgeProvider: 'none', matcherResults: [m({ errorMessage: `SIMPLE request succeeded — got: ${'x'.repeat(500)} (request abc)` })] });
    expect(h.title.length).toBeLessThan(220);
    expect(h.title.endsWith('…')).toBe(true);
  });
});

describe('splitReasoningSections', () => {
  it('splits on **Heading:** lines, drops " Analysis", keeps bodies', () => {
    const text = '**Fact Precision Analysis:**\nOnly 2 records.\n\n**Provenance Verifiability:**\nPartial.\n\n**Summary:**\nCritical failure.';
    expect(splitReasoningSections(text)).toEqual([
      { title: 'Fact Precision', body: 'Only 2 records.' },
      { title: 'Provenance Verifiability', body: 'Partial.' },
      { title: 'Summary', body: 'Critical failure.' },
    ]);
  });
  it('does not split on heading-looking lines inside fenced code', () => {
    const text = '**Summary:**\nok\n\n```\n**Not a heading:**\n## nor this\n```\n\n**Details:**\nmore';
    const secs = splitReasoningSections(text);
    expect(secs.map(s => s.title)).toEqual(['Summary', 'Details']);
    expect(secs[0].body).toContain('## nor this');
  });

  it('also accepts markdown headings; one heading or none → a single section', () => {
    expect(splitReasoningSections('## A\nx\n### B\ny')).toEqual([{ title: 'A', body: 'x' }, { title: 'B', body: 'y' }]);
    expect(splitReasoningSections('**Only one:**\nbody')).toEqual([{ title: '', body: '**Only one:**\nbody' }]);
    expect(splitReasoningSections('plain prose')).toEqual([{ title: '', body: 'plain prose' }]);
  });
});
