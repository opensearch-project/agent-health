/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  askLinks,
  buildAskSnapshot,
  buildAskSystemPrompt,
  buildAskUserPrompt,
  deriveAskRefs,
  resolveAskRefs,
} from '@/server/services/ask/askContext';
import type { IStorageModule } from '@/server/adapters/types';

describe('deriveAskRefs — ids from PATH routes', () => {
  it('run inspector: benchmark + evaluation run + reportId query', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench-1/runs/eval-run-2/inspect?reportId=report-3')).toEqual({
      benchmarkId: 'bench-1',
      runId: 'eval-run-2',
      reportId: 'report-3',
    });
  });

  it('run inspector without a selected report', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench-1/runs/eval-run-2/inspect')).toEqual({ benchmarkId: 'bench-1', runId: 'eval-run-2' });
  });

  it('benchmark case page', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench-1/cases/tc-9')).toEqual({ benchmarkId: 'bench-1', testCaseId: 'tc-9' });
  });

  it('evaluation run detail (no benchmark)', () => {
    expect(deriveAskRefs('/evaluations/runs/eval-run-2')).toEqual({ runId: 'eval-run-2' });
    expect(deriveAskRefs('/evaluations/runs/eval-run-2/inspect?reportId=report-3')).toEqual({ runId: 'eval-run-2', reportId: 'report-3' });
    expect(deriveAskRefs('/evaluations/runs/new')).toEqual({});
  });

  it('compare page: benchmark + comparison run ids (which are RUN ids, not report ids)', () => {
    expect(deriveAskRefs('/compare/bench-1?runs=run-a,run-b,%20run-c')).toEqual({
      benchmarkId: 'bench-1',
      comparisonRunIds: ['run-a', 'run-b', 'run-c'],
    });
    expect(deriveAskRefs('/compare')).toEqual({});
  });

  it('legacy run details routes carry a REPORT id', () => {
    expect(deriveAskRefs('/runs/report-3')).toEqual({ reportId: 'report-3' });
    expect(deriveAskRefs('/benchmarks/bench-1/runs/report-3')).toEqual({ benchmarkId: 'bench-1', reportId: 'report-3' });
  });

  it('test case routes', () => {
    expect(deriveAskRefs('/evaluations/test-cases/tc-9')).toEqual({ testCaseId: 'tc-9' });
    expect(deriveAskRefs('/test-cases/tc-9/runs')).toEqual({ testCaseId: 'tc-9' });
  });

  it('traceId / testCaseId query params', () => {
    expect(deriveAskRefs('/agent-traces?traceId=abc')).toEqual({ traceId: 'abc' });
  });

  it('decodes URI-encoded ids and ignores id-less pages', () => {
    expect(deriveAskRefs('/evaluations/benchmarks/bench%201')).toEqual({ benchmarkId: 'bench 1' });
    expect(deriveAskRefs('/')).toEqual({});
    expect(deriveAskRefs('/settings')).toEqual({});
  });
});

describe('resolveAskRefs — client params win over the route', () => {
  it('merges and prefers client-supplied ids', () => {
    expect(resolveAskRefs({ route: '/evaluations/benchmarks/b/runs/r/inspect', params: { reportId: 'report-x', benchmarkId: '' } })).toEqual({
      benchmarkId: 'b',
      runId: 'r',
      reportId: 'report-x',
    });
  });
});

describe('askLinks — PATH-routed, never hash routes', () => {
  it('builds inspector / compare / test-case links', () => {
    expect(askLinks.report('b', 'r', 'rep')).toBe('/evaluations/benchmarks/b/runs/r/inspect?reportId=rep');
    expect(askLinks.report(undefined, 'r', 'rep')).toBe('/evaluations/runs/r/inspect?reportId=rep');
    expect(askLinks.report(undefined, undefined, 'rep')).toBe('/runs/rep');
    expect(askLinks.compare('b', ['x', 'y'])).toBe('/compare/b?runs=x,y');
    expect(askLinks.testCase('tc')).toBe('/evaluations/test-cases/tc');
    for (const l of [askLinks.report('b', 'r', 'rep'), askLinks.compare('b', ['x']), askLinks.run('b', 'r'), askLinks.benchmark('b')]) {
      expect(l).not.toContain('#');
    }
  });
});

