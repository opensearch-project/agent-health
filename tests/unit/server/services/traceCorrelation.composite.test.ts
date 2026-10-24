/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Precise-first correlation over the COMPOSITE observability backend (an
 * OpenSearch-type source + a CloudWatch-type source read side by side).
 *
 * `queryTracesPreciseFirst` wraps `obs.traces.query`, so the route's
 * behaviour is the same whichever module answers — but the composite adds two
 * things the single-backend tests cannot see: spans tagged with their source,
 * and partial-result flags (`truncated`, per-source `warnings`) that the
 * route turns into a user-visible warning. Both must survive the wrapper.
 *
 * Each fake source filters its spans with the SAME in-memory matcher the
 * file and CloudWatch backends use (traceQueryMatch.ts), so the direct and
 * window phases return exactly what those backends would.
 */

import { CompositeObservabilityModule, type NamedSource } from '@/server/adapters/observability/CompositeObservabilityModule';
import { computeUseUnion, matchesQuery } from '@/server/adapters/observability/traceQueryMatch';
import { queryTracesPreciseFirst } from '@/server/services/traceCorrelation';
import type { IObservabilityModule, TracesQueryOptions } from '@/server/adapters/types';
import type { Span } from '@/types';

const T0 = Date.parse('2026-03-01T10:00:00Z');
const SERVICE = 'retrieval-agent';
const A_TRACE = 'aaaa0000aaaa0000aaaa0000aaaa0000';
const B_TRACE = 'bbbb0000bbbb0000bbbb0000bbbb0000';
const A_RUN = 'run-a';
const B_RUN = 'run-b-neighbour';

function span(traceId: string, spanId: string, offsetS: number, attributes: Record<string, unknown>, name = 'chat'): Span {
  return {
    traceId,
    spanId,
    name,
    startTime: new Date(T0 + offsetS * 1000).toISOString(),
    endTime: new Date(T0 + offsetS * 1000 + 100).toISOString(),
    status: 'OK',
    attributes: { 'service.name': SERVICE, ...attributes },
  } as Span;
}

// Run A's own spans: the OpenSearch source holds the agent root (tagged with
// the run id) + an untagged child; the CloudWatch source holds a Lambda-side
// child of the same trace (W3C-propagated, no run id).
const aRoot = span(A_TRACE, 'a-root', 1, { 'agent_health.run.id': A_RUN, 'gen_ai.conversation.id': A_RUN });
const aChildOs = span(A_TRACE, 'a-child-os', 2, {});
const aChildCw = span(A_TRACE, 'a-child-cw', 3, {});
// Agent Health's own eval span for run A.
const aEval = span(A_TRACE, 'a-eval', 0, { 'service.name': 'agent-health', 'gen_ai.operation.name': 'evaluation', 'agent_health.run.id': A_RUN }, 'test_case');
// A concurrent neighbour of the same service, inside the window, on both sources.
const bRootOs = span(B_TRACE, 'b-root', 1, { 'agent_health.run.id': B_RUN });
const bChildCw = span(B_TRACE, 'b-child-cw', 2, {});

const WINDOW = [{ serviceName: SERVICE, startedAt: T0 - 60_000, endedAt: T0 + 60_000 }];

/** A fake source that answers like the file/CloudWatch backends: candidate set filtered by the shared matcher. */
function fakeSource(
  name: string,
  type: 'opensearch' | 'cloudwatch',
  spans: Span[],
  opts: { fail?: boolean; truncated?: boolean } = {}
): NamedSource & { calls: TracesQueryOptions[] } {
  const calls: TracesQueryOptions[] = [];
  const module: IObservabilityModule = {
    traces: {
      query: async (options) => {
        calls.push(options);
        if (opts.fail) throw new Error(`${name} is down`);
        const useUnion = computeUseUnion(options);
        const matched = spans.filter((s) => matchesQuery(s, options, useUnion));
        return { spans: matched, total: matched.length, hasMore: false, nextCursor: null, truncated: opts.truncated };
      },
      getByTraceId: async () => spans,
      getByRunIds: async () => spans,
    },
    logs: { query: async () => ({ logs: [], total: 0 }) },
    metrics: {
      forRun: async () => { throw new Error('not used'); },
      forRuns: async () => { throw new Error('not used'); },
    },
    health: async () => ({ status: 'ok' }),
    isConfigured: () => true,
    describe: () => ({ type, target: `${name}-target` }),
  };
  return { id: name, name, module, calls };
}

