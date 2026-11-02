/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * lib/caseSummary.ts — the deterministic sentences of the case TL;DR
 * (Asked / Agent / Verdict) built from a report and its test case. These run
 * in the browser on first paint; the server reuses them and only replaces
 * the verdict's REASON with model text (never the label).
 */

import { buildCaseSummary, buildCaseSummaryInputs, composeVerdict, hasVerdictToExplain, extractFinalAnswer, truncateForSummary } from '@/lib/caseSummary';
import type { TestCase, TestCaseRun } from '@/types';

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1', name: 'checkout 500s root cause', description: '', labels: [], category: 'Test' as any, difficulty: 'Easy' as any,
    currentVersion: 1, versions: [], isPromoted: true, createdAt: '', updatedAt: '', context: [],
    initialPrompt: 'Our checkout service returns HTTP 500 for 2% of requests since the 14:00 deploy. Find the root cause.',
    expectedOutcomes: ['Identifies the null pointer in the discount handler', 'Recommends a rollback or hot-fix'],
    ...overrides,
  } as TestCase;
}
function report(overrides: Partial<TestCaseRun> = {}): TestCaseRun {
  return {
    id: 'report-1', timestamp: '', testCaseId: 'tc-1', agentName: 'Ops RCA agent', modelName: 'demo-model',
    status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed', score: 0.9,
    trajectory: [
      { id: 's1', type: 'action', toolName: 'search_logs', toolArgs: { q: 'status:500' }, timestamp: 1 } as any,
      { id: 's2', type: 'tool_result', content: 'NullPointerException in DiscountCodeHandler', timestamp: 2 } as any,
      { id: 's3', type: 'action', toolName: 'get_deployments', timestamp: 3 } as any,
      { id: 's4', type: 'response', content: 'Root cause: build 8812 introduced a null dereference in DiscountCodeHandler. Recommend rollback.', timestamp: 4 } as any,
    ],
    metrics: { accuracy: 92, faithfulness: 90, latency_score: 85, trajectory_alignment_score: 88 } as any,
    llmJudgeReasoning: 'The agent traced the 500s to the NullPointerException introduced by build 8812 and recommended a rollback. Minor: no exact start time.',
    ...overrides,
  } as TestCaseRun;
}
const COST_MSG = 'AGENTIC cost/latency within the fix bar: totalTokens=339809 (bar ≤ 60000), time=92.3 s (bar ≤ 30 s), documents=1 (request f0b3b306, mode AGENTIC): expected false to equal true';

describe('buildCaseSummary — Asked / Agent', () => {
  it('quotes the prompt and the expected outcomes; names the tools and quotes the final response', () => {
    const p = buildCaseSummary(report(), testCase());
    expect(p.asked).toBe('The test asks: “Our checkout service returns HTTP 500 for 2% of requests since the 14:00 deploy. Find the root cause.” It has 2 expected outcomes, e.g. “Identifies the null pointer in the discount handler”.');
    expect(p.agent).toBe('Ops RCA agent used tools search_logs, get_deployments and answered: “Root cause: build 8812 introduced a null dereference in DiscountCodeHandler. Recommend rollback.”');
  });
  it('single expected outcome / no prompt / no response', () => {
    expect(buildCaseSummary(report(), testCase({ expectedOutcomes: ['Names the orders service'] })).asked).toMatch(/Expected outcome: “Names the orders service”\.$/);
    expect(buildCaseSummary(report(), null).asked).toBe('The test “tc-1” has no recorded prompt.');
    expect(buildCaseSummary(report({ trajectory: [{ id: 's1', type: 'action', toolName: 'search_logs', timestamp: 1 } as any] }), testCase()).agent)
      .toBe('Ops RCA agent used the tool search_logs and has 1 recorded step and no final text response.');
  });
  it('uses the test-case version the report ran against', () => {
    const tc = testCase({ initialPrompt: 'new prompt', currentVersion: 2, versions: [
      { version: 1, createdAt: '', initialPrompt: 'old prompt', expectedOutcomes: ['old outcome'], context: [] } as any,
      { version: 2, createdAt: '', initialPrompt: 'new prompt', expectedOutcomes: ['new outcome'], context: [] } as any,
    ] });
    expect(buildCaseSummaryInputs(report({ testCaseVersion: 1 }), tc).prompt).toBe('old prompt');
    expect(buildCaseSummaryInputs(report(), tc).prompt).toBe('new prompt');
  });
  it('quotes Markdown answers as plain prose (no fences, no ** markers)', () => {
    const md = 'The docs do not answer directly [1].\n\n- **Finding 1**: token expires at 02:00\n\n```json\n{"a":1}\n```';
    expect(buildCaseSummary(report({ trajectory: [{ id: 's1', type: 'response', content: md, timestamp: 1 } as any] }), testCase()).agent)
      .toBe('Ops RCA agent answered: “The docs do not answer directly [1]. Finding 1: token expires at 02:00”');
  });

  it('a code-only answer is quoted raw (never "no response"); an agent that made tool calls but gave no answer is not "no output"', () => {
    expect(buildCaseSummary(report({ trajectory: [{ id: 's1', type: 'response', content: '```\nSELECT 1\n```', timestamp: 1 } as any] }), testCase()).agent).toBe('Ops RCA agent answered: “SELECT 1”');
    const agentErrWithSteps = report({ status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: undefined, trajectory: [{ id: 's1', type: 'action', toolName: 'search_logs', timestamp: 1 } as any], error: 'timed out', llmJudgeReasoning: '' });
    expect(buildCaseSummary(agentErrWithSteps, testCase()).agent).toBe('Ops RCA agent used the tool search_logs and has 1 recorded step and no final text response.');
    const pendingNoAnswer = report({ metricsStatus: 'calculating', passFailStatus: undefined, trajectory: [{ id: 's1', type: 'action', toolName: 'search_logs', timestamp: 1 } as any] });
    expect(buildCaseSummary(pendingNoAnswer, testCase()).agent).toBe('Ops RCA agent used the tool search_logs and has 1 recorded step and no final response yet.');
    // A bold phrase that STARTS the judge's sentence is kept; only a heading line is dropped.
    expect(buildCaseSummary(report({ passFailStatus: 'failed', llmJudgeReasoning: '**Not** acceptable because the rollback target was wrong. More.' }), testCase()).verdict)
      .toBe('Judge verdict: FAILED (score 90%) — Not acceptable because the rollback target was wrong.');
    expect(buildCaseSummaryInputs(report({ score: Number.NaN }), testCase()).score).toBeUndefined();
    expect(buildCaseSummaryInputs(report(), testCase({ expectedOutcomes: ['', '  ', 'real'] })).expectedOutcomes).toEqual(['real']);
  });

  it('final response = last response/assistant step only', () => {
    expect(extractFinalAnswer({ trajectory: [{ id: 'a', type: 'response', content: 'first', timestamp: 1 } as any, { id: 'b', type: 'tool_result', content: 'raw', timestamp: 2 } as any] })).toBe('first');
    expect(extractFinalAnswer({ trajectory: [{ id: 'a', type: 'tool_result', content: 'raw', timestamp: 1 } as any] })).toBe('');
    expect(truncateForSummary('  a   b ', 10)).toBe('a b');
  });
});