// ---------------------------------------------------------------------------

function fakeStorage(data: {
  reports?: Record<string, any>;
  evaluationRuns?: Record<string, any>;
  testCases?: Record<string, any>;
  benchmarks?: Record<string, any>;
  byExperimentRun?: Record<string, any[]>;
}): IStorageModule {
  return {
    runs: {
      getById: async (id: string) => data.reports?.[id] ?? null,
      getByExperimentRun: async (b: string, r: string) => data.byExperimentRun?.[`${b}/${r}`] ?? [],
    },
    evaluationRuns: { getById: async (id: string) => data.evaluationRuns?.[id] ?? null },
    testCases: { getById: async (id: string) => data.testCases?.[id] ?? null },
    benchmarks: { getById: async (id: string) => data.benchmarks?.[id] ?? null },
  } as unknown as IStorageModule;
}

describe('buildAskSnapshot', () => {
  const report = {
    id: 'report-3',
    testCaseId: 'tc-9',
    experimentRunId: 'eval-run-2',
    experimentId: 'bench-1',
    traceId: 'trace-abc',
    passFailStatus: 'failed',
    status: 'completed',
    llmJudgeReasoning: 'Fact precision 12.5/100: cited 1 of 8 gold products.',
    trajectory: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, timestamp: i, type: 'assistant', content: `step ${i}` })),
  };
  const evaluationRun = {
    id: 'eval-run-2',
    name: 'Nightly',
    status: 'completed',
    agentKey: 'cc',
    benchmarkId: 'bench-1',
    testCaseSnapshots: [{ id: 'tc-9', name: 'vocab_649', version: 1 }],
    results: { 'tc-9': { reportId: 'report-3', status: 'failed', passFailStatus: 'failed' } },
    stats: { passed: 0, failed: 1, pending: 0, total: 1 },
  };

  it('follows a report to its run, test case and benchmark, emits PATH links and trims the trajectory', async () => {
    const storage = fakeStorage({
      reports: { 'report-3': report },
      evaluationRuns: { 'eval-run-2': evaluationRun },
      testCases: { 'tc-9': { id: 'tc-9', name: 'vocab_649', versions: [{ initialPrompt: 'find X', expectedOutcomes: ['returns 474'] }] } },
      benchmarks: { 'bench-1': { id: 'bench-1', name: 'retail', testCaseIds: ['tc-9'], runs: [{ id: 'eval-run-2', name: 'Nightly', stats: {} }] } },
    });
    const snap = await buildAskSnapshot(storage, { reportId: 'report-3' });
    expect(snap.refs).toEqual({ reportId: 'report-3', testCaseId: 'tc-9', runId: 'eval-run-2', benchmarkId: 'bench-1', traceId: 'trace-abc' });
    expect(snap.loaded).toEqual(['report report-3', 'run eval-run-2', 'test case tc-9', 'benchmark bench-1']);
    expect(snap.markdown).toContain('/evaluations/benchmarks/bench-1/runs/eval-run-2/inspect?reportId=report-3');
    expect(snap.markdown).toContain('Fact precision 12.5/100');
    expect(snap.markdown).toContain('"trajectoryTotalSteps": 40');
    expect(snap.markdown).toContain('"trajectoryIncluded": "complete"');
    expect(snap.markdown).toContain('"i": 39');
    expect(snap.markdown).toContain('"vocab_649: failed"');
    expect(snap.markdown).toContain('"testCase": "vocab_649"'); // notPassed carries the report id
    expect(snap.markdown).toContain('returns 474');
    expect(snap.markdown).not.toContain('/#/');
  });

  it('compare page: cross-tabulates per-case verdicts and names regressions deterministically', async () => {
    const mk = (id: string, name: string, byCase: Record<string, string>) => ({
      id, name, status: 'completed', agentKey: 'a',
      testCaseSnapshots: Object.keys(byCase).map((tc) => ({ id: tc, name: `case ${tc}`, version: 1 })),
      results: Object.fromEntries(Object.entries(byCase).map(([tc, v]) => [tc, { reportId: `rep-${id}-${tc}`, status: v, passFailStatus: v }])),
      stats: {},
    });
    const storage = fakeStorage({
      evaluationRuns: {
        base: mk('base', 'baseline', { t1: 'passed', t2: 'passed', t3: 'failed' }),
        cand: mk('cand', 'candidate', { t1: 'passed', t2: 'failed', t3: 'passed' }),
      },
      benchmarks: { b: { id: 'b', name: 'bench', testCaseIds: ['t1', 't2', 't3'], runs: [] } },
    });
    const snap = await buildAskSnapshot(storage, { benchmarkId: 'b', comparisonRunIds: ['base', 'cand', 'missing'] });
    expect(snap.markdown).toContain('| case t2 (t2) | passed | failed |');
    expect(snap.markdown).toMatch(/regressed .*: case t2;/);
    expect(snap.markdown).toMatch(/improved: case t3/);
    expect(snap.markdown).toContain('Comparison runs not found: missing');
    // report ids for the changed cases so the agent can read the judge reasoning
    expect(snap.markdown).toContain('- case t2: baseline → rep-base-t2; candidate → rep-cand-t2');
    expect(snap.markdown).toContain('- case t3: baseline → rep-base-t3; candidate → rep-cand-t3');
    expect(snap.markdown).not.toContain('- case t1:');
    expect(snap.markdown).toContain('/compare/b?runs=base,cand,missing');
  });

  it('legacy benchmark runs (not evaluation-run docs) fall back to their reports', async () => {
    const storage = fakeStorage({
      byExperimentRun: { 'b/run-legacy': [{ id: 'rep1', testCaseId: 't1', passFailStatus: 'passed' }] },
    });
    const snap = await buildAskSnapshot(storage, { benchmarkId: 'b', comparisonRunIds: ['run-legacy'] });
    expect(snap.loaded).toContain('run run-legacy (1 reports)');
    expect(snap.markdown).toContain('| t1 (t1) | passed |');
  });

  it('never throws: a failing lookup becomes a note the agent can act on', async () => {
    const storage = {
      runs: { getById: async () => { throw new Error('cluster down'); } },
      evaluationRuns: { getById: async () => null },
      testCases: { getById: async () => null },
      benchmarks: { getById: async () => null },
    } as unknown as IStorageModule;
    const snap = await buildAskSnapshot(storage, { reportId: 'r', runId: 'x' });
    expect(snap.markdown).toContain('Failed to load: cluster down');
    expect(snap.markdown).toContain('Not found as an evaluation run');
    expect(snap.loaded).toEqual([]);
  });

  it('returns an empty snapshot for id-less pages', async () => {
    const snap = await buildAskSnapshot(fakeStorage({}), {});
    expect(snap.markdown).toBe('');
  });

  it('real-shaped gaps: legacy field names, missing snapshots, unnamed cases, no versions, 3+ compared runs incl. a missing one and an over-cap list', async () => {
    const storage = fakeStorage({
      reports: {
        // an old report: no passFailStatus, judgeModelId instead of judgeModel, non-string trajectory content, object tool output
        'rep-old': { id: 'rep-old', status: 'completed', judgeModelId: 'legacy-judge', trajectory: [{ type: 'tool_result', toolName: 'search', content: { a: 1 }, toolOutput: { rows: 3 }, toolArgs: { q: 'x' } }, { type: 'assistant', content: 'done', toolOutput: 'y'.repeat(900) }] },
      },
      evaluationRuns: {
        // results reference a case the snapshots do not know; a result with status only; a failed one without a reportId
        'run-a': { id: 'run-a', name: 'A', status: 'completed', testCaseSnapshots: [{ id: 'tc-1', name: 'One' }], results: { 'tc-1': { reportId: 'r-a1', passFailStatus: 'passed' }, 'tc-2': { status: 'failed' } } },
        'run-b': { id: 'run-b', name: 'B', status: 'completed', results: { 'tc-1': { reportId: 'r-b1', passFailStatus: 'failed' }, 'tc-3': { reportId: 'r-b3', passFailStatus: 'passed' } } },
        'run-c': { id: 'run-c', status: 'running', results: {} },
      },
      testCases: { 'tc-flat': { id: 'tc-flat', name: 'Flat', initialPrompt: 'legacy prompt', expectedOutcomes: ['legacy outcome'] } },
      benchmarks: { 'bench-x': { id: 'bench-x', name: 'X' } },
    });

    // report with legacy fields → judgeModelId used, verdict falls back to status
    const rep = await buildAskSnapshot(storage, { reportId: 'rep-old' });
    expect(rep.markdown).toContain('### Report rep-old (completed)');
    expect(rep.markdown).toContain('"judgeModel": "legacy-judge"');
    expect(rep.markdown).toContain('"toolOutput": "{\\"rows\\":3}"');
    expect(rep.markdown).toContain('"trajectoryIncluded": "complete"');
    expect(rep.refs).toEqual({ reportId: 'rep-old' }); // nothing to follow

    // evaluation run without snapshots / with a status-only result
    const run = await buildAskSnapshot(storage, { runId: 'run-b' });
    expect(run.markdown).toContain('"tc-1: failed"');
    expect(run.markdown).toContain('"tc-3: passed"');
    expect(run.markdown).toContain('Link: /evaluations/runs/run-b/inspect'); // no benchmark known → the unscoped run route

    // compare: 3 runs + one missing + more than the cap → table, regression (tc-1 passed → failed), unnamed cases, missing note, cap note
    const ids = ['run-a', 'run-b', 'run-c', 'run-missing', 'run-5', 'run-6', 'run-7'];
    const cmp = await buildAskSnapshot(storage, { benchmarkId: 'bench-x', comparisonRunIds: ids });
    expect(cmp.markdown).toContain('### Comparison (3 of 7 runs)');
    expect(cmp.markdown).toContain('| test case | A | B | run-c |');
    expect(cmp.markdown).toContain('| One (tc-1) | passed | failed | — |');
    expect(cmp.markdown).toContain('| tc-2 (tc-2) | failed | — | — |');
    expect(cmp.markdown).toContain('regressed (passed in baseline, failed in a later run): One;');
    expect(cmp.markdown).toContain('improved: none.');
    expect(cmp.markdown).toContain('- One: A → r-a1; B → r-b1; run-c → —');
    expect(cmp.markdown).toContain('- run-c — id run-c, agent ?, stats {}');
    expect(cmp.markdown).toContain('_Comparison runs not found: run-missing, run-5, run-6_');
    expect(cmp.markdown).toContain('_Only the first 6 of 7 compared runs were loaded._');
    expect(cmp.markdown).toContain('### Benchmark bench-x — "X"');
    expect(cmp.markdown).toContain('"testCaseCount": 0');
    expect(cmp.loaded).toEqual(['run run-a', 'run run-b', 'run run-c', 'benchmark bench-x']);

    // two runs whose verdicts are identical → "No verdict changed"; a thrown lookup lands in the missing list
    const same = fakeStorage({ evaluationRuns: { r1: { id: 'r1', results: { t: { passFailStatus: 'passed' } } }, r2: { id: 'r2', results: { t: { passFailStatus: 'passed' } } } } });
    (same.evaluationRuns as any).getById = async (id: string) => { if (id === 'boom') throw new Error('timeout'); return id === 'r1' || id === 'r2' ? { id, results: { t: { passFailStatus: 'passed' } } } : null; };
    const flat = await buildAskSnapshot(same, { comparisonRunIds: ['r1', 'r2', 'boom'] });
    expect(flat.markdown).toContain('No verdict changed between these runs.');
    expect(flat.markdown).not.toContain('Link: /compare'); // no benchmark id → no compare link
    expect(flat.markdown).toContain('_Comparison runs not found: boom (timeout)_');

    // a legacy test case (no versions[]) reads its top-level fields; an unknown benchmark adds no section
    const tc = await buildAskSnapshot(storage, { testCaseId: 'tc-flat', benchmarkId: 'nope' });
    expect(tc.markdown).toContain('"initialPrompt": "legacy prompt"');
    expect(tc.markdown).toContain('"expectedOutcomes": [\n  "legacy outcome"\n ]');
    expect(tc.markdown).not.toContain('### Benchmark');
    expect(tc.loaded).toEqual(['test case tc-flat']);
    const missingTc = await buildAskSnapshot(storage, { testCaseId: 'tc-none' });
    expect(missingTc.markdown).toContain('### Test case tc-none\n_Not found in storage._');

    // every lookup failing → one note per entity, never a throw
    const broken = {
      runs: { getById: async () => { throw new Error('r'); }, getByExperimentRun: async () => { throw new Error('x'); } },
      evaluationRuns: { getById: async () => { throw new Error('e'); } },
      testCases: { getById: async () => { throw new Error('t'); } },
      benchmarks: { getById: async () => { throw new Error('b'); } },
    } as unknown as IStorageModule;
    const all = await buildAskSnapshot(broken, { reportId: 'r', runId: 'e', testCaseId: 't', benchmarkId: 'b', comparisonRunIds: ['c'] });
    expect(all.markdown.match(/Failed to load: [retb]_/g)).toHaveLength(4);
    expect(all.markdown).toContain('_Comparison runs not found: c (e)_');
    expect(all.loaded).toEqual([]);
  });
});

