/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `executeEvaluationRun` as a LEASE HOLDER (#612): it renews its lease on a
 * timer through the sink, obeys a cancel the server echoes back (cancel by
 * lease), and stops — throwing `LeaseLostError`, never finalizing — once a
 * write is refused as lease-lost. Real timers, scaled by a short lease TTL.
 */

import type { EvaluationRun, TestCase } from '@/types';
import type { RunSink, LeaseEcho } from '@/services/runSink';
import { LeaseLostError } from '@/lib/runLease';

const mockRunEvaluation = jest.fn();
jest.mock('@/services/evaluation', () => ({
  runEvaluationWithConnector: (...args: any[]) => mockRunEvaluation(...args),
  callBedrockJudge: jest.fn(),
  judgeErrorDetailFrom: jest.fn(),
  invokeAgent: jest.fn(),
  computeSdkMatcherSessionMetrics: jest.fn(),
  stampObjectiveActuals: jest.fn(),
  appendNotReachedMarker: jest.fn(),
}));
jest.mock('@/services/connectors/server', () => ({ connectorRegistry: {} }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/traces/tracePoller', () => ({ tracePollingManager: { startPolling: jest.fn() } }));

import { executeEvaluationRun, createCancellationToken } from '@/services/evaluationRunner';

const agents = [{ key: 'agent-a', name: 'Agent A', endpoint: 'http://agent.local', headers: {} }] as any;
const models = { 'model-a': { model_id: 'provider.model-a', display_name: 'Model A' } } as any;
const judge = jest.fn() as any;
const traces = { fetchTracesForRun: jest.fn() } as any;
const getEvaluator = jest.fn(async () => null);

/** Lease TTL 3 s → heartbeat every 200 ms (lib/runLease.ts heartbeatIntervalMs). */
const TTL_MS = 3000;
const CASE_MS = 350;

function makeRun(cases: number): EvaluationRun {
  return {
    id: 'run-lease', docType: 'evaluation-run', name: 'lease', createdAt: '2026-01-01T00:00:00Z', status: 'running',
    agentKey: 'agent-a', modelId: 'model-a', sources: [], trigger: 'ui', concurrency: 1,
    testCaseSnapshots: Array.from({ length: cases }, (_, i) => ({ id: `tc-${i + 1}`, version: 1, name: `case ${i + 1}` })),
    results: {},
    executor: { id: 'tok', kind: 'server', version: 't' },
    lease: { generation: 1, heartbeatAt: '2026-01-01T00:00:00Z', ttlMs: TTL_MS },
  } as EvaluationRun;
}
const testCases = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `tc-${i + 1}`, name: `case ${i + 1}`, initialPrompt: 'p', expectedOutcomes: ['ok'], currentVersion: 1 })) as unknown as TestCase[];

interface ScriptedSink extends RunSink { calls: string[]; heartbeats: number }
function scriptedSink(script: { heartbeat?: () => LeaseEcho | Error; setCaseResult?: () => LeaseEcho | Error }): ScriptedSink {
  const docs = new Map<string, any>();
  const sink: ScriptedSink = {
    calls: [], heartbeats: 0,
    async createRun(run) { return { runId: run.id, executorToken: 'tok', lease: run.lease! }; },
    async upsertCaseReport(input) {
      sink.calls.push(`upsert:${input.testCaseId}`);
      const merged = { ...(docs.get(input.reportId) ?? {}), ...input.report, id: input.reportId };
      docs.set(input.reportId, merged);
      return { reportId: input.reportId, report: merged };
    },
    async patchCaseReport() { sink.calls.push('patch'); },
    async setCaseResult(_runId, testCaseId) {
      sink.calls.push(`result:${testCaseId}`);
      const out = script.setCaseResult?.() ?? { generation: 1 };
      if (out instanceof Error) throw out;
      return out;
    },
    async heartbeat() {
      sink.heartbeats++;
      sink.calls.push('heartbeat');
      const out = script.heartbeat?.() ?? { generation: 1 };
      if (out instanceof Error) throw out;
      return out;
    },
    async finalize(runId) { sink.calls.push('finalize'); return { id: runId } as any; },
  };
  return sink;
}

function slowAgent(): void {
  mockRunEvaluation.mockImplementation(async (_a: any, _m: any, tc: any) => {
    await new Promise(r => setTimeout(r, CASE_MS));
    return { id: `rep-${tc.id}`, testCaseId: tc.id, status: 'completed', passFailStatus: 'passed', trajectory: [], metrics: {}, llmJudgeReasoning: 'ok' };
  });
}

