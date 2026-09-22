/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Precise-first trace correlation (server/services/traceCorrelation.ts).
 *
 * Regression for the "three root spans for one invocation" bug: with
 * concurrency > 1 the service-name window (Strategy C) matched neighbouring
 * runs of the same agent and the server unioned them with the exact
 * traceId/runId matches. The exact clauses must now run FIRST, the window
 * only when they found none of the agent's spans, and window traces that
 * carry Agent Health's own run id for another run must be dropped.
 */

import {
  queryTracesPreciseFirst,
  filterWindowSpans,
  pickDirectStrategy,
  hasDirectCorrelator,
  hasAgentSpans,
  spanRunIds,
} from '@/server/services/traceCorrelation';
import type { TracesQueryOptions } from '@/server/adapters/types';
import type { Span } from '@/types';

const T0 = Date.parse('2026-03-01T10:00:00Z');

function span(over: Partial<Span> & { attributes?: Record<string, unknown> }): Span {
  return {
    traceId: 'trace-default',
    spanId: `s-${Math.random().toString(36).slice(2, 8)}`,
    name: 'chat',
    startTime: new Date(T0).toISOString(),
    endTime: new Date(T0 + 100).toISOString(),
    status: 'OK',
    attributes: { 'service.name': 'retrieval-agent' },
    ...over,
  } as Span;
}

// Run A (the one we ask about) and run B (a concurrent neighbour of the same service).
const A_TRACE = 'aaaa0000aaaa0000aaaa0000aaaa0000';
const B_TRACE = 'bbbb0000bbbb0000bbbb0000bbbb0000';
const A_RUN = 'run-a';
const B_RUN = 'run-b';

const aRoot = span({ traceId: A_TRACE, spanId: 'a-root', attributes: { 'service.name': 'retrieval-agent', 'gen_ai.conversation.id': A_RUN } });
const aChild = span({ traceId: A_TRACE, spanId: 'a-child', parentSpanId: 'a-root', attributes: { 'service.name': 'retrieval-agent', 'agent_health.run.id': A_RUN } });
// Agent Health's own eval span for run A: on the requested trace AND carrying the run id.
const aEval = span({ traceId: A_TRACE, spanId: 'a-eval', name: 'test_case', attributes: { 'service.name': 'agent-health', 'gen_ai.operation.name': 'evaluation', 'agent_health.run.id': A_RUN, 'gen_ai.conversation.id': A_RUN } });
const bRoot = span({ traceId: B_TRACE, spanId: 'b-root', attributes: { 'service.name': 'retrieval-agent', 'agent_health.run.id': B_RUN } });
const bChild = span({ traceId: B_TRACE, spanId: 'b-child', parentSpanId: 'b-root', attributes: { 'service.name': 'retrieval-agent' } });
const untagged = span({ traceId: 'cccc0000cccc0000cccc0000cccc0000', spanId: 'c-untagged', attributes: { 'service.name': 'retrieval-agent' } });
// A third-party agent filling the OTEL-standard ids with ITS OWN thread/session id — not evidence of another run.
const thirdParty = span({ traceId: 'dddd0000dddd0000dddd0000dddd0000', spanId: 'd-thread', attributes: { 'service.name': 'retrieval-agent', 'gen_ai.conversation.id': 'thread-42', 'session.id': 'sess-other' } });
const sessMine = span({ traceId: 'eeee0000eeee0000eeee0000eeee0000', spanId: 'e-sess', attributes: { 'service.name': 'retrieval-agent', 'session.id': 'sess-mine' } });

const WINDOW = [{ serviceName: 'retrieval-agent', startedAt: T0 - 60_000, endedAt: T0 + 60_000 }];

/**
 * A fake backend: `direct` is what the exact clauses would return, `window`
 * what the service-name window would return. Records every call so tests can
 * assert ordering and that the window was (not) consulted.
 */
function fakeBackend(direct: Span[], window: Span[]) {
  const calls: TracesQueryOptions[] = [];
  const query = jest.fn(async (opts: TracesQueryOptions) => {
    calls.push(opts);
    const isWindow = (opts.agents?.length ?? 0) > 0;
    const spans = isWindow ? window : direct;
    return { spans, total: spans.length, nextCursor: null, hasMore: false };
  });
  return { query, calls };
}