describe('buildCaseSummary — Verdict', () => {
  it('LLM-judged: label + score + the judge\'s first sentence (Summary section preferred)', () => {
    expect(buildCaseSummary(report(), testCase()).verdict).toBe('Judge verdict: PASSED (score 90%) — The agent traced the 500s to the NullPointerException introduced by build 8812 and recommended a rollback.');
    const sectioned = report({ passFailStatus: 'failed', score: 0.42, llmJudgeReasoning: '**Fact Precision Analysis:**\nOnly 2 records.\n\n**Summary:**\nCritical failure: the agent returned only 2 records when 10 were required.' });
    expect(buildCaseSummary(sectioned, testCase()).verdict).toBe('Judge verdict: FAILED (score 42%) — Critical failure: the agent returned only 2 records when 10 were required.');
  });
  it('code checks only: label + first failing check with its measured-vs-limit evidence', () => {
    const r = report({ passFailStatus: 'failed', score: undefined, llmJudgeReasoning: '', judgeProvider: 'none', matcherResults: [
      { description: '[ Array(1) ] to be empty', pass: true, method: 'code-assertion' },
      { description: 'false to equal true', pass: false, method: 'code-assertion', errorMessage: COST_MSG },
      { description: 'Test body did not complete: …', pass: false, method: 'code-assertion', notReached: true, errorMessage: COST_MSG },
    ] as any });
    expect(buildCaseSummary(r, testCase()).verdict).toBe('Verdict: FAILED — 1 of 2 checks failed — AGENTIC cost/latency within the fix bar: totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s.');
    const passed = report({ llmJudgeReasoning: '', score: undefined, judgeProvider: 'none', matcherResults: [{ description: 'ok', pass: true, method: 'code-assertion' }] as any });
    expect(buildCaseSummary(passed, testCase()).verdict).toBe('Verdict: PASSED — all 1 check passed.');
  });
  it('a model-written reason replaces the deterministic reason but never the label; ignored for unjudged runs', () => {
    expect(buildCaseSummary(report({ passFailStatus: 'failed' }), testCase(), 'PASSED — everything was perfect').verdict)
      .toBe('Judge verdict: FAILED (score 90%) — PASSED — everything was perfect.');
    const agentErr = report({ status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: undefined, score: undefined, trajectory: [], error: 'Agent request timed out after 30012ms', llmJudgeReasoning: '' });
    expect(buildCaseSummary(agentErr, testCase(), 'the agent passed').verdict).toBe('Not judged: the agent request failed — Agent request timed out after 30012ms.');
    expect(buildCaseSummary(agentErr, testCase()).agent).toBe('Ops RCA agent produced no output.');
    expect(hasVerdictToExplain(agentErr)).toBe(false);
    expect(hasVerdictToExplain(report())).toBe(true);
  });
  it('judge error / pending read as not judged, never zeros', () => {
    const judgeErr = report({ metricsStatus: 'error', failureStage: 'judge', passFailStatus: undefined, score: undefined, error: 'judge returned no parseable verdict', llmJudgeReasoning: '**Evaluator could not run.**' });
    expect(buildCaseSummary(judgeErr, testCase()).verdict).toBe('Not judged: the judge could not produce a verdict — judge returned no parseable verdict.');
    expect(buildCaseSummary(report({ metricsStatus: 'calculating', passFailStatus: undefined }), testCase()).verdict).toBe('Not judged yet: judgement in progress.');
    const inputs = buildCaseSummaryInputs(judgeErr, testCase());
    expect(composeVerdict(inputs, 'whatever', false)).not.toMatch(/score|PASSED|FAILED/);
  });
});