describe('executeEvaluationRun holds its lease', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    slowAgent();
  });
  afterEach(() => jest.restoreAllMocks());

  it('heartbeats through the sink at the lease-derived period while cases run, and stops after the run', async () => {
    const sink = scriptedSink({});
    const run = makeRun(3);
    const started = Date.now();
    const result = await executeEvaluationRun(run, testCases(3), { sink, agents, models, judge, traces, getEvaluator, onProgress: jest.fn() });
    const elapsed = Date.now() - started;
    expect(result.status).toBe('completed');
    // ~3 × 350 ms of agent time at a 200 ms beat → a handful of beats, not zero and not one per ms.
    expect(sink.heartbeats).toBeGreaterThanOrEqual(Math.floor(elapsed / 200) - 2);
    expect(sink.heartbeats).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 1);
    const beatsAfter = sink.heartbeats;
    await new Promise(r => setTimeout(r, 500));
    expect(sink.heartbeats).toBe(beatsAfter);
    expect(sink.calls).not.toContain('finalize'); // finalize is the caller's (route's) write
  });

  it('a cancel echoed by the server (cancelRequestedAt) cancels the run: no new cases start, status cancelled with markers', async () => {
    let echoCancel = false;
    const sink = scriptedSink({ heartbeat: () => (echoCancel ? { generation: 1, cancelRequestedAt: '2026-01-01T00:00:05Z' } : { generation: 1 }) });
    const cancellationToken = createCancellationToken();
    // The "UI cancel" lands after the first case is under way.
    setTimeout(() => { echoCancel = true; }, 150);

    const result = await executeEvaluationRun(makeRun(5), testCases(5), { sink, agents, models, judge, traces, getEvaluator, cancellationToken, onProgress: jest.fn() });

    expect(cancellationToken.isCancelled).toBe(true);
    expect(result.status).toBe('cancelled');
    const started = sink.calls.filter(c => c.startsWith('upsert:')).map(c => c.split(':')[1]);
    expect(new Set(started).size).toBeLessThan(5);
    expect(new Set(started).size).toBeGreaterThanOrEqual(1);
    // Never-started cases carry explicit cancelled markers; started ones completed.
    for (let i = 1; i <= 5; i++) {
      const entry = result.results[`tc-${i}`];
      expect(entry.status).toBe(started.includes(`tc-${i}`) ? 'completed' : 'cancelled');
    }
    expect(result.stats).toMatchObject({ notRun: 5 - new Set(started).size, total: 5 });
  });

  it('a cancel echoed on a case-result write is honoured too (no need to wait for the next beat)', async () => {
    const sink = scriptedSink({ setCaseResult: () => ({ generation: 1, cancelRequestedAt: '2026-01-01T00:00:05Z' }) });
    const cancellationToken = createCancellationToken();
    const result = await executeEvaluationRun(makeRun(4), testCases(4), { sink, agents, models, judge, traces, getEvaluator, cancellationToken, onProgress: jest.fn() });
    expect(cancellationToken.isCancelled).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(sink.calls.filter(c => c.startsWith('upsert:')).map(c => c.split(':')[1])).toEqual(['tc-1', 'tc-1']);
    expect(result.results['tc-2']).toEqual({ reportId: '', status: 'cancelled' });
  });

  it('a lease-lost refusal (swept by the server) stops the executor: no further cases, LeaseLostError thrown, nothing finalized', async () => {
    const lost = new LeaseLostError({ error: 'lease-lost', runId: 'run-lease', generation: 2, at: '2026-01-01T00:06:00Z', status: 'failed' });
    let beats = 0;
    const sink = scriptedSink({ heartbeat: () => (++beats >= 2 ? lost : { generation: 1 }) });
    const cancellationToken = createCancellationToken();

    await expect(executeEvaluationRun(makeRun(6), testCases(6), { sink, agents, models, judge, traces, getEvaluator, cancellationToken, onProgress: jest.fn() }))
      .rejects.toMatchObject({ name: 'LeaseLostError', info: { generation: 2, status: 'failed' } });

    expect(cancellationToken.isCancelled).toBe(true);
    const started = new Set(sink.calls.filter(c => c.startsWith('upsert:')).map(c => c.split(':')[1]));
    expect(started.size).toBeLessThan(6);
    expect(sink.calls).not.toContain('finalize');
    // The heartbeat timer stopped at the refusal: no more beats afterwards.
    const beatsAtThrow = sink.heartbeats;
    await new Promise(r => setTimeout(r, 500));
    expect(sink.heartbeats).toBe(beatsAtThrow);
  });

  it('a lease-lost refusal on a case-result write is treated the same way', async () => {
    const lost = new LeaseLostError({ error: 'lease-lost', runId: 'run-lease', generation: 2, at: 'T', status: 'failed' });
    const sink = scriptedSink({ setCaseResult: () => lost });
    await expect(executeEvaluationRun(makeRun(3), testCases(3), { sink, agents, models, judge, traces, getEvaluator, cancellationToken: createCancellationToken(), onProgress: jest.fn() }))
      .rejects.toBeInstanceOf(LeaseLostError);
    expect(sink.calls.filter(c => c.startsWith('result:'))).toEqual(['result:tc-1']);
  });
});