describe('traceCorrelation — precise-first', () => {
  describe('hasDirectCorrelator', () => {
    it('is true for traceId / runIds / sessionId and false for window-only or empty', () => {
      expect(hasDirectCorrelator({ traceId: 't' })).toBe(true);
      expect(hasDirectCorrelator({ runIds: ['r'] })).toBe(true);
      expect(hasDirectCorrelator({ sessionId: 's' })).toBe(true);
      expect(hasDirectCorrelator({ runIds: [undefined as any, ''] })).toBe(false);
      expect(hasDirectCorrelator({ agents: WINDOW })).toBe(false);
      expect(hasDirectCorrelator({ startTime: 1 })).toBe(false);
    });
  });

  describe('spanRunIds / hasAgentSpans', () => {
    it('reads both agent_health.run.id and gen_ai.conversation.id', () => {
      expect(spanRunIds(aRoot)).toEqual([A_RUN]);
      expect(spanRunIds(aChild)).toEqual([A_RUN]);
      expect(spanRunIds(span({ attributes: { 'agent_health.run.id': 'x', 'gen_ai.conversation.id': 'y' } }))).toEqual(['x', 'y']);
      expect(spanRunIds(untagged)).toEqual([]);
    });

    it("hasAgentSpans ignores Agent Health's own eval/judge spans", () => {
      expect(hasAgentSpans([aEval])).toBe(false);
      expect(hasAgentSpans([aEval, span({ name: 'test_suite_run demo' , attributes: {} })])).toBe(false);
      expect(hasAgentSpans([aEval, aRoot])).toBe(true);
      expect(hasAgentSpans([])).toBe(false);
    });
  });

  describe('filterWindowSpans (run-identity post-filter)', () => {
    it('drops traces whose agent_health.run.id names another run; keeps untagged traces', () => {
      const { kept, filtered } = filterWindowSpans([aRoot, aChild, bRoot, bChild, untagged], { runIds: [A_RUN] });
      expect(kept.map((s) => s.spanId)).toEqual(['a-root', 'a-child', 'c-untagged']);
      expect(filtered).toBe(2);
    });

    it('resolves identity per TRACE: identity-less children follow a root that names another run', () => {
      // Run B's root carries the id; its HTTP/DB children don't. Judged span by
      // span those children survived as orphans (13 of 72 spans, measured live).
      const bHttp = span({ traceId: B_TRACE, spanId: 'b-http', parentSpanId: 'b-root', attributes: { 'service.name': 'retrieval-agent' } });
      const bDb = span({ traceId: B_TRACE, spanId: 'b-db', parentSpanId: 'b-http', attributes: { 'service.name': 'retrieval-agent', 'db.system.name': 'opensearch' } });
      const { kept, filtered } = filterWindowSpans([bRoot, bHttp, bDb, untagged], { runIds: [A_RUN] });
      expect(kept.map((s) => s.spanId)).toEqual(['c-untagged']);
      expect(filtered).toBe(3);
    });

    it('keeps a whole trace when any of its spans names the requested run', () => {
      const aHttp = span({ traceId: A_TRACE, spanId: 'a-http', parentSpanId: 'a-root', attributes: { 'service.name': 'retrieval-agent' } });
      const { kept } = filterWindowSpans([aChild, aHttp, bRoot], { runIds: [A_RUN] });
      expect(kept.map((s) => s.spanId)).toEqual(['a-child', 'a-http']);
    });

    it('uses ONLY agent_health.run.id as negative evidence — a foreign gen_ai.conversation.id / session.id is not proof of another run', () => {
      const { kept, filtered } = filterWindowSpans([thirdParty, sessMine, untagged], { runIds: [A_RUN] });
      expect(kept.map((s) => s.spanId)).toEqual(['d-thread', 'e-sess', 'c-untagged']);
      expect(filtered).toBe(0);
    });

    it('never compares traceId (window-fallback agents do not propagate W3C context)', () => {
      const foreignTrace = span({ traceId: 'zzzz', spanId: 'z', attributes: { 'service.name': 'retrieval-agent' } });
      expect(filterWindowSpans([foreignTrace], { runIds: [A_RUN] }).kept).toHaveLength(1);
    });

    it('judges a traceId-less span on its own attributes and is a no-op without requested run ids', () => {
      const loose = { ...span({ spanId: 'loose', attributes: { 'agent_health.run.id': B_RUN } }), traceId: undefined } as unknown as Span;
      expect(filterWindowSpans([loose, untagged], { runIds: [A_RUN] }).kept.map((s) => s.spanId)).toEqual(['c-untagged']);
      expect(filterWindowSpans([bRoot, loose], { runIds: [] }).filtered).toBe(0);
    });
  });

  describe('pickDirectStrategy', () => {
    it('labels by precedence traceId > runIds > sessionId based on what the spans actually match', () => {
      expect(pickDirectStrategy([aRoot], { traceId: A_TRACE, runIds: [A_RUN] })).toBe('traceId');
      expect(pickDirectStrategy([aRoot], { traceId: 'nope', runIds: [A_RUN] })).toBe('runIds');
      expect(pickDirectStrategy([sessMine], { traceId: 'nope', runIds: ['nope'], sessionId: 'sess-mine' })).toBe('sessionId');
    });

    it('falls back to the first present correlator when no span is attributable', () => {
      expect(pickDirectStrategy([], { runIds: [A_RUN], sessionId: 's' })).toBe('runIds');
      expect(pickDirectStrategy([], { sessionId: 's' })).toBe('sessionId');
      expect(pickDirectStrategy([], {})).toBe('none');
    });
  });

  describe('queryTracesPreciseFirst', () => {
    it('direct + window: returns ONLY the exact matches and never consults the window when they hold agent spans', async () => {
      // The reporter's shape: trace id matches the run's tree; the window would add run B (more roots).
      const be = fakeBackend([aEval, aRoot, aChild], [aRoot, aChild, bRoot, bChild]);
      const res = await queryTracesPreciseFirst(be.query, { traceId: A_TRACE, runIds: [A_RUN], agents: WINDOW, size: 1000 });

      expect(res.spans.map((s) => s.spanId)).toEqual(['a-eval', 'a-root', 'a-child']);
      expect(res.correlation).toEqual({ strategy: 'traceId', windowFiltered: 0 });
      expect(be.calls).toHaveLength(1);
      // Direct query carries the exact clauses and NO window.
      expect(be.calls[0]).toMatchObject({ traceId: A_TRACE, runIds: [A_RUN], size: 1000 });
      expect(be.calls[0].agents).toBeUndefined();
    });

    it('direct + window: falls back to the window when the exact query is empty, dropping other runs\' traces', async () => {
      const be = fakeBackend([], [untagged, bRoot, bChild, thirdParty]);
      const res = await queryTracesPreciseFirst(be.query, {
        traceId: A_TRACE, runIds: [A_RUN], sessionId: 'sess-mine', agents: WINDOW,
      });

      expect(be.calls).toHaveLength(2);
      expect(be.calls[0].agents).toBeUndefined();               // exact first
      expect(be.calls[1].agents).toEqual(WINDOW);                // then window…
      expect(be.calls[1].traceId).toBeUndefined();               // …without the exact clauses
      expect(be.calls[1].runIds).toBeUndefined();
      expect(be.calls[1].sessionId).toBeUndefined();

      // Run B (our own run id, another run) is dropped; the untagged trace and
      // the third-party-id trace are kept — neither proves it is another run.
      expect(res.spans.map((s) => s.spanId)).toEqual(['c-untagged', 'd-thread']);
      expect(res.correlation).toEqual({ strategy: 'window', windowFiltered: 2 });
      expect(res.total).toBe(2);
    });

    it("an exact result holding ONLY Agent Health's eval span is not a hit: the window still runs and the eval span is kept in front", async () => {
      // A Strategy-C-only agent: the eval `test_case` span sits on the requested
      // trace and carries the run id, so the direct query returns exactly it.
      const be = fakeBackend([aEval], [untagged, bRoot]);
      const res = await queryTracesPreciseFirst(be.query, { traceId: A_TRACE, runIds: [A_RUN], agents: WINDOW });

      expect(be.calls).toHaveLength(2);
      expect(res.spans.map((s) => s.spanId)).toEqual(['a-eval', 'c-untagged']);
      expect(res.correlation).toEqual({ strategy: 'window', windowFiltered: 1 });
      expect(res.total).toBe(2);
    });

    it('eval-only exact result + empty window → returns the eval span labelled by how it was found', async () => {
      const be = fakeBackend([aEval], []);
      const res = await queryTracesPreciseFirst(be.query, { traceId: A_TRACE, runIds: [A_RUN], agents: WINDOW });
      expect(be.calls).toHaveLength(2);
      expect(res.spans.map((s) => s.spanId)).toEqual(['a-eval']);
      expect(res.correlation).toEqual({ strategy: 'traceId', windowFiltered: 0 });
    });

    it('de-duplicates a span present in both the exact and the window result', async () => {
      const be = fakeBackend([aEval], [aEval, untagged]);
      const res = await queryTracesPreciseFirst(be.query, { runIds: [A_RUN], agents: WINDOW });
      expect(res.spans.map((s) => s.spanId)).toEqual(['a-eval', 'c-untagged']);
    });

    it('labels runIds / sessionId matches when there is no traceId hit', async () => {
      const byRun = fakeBackend([aChild], [bRoot]);
      expect((await queryTracesPreciseFirst(byRun.query, { runIds: [A_RUN], agents: WINDOW })).correlation.strategy).toBe('runIds');

      const bySession = fakeBackend([sessMine], [bRoot]);
      expect((await queryTracesPreciseFirst(bySession.query, { sessionId: 'sess-mine', agents: WINDOW })).correlation.strategy).toBe('sessionId');
    });

    it('window-only (no exact correlator): single query, nothing to filter against', async () => {
      const be = fakeBackend([], [sessMine, thirdParty, untagged, bRoot]);
      const res = await queryTracesPreciseFirst(be.query, {
        agents: [{ ...WINDOW[0], sessionId: 'sess-mine' }],
      });
      expect(be.calls).toHaveLength(1);
      expect(res.spans).toHaveLength(4);
      expect(res.correlation).toEqual({ strategy: 'window', windowFiltered: 0 });
    });

    it('direct-only: single query, plain cursor, labelled by the matching strategy', async () => {
      const query = jest.fn(async () => ({ spans: [aRoot], total: 1, nextCursor: 'raw-cursor', hasMore: true }));
      const res = await queryTracesPreciseFirst(query, { traceId: A_TRACE });
      expect(query).toHaveBeenCalledTimes(1);
      expect(res.nextCursor).toBe('raw-cursor');
      expect(res.hasMore).toBe(true);
      expect(res.correlation.strategy).toBe('traceId');
    });

    it('time-range browse (no correlator at all): passes through with strategy none', async () => {
      const query = jest.fn(async () => ({ spans: [untagged], total: 1, nextCursor: null, hasMore: false }));
      const res = await queryTracesPreciseFirst(query, { startTime: T0 - 1, endTime: T0 + 1 });
      expect(query).toHaveBeenCalledWith({ startTime: T0 - 1, endTime: T0 + 1 });
      expect(res.correlation).toEqual({ strategy: 'none', windowFiltered: 0 });
      expect(res.spans).toHaveLength(1);
    });

    it('tolerates backends that omit total/nextCursor/hasMore', async () => {
      const query = jest.fn(async () => ({ spans: [aRoot] } as any));
      const res = await queryTracesPreciseFirst(query, { traceId: A_TRACE, agents: WINDOW });
      expect(res).toMatchObject({ total: 1, nextCursor: null, hasMore: false });
    });

    describe('pagination keeps the phase', () => {
      it('wraps the direct-phase cursor and resumes the DIRECT query without re-running the fallback decision', async () => {
        const query = jest.fn(async (opts: TracesQueryOptions) => ({
          spans: [aRoot], total: 2, nextCursor: opts.cursor ? null : 'direct-c1', hasMore: !opts.cursor,
        }));
        const first = await queryTracesPreciseFirst(query, { traceId: A_TRACE, agents: WINDOW });
        expect(first.nextCursor).not.toBeNull();
        expect(first.nextCursor).not.toBe('direct-c1'); // wrapped

        const second = await queryTracesPreciseFirst(query, { traceId: A_TRACE, agents: WINDOW, cursor: first.nextCursor! });
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[1][0]).toMatchObject({ traceId: A_TRACE, cursor: 'direct-c1' });
        expect(query.mock.calls[1][0].agents).toBeUndefined();
        expect(second.nextCursor).toBeNull();
        expect(second.correlation.strategy).toBe('traceId');
      });

      it('wraps the window-phase cursor and resumes the WINDOW query (skipping the exact query)', async () => {
        const query = jest.fn(async (opts: TracesQueryOptions) => {
          if (!opts.agents) return { spans: [], total: 0, nextCursor: null, hasMore: false };
          return { spans: [untagged, bRoot], total: 4, nextCursor: opts.cursor ? null : 'window-c1', hasMore: !opts.cursor };
        });
        const first = await queryTracesPreciseFirst(query, { runIds: [A_RUN], agents: WINDOW });
        expect(first.correlation.strategy).toBe('window');
        expect(query).toHaveBeenCalledTimes(2);

        const second = await queryTracesPreciseFirst(query, { runIds: [A_RUN], agents: WINDOW, cursor: first.nextCursor! });
        expect(query).toHaveBeenCalledTimes(3); // exactly ONE more call — the window page
        expect(query.mock.calls[2][0]).toMatchObject({ agents: WINDOW, cursor: 'window-c1' });
        expect(query.mock.calls[2][0].runIds).toBeUndefined();
        expect(second.spans.map((s) => s.spanId)).toEqual(['c-untagged']);
        expect(second.correlation).toEqual({ strategy: 'window', windowFiltered: 1 });
      });

      it('treats an unrecognised cursor as a fresh precise-first request', async () => {
        const be = fakeBackend([aRoot], [bRoot]);
        const res = await queryTracesPreciseFirst(be.query, { traceId: A_TRACE, agents: WINDOW, cursor: 'not-json' });
        expect(res.correlation.strategy).toBe('traceId');
        expect(be.calls[0].cursor).toBe('not-json'); // passed through untouched
      });
    });
  });
});