describe('prompt assembly', () => {
  it('system prompt names exactly the read-only tools, tells the model the snapshot is complete, and forbids hash routes', () => {
    const p = buildAskSystemPrompt();
    for (const t of ['get_report(reportId)', 'get_evaluation_run(runId)', 'get_test_case(testCaseId)', 'get_benchmark(benchmarkId)', 'query_spans(']) expect(p).toContain(t);
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('do NOT re-fetch those');
    expect(p).toContain('Never use hash routes');
    expect(p).not.toMatch(/bash|curl|shell/i);
  });

  it('follow-ups on the same page carry no snapshot (pi keeps it in the session context)', () => {
    const p = buildAskUserPrompt({ question: 'And then?', selections: [], page: { route: '/x' }, refs: {}, snapshotMarkdown: '', isFollowUp: true });
    expect(p).toContain('Follow-up: the data snapshot from earlier in this conversation still applies');
    expect(p.trim().endsWith('## Question\nAnd then?')).toBe(true);
  });

  it('user prompt quotes selections, ids, snapshot and the question in order', () => {
    const p = buildAskUserPrompt({
      question: 'Why?',
      selections: [{ text: 'line one\nline two', nearbyText: 'surrounding paragraph with line one' }],
      page: { route: '/compare/b?runs=x,y', title: 'Compare' },
      refs: { benchmarkId: 'b', comparisonRunIds: ['x', 'y'] },
      snapshotMarkdown: '## Data snapshot\nstuff',
    });
    const order = ['## Page', 'benchmarkId=b; comparisonRunIds=x,y', '> line one\n> line two', 'Surrounding text', '## Data snapshot', '## Question\nWhy?'];
    let last = -1;
    for (const needle of order) {
      const i = p.indexOf(needle);
      expect(i).toBeGreaterThan(last);
      last = i;
    }
  });
});
