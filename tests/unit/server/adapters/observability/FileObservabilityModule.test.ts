/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileObservabilityModule, matchesQuery, computeUseUnion } from '@/server/adapters/observability/FileObservabilityModule';
import type { Span } from '@/types';

function span(over: Partial<Span> & { startMs?: number }): Span {
  const startMs = over.startMs ?? Date.parse('2024-01-01T00:00:00Z');
  return {
    traceId: 't1',
    spanId: 's1',
    name: 'span',
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(startMs + 100).toISOString(),
    status: 'OK',
    attributes: {},
    ...over,
  };
}

describe('FileObservabilityModule', () => {
  let dir: string;
  let mod: FileObservabilityModule;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fileobs-'));
    mod = new FileObservabilityModule(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is always configured and healthy', async () => {
    expect(mod.isConfigured()).toBe(true);
    expect((await mod.health()).status).toBe('ok');
  });

  it('ingests spans and reads them back by traceId', async () => {
    await mod.ingest([span({ traceId: 'tX', spanId: 's1' }), span({ traceId: 'tX', spanId: 's2' })]);
    const spans = await mod.traces.getByTraceId('tX');
    expect(spans).toHaveLength(2);
  });

  it('throws when no filter and no time range provided', async () => {
    await expect(mod.traces.query({})).rejects.toThrow(/traceId, runIds, sessionId, agents, or time range/);
  });

  describe('correlation semantics', () => {
    beforeEach(async () => {
      await mod.ingest([
        // Strategy A: traceId
        span({ traceId: 'trace-A', spanId: 'a1', attributes: { 'service.name': 'svc1' } }),
        // Strategy B: agent_health.run.id == runId
        span({ traceId: 'trace-B', spanId: 'b1', attributes: { 'agent_health.run.id': 'run-1', 'service.name': 'svc2' } }),
        // Strategy C: service.name within window
        span({ traceId: 'trace-C', spanId: 'c1', startMs: Date.parse('2024-06-01T12:00:00Z'), attributes: { 'service.name': 'svc3' } }),
        // session
        span({ traceId: 'trace-D', spanId: 'd1', attributes: { 'session.id': 'sess-9', 'service.name': 'svc4' } }),
        // Strategy B': OTEL-standard gen_ai.conversation.id == runId (#313)
        span({ traceId: 'trace-E', spanId: 'e1', attributes: { 'gen_ai.conversation.id': 'run-conv', 'service.name': 'svc5' } }),
      ]);
    });

    it('A: matches by traceId', async () => {
      const r = await mod.traces.query({ traceId: 'trace-A' });
      expect(r.spans.map((s) => s.spanId)).toEqual(['a1']);
    });

    it('B: matches by runId (agent_health.run.id)', async () => {
      const r = await mod.traces.query({ runIds: ['run-1'] });
      expect(r.spans.map((s) => s.spanId)).toEqual(['b1']);
    });

    it('B: getByRunIds short-circuits on empty list', async () => {
      expect(await mod.traces.getByRunIds([])).toEqual([]);
    });

    it('C: matches by serviceName + time window', async () => {
      const r = await mod.traces.query({
        agents: [{ serviceName: 'svc3', startedAt: Date.parse('2024-06-01T11:00:00Z'), endedAt: Date.parse('2024-06-01T13:00:00Z') }],
      });
      expect(r.spans.map((s) => s.spanId)).toEqual(['c1']);
    });

    it('C: excludes spans outside the time window', async () => {
      const r = await mod.traces.query({
        agents: [{ serviceName: 'svc3', startedAt: Date.parse('2024-06-02T00:00:00Z'), endedAt: Date.parse('2024-06-03T00:00:00Z') }],
      });
      expect(r.spans).toHaveLength(0);
    });

    it('matches by sessionId (must-filter)', async () => {
      const r = await mod.traces.query({ sessionId: 'sess-9' });
      expect(r.spans.map((s) => s.spanId)).toEqual(['d1']);
    });

    it('matches runIds directly against session.id for run-scoped local evidence', async () => {
      const r = await mod.traces.query({ runIds: ['sess-9'] });
      expect(r.spans.map((s) => s.spanId)).toEqual(['d1']);
    });

    it("B': matches by OTEL-standard gen_ai.conversation.id == runId (#313)", async () => {
      const r = await mod.traces.query({ runIds: ['run-conv'] });
      expect(r.spans.map((s) => s.spanId)).toEqual(['e1']);
    });

    it('D: matches by agents[].sessionId on attributes.session.id (#313)', async () => {
      // No service/window match (svc4 not given, window excludes it) — only the
      // sessionId clause can pull span d1.
      const r = await mod.traces.query({
        agents: [{ serviceName: 'nope', startedAt: 0, endedAt: 1, sessionId: 'sess-9' }],
      });
      expect(r.spans.map((s) => s.spanId)).toEqual(['d1']);
    });

    it('unions traceId + runId (A OR B) when 2+ correlation clauses', async () => {
      expect(computeUseUnion({ traceId: 'trace-A', runIds: ['run-1'] })).toBe(true);
      const r = await mod.traces.query({ traceId: 'trace-A', runIds: ['run-1'] });
      expect(r.spans.map((s) => s.spanId).sort()).toEqual(['a1', 'b1']);
    });

    it('serviceName must-filter narrows results', async () => {
      const r = await mod.traces.query({ traceId: 'trace-A', serviceName: 'wrong' });
      expect(r.spans).toHaveLength(0);
    });
  });

  describe('matchesQuery (pure)', () => {
    it('pure time-range browse matches on must-filters alone (no correlation)', () => {
      const s = span({ startMs: Date.parse('2024-03-01T00:00:00Z') });
      expect(matchesQuery(s, { startTime: Date.parse('2024-02-01T00:00:00Z'), endTime: Date.parse('2024-04-01T00:00:00Z') }, false)).toBe(true);
      expect(matchesQuery(s, { startTime: Date.parse('2024-03-15T00:00:00Z') }, false)).toBe(false);
    });

    it('textSearch matches span name or attribute values', () => {
      const s = span({ name: 'invoke weather agent', attributes: { 'gen_ai.system': 'bedrock' } });
      expect(matchesQuery(s, { startTime: 0, textSearch: 'weather' }, false)).toBe(true);
      expect(matchesQuery(s, { startTime: 0, textSearch: 'bedrock' }, false)).toBe(true);
      expect(matchesQuery(s, { startTime: 0, textSearch: 'nope' }, false)).toBe(false);
    });

    it('treats startTime/endTime of 0 as real epoch bounds (not "absent")', () => {
      const s = span({ startMs: Date.parse('2024-03-01T00:00:00Z') });
      expect(matchesQuery(s, { startTime: 0 }, false)).toBe(true); // 0 = from epoch, includes it
      expect(matchesQuery(s, { endTime: 0 }, false)).toBe(false);   // up to epoch 1970, excludes 2024
    });
  });

  describe('pagination', () => {
    beforeEach(async () => {
      const spans: Span[] = [];
      for (let i = 0; i < 5; i++) {
        spans.push(span({ traceId: 'tP', spanId: `p${i}`, startMs: Date.parse('2024-01-01T00:00:00Z') + i * 1000, attributes: { 'service.name': 'svc' } }));
      }
      await mod.ingest(spans);
    });

    it('sorts newest-first, paginates via cursor, and reports hasMore', async () => {
      const page1 = await mod.traces.query({ traceId: 'tP', size: 2 });
      expect(page1.spans.map((s) => s.spanId)).toEqual(['p4', 'p3']);
      expect(page1.hasMore).toBe(true);
      expect(page1.total).toBe(5);

      const page2 = await mod.traces.query({ traceId: 'tP', size: 2, cursor: page1.nextCursor! });
      expect(page2.spans.map((s) => s.spanId)).toEqual(['p2', 'p1']);
      expect(page2.hasMore).toBe(true);

      const page3 = await mod.traces.query({ traceId: 'tP', size: 2, cursor: page2.nextCursor! });
      expect(page3.spans.map((s) => s.spanId)).toEqual(['p0']);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
    });
  });

  it('logs.query returns empty (file logs backend is a future addition)', async () => {
    expect(await mod.logs.query({ runId: 'r' })).toEqual({ logs: [], total: 0 });
  });
});