describe('precise-first correlation over the composite backend (OpenSearch + CloudWatch sources)', () => {
  it('Traces-tab query (runId + window): only run A\'s spans from BOTH sources, matched by run id; the window is never consulted', async () => {
    const os = fakeSource('mine', 'opensearch', [aRoot, aChildOs, aEval, bRootOs]);
    const cw = fakeSource('cw-team', 'cloudwatch', [aChildCw, bChildCw]);
    const composite = new CompositeObservabilityModule([os, cw]);

    const result = await queryTracesPreciseFirst((o) => composite.traces.query(o), {
      runIds: [A_RUN],
      agents: WINDOW,
    });

    expect(result.correlation).toEqual({ strategy: 'runIds', windowFiltered: 0 });
    // Strategy B alone finds the tagged root on the OpenSearch source. The
    // W3C-only children would need the traceId (Strategy A) — covered below.
    expect(result.spans.map((s) => s.spanId).sort()).toEqual(['a-eval', 'a-root']);
    expect(result.spans.some((s) => s.traceId === B_TRACE)).toBe(false);
    // One query per source, none carrying the window hint.
    expect(os.calls).toHaveLength(1);
    expect(cw.calls).toHaveLength(1);
    expect(os.calls[0].agents).toBeUndefined();
    expect(cw.calls[0].agents).toBeUndefined();
    expect(os.calls[0].runIds).toEqual([A_RUN]);
  });

  it('traceId + runId + window: the whole W3C trace across both sources, each span tagged with its source, no neighbour spans', async () => {
    const os = fakeSource('mine', 'opensearch', [aRoot, aChildOs, aEval, bRootOs]);
    const cw = fakeSource('cw-team', 'cloudwatch', [aChildCw, bChildCw]);
    const composite = new CompositeObservabilityModule([os, cw]);

    const result = await queryTracesPreciseFirst((o) => composite.traces.query(o), {
      traceId: A_TRACE,
      runIds: [A_RUN],
      agents: WINDOW,
    });

    expect(result.correlation.strategy).toBe('traceId');
    expect(result.spans.map((s) => s.spanId).sort()).toEqual(['a-child-cw', 'a-child-os', 'a-eval', 'a-root']);
    const bySource = Object.fromEntries(result.spans.map((s) => [s.spanId, s.attributes!['agent_health.source']]));
    expect(bySource).toEqual({ 'a-root': 'mine', 'a-child-os': 'mine', 'a-eval': 'mine', 'a-child-cw': 'cw-team' });
    expect(result.spans.filter((s) => s.traceId === B_TRACE)).toHaveLength(0);
    expect(result.truncated).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it('falls back to the window when the exact ids match nothing, drops the neighbour\'s trace on every source, and keeps untagged traces', async () => {
    const untaggedOs = span('cccc0000cccc0000cccc0000cccc0000', 'c-untagged-os', 1, {});
    const untaggedCw = span('dddd0000dddd0000dddd0000dddd0000', 'd-untagged-cw', 2, {});
    const os = fakeSource('mine', 'opensearch', [bRootOs, untaggedOs]);
    const cw = fakeSource('cw-team', 'cloudwatch', [bChildCw, untaggedCw]);
    const composite = new CompositeObservabilityModule([os, cw]);

    const result = await queryTracesPreciseFirst((o) => composite.traces.query(o), {
      runIds: ['run-nobody-tagged'],
      agents: WINDOW,
    });

    expect(result.correlation.strategy).toBe('window');
    // b-root (names run B) and its identity-less CloudWatch child go together.
    expect(result.correlation.windowFiltered).toBe(2);
    expect(result.spans.map((s) => s.spanId).sort()).toEqual(['c-untagged-os', 'd-untagged-cw']);
    // Direct phase first (no agents), then the window phase (no runIds) — on each source.
    expect(os.calls.map((c) => [c.agents === undefined, c.runIds === undefined])).toEqual([[true, false], [false, true]]);
    expect(cw.calls.map((c) => [c.agents === undefined, c.runIds === undefined])).toEqual([[true, false], [false, true]]);
  });

  it('carries the composite\'s partial-result flags through: a failed source is named and a capped scan is flagged', async () => {
    const os = fakeSource('mine', 'opensearch', [], { fail: true });
    const cw = fakeSource('cw-team', 'cloudwatch', [aRoot], { truncated: true });
    const composite = new CompositeObservabilityModule([os, cw]);

    const result = await queryTracesPreciseFirst((o) => composite.traces.query(o), {
      runIds: [A_RUN],
      agents: WINDOW,
    });

    expect(result.correlation.strategy).toBe('runIds');
    expect(result.spans.map((s) => s.spanId)).toEqual(['a-root']);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual([{ source: 'mine', message: 'mine is down' }]);
  });

  it('unions the flags of both phases when the eval-only exact result forces the window to run', async () => {
    const os = fakeSource('mine', 'opensearch', [aEval], { truncated: true });
    // The agent emits none of A/B/D; only its CloudWatch spans inside the window exist.
    const strategyCOnly = span('ffff0000ffff0000ffff0000ffff0000', 'f-agent', 1, {});
    const cw = fakeSource('cw-team', 'cloudwatch', [strategyCOnly]);
    const composite = new CompositeObservabilityModule([os, cw]);

    const result = await queryTracesPreciseFirst((o) => composite.traces.query(o), {
      runIds: [A_RUN],
      agents: WINDOW,
    });

    expect(result.correlation.strategy).toBe('window');
    expect(result.spans.map((s) => s.spanId)).toEqual(['a-eval', 'f-agent']);
    expect(result.truncated).toBe(true);
  });
});
