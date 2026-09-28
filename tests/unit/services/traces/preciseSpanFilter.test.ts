/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Span } from '@/types';
import {
  filterSpansByPreciseCorrelators,
  spanMatchesRunId,
  strictCorrelators,
} from '@/services/traces/preciseSpanFilter';

const EVAL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER = '0f0e0d0c0b0a09080706050403020100';

const span = (over: Partial<Span> = {}): Span => ({
  traceId: OTHER, spanId: 's', name: 'sp', startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-01T00:00:01Z', duration: 1000, status: 'OK', attributes: {},
  ...over,
});

describe('services/traces/preciseSpanFilter', () => {
  describe('strictCorrelators', () => {
    it('session.id and a valid W3C traceId are strict; runId is not', () => {
      expect(strictCorrelators({ sessionId: 'sess', evalTraceId: EVAL, runId: 'run-1' })).toEqual(['sessionId', 'traceId']);
      expect(strictCorrelators({ runId: 'run-1' })).toEqual([]);
    });

    it('ignores a non-W3C traceId (mis-stamped connector id) and empty strings', () => {
      expect(strictCorrelators({ evalTraceId: 'conv-33c29f9d5b8a' })).toEqual([]);
      expect(strictCorrelators({ sessionId: '', evalTraceId: '' })).toEqual([]);
      expect(strictCorrelators({ sessionId: null, evalTraceId: null })).toEqual([]);
    });
  });

  describe('spanMatchesRunId', () => {
    it('matches agent_health.run.id or the OTEL-standard gen_ai.conversation.id', () => {
      expect(spanMatchesRunId(span({ attributes: { 'agent_health.run.id': 'r1' } }), 'r1')).toBe(true);
      expect(spanMatchesRunId(span({ attributes: { 'gen_ai.conversation.id': 'r1' } }), 'r1')).toBe(true);
      expect(spanMatchesRunId(span({ attributes: { 'gen_ai.conversation.id': 'r2' } }), 'r1')).toBe(false);
      expect(spanMatchesRunId(span({ attributes: undefined }), 'r1')).toBe(false);
    });
  });

  describe('filterSpansByPreciseCorrelators', () => {
    it('keeps everything when the report has no strict correlator (window-only correlation)', () => {
      const spans = [span({ spanId: 'a' }), span({ spanId: 'b' })];
      expect(filterSpansByPreciseCorrelators(spans, { runId: 'run-1' })).toEqual({ spans, strict: [] });
      expect(filterSpansByPreciseCorrelators(spans, {}).spans).toHaveLength(2);
    });

    it('with a strict traceId keeps only that trace', () => {
      const mine = span({ spanId: 'mine', traceId: EVAL });
      const foreign = span({ spanId: 'foreign', traceId: OTHER });
      const out = filterSpansByPreciseCorrelators([mine, foreign], { evalTraceId: EVAL });
      expect(out.strict).toEqual(['traceId']);
      expect(out.spans.map(s => s.spanId)).toEqual(['mine']);
    });

    it('traceId comparison is case-insensitive', () => {
      const mine = span({ spanId: 'mine', traceId: EVAL.toUpperCase() });
      expect(filterSpansByPreciseCorrelators([mine], { evalTraceId: EVAL }).spans).toHaveLength(1);
    });

    it('with a strict sessionId keeps only that session', () => {
      const mine = span({ spanId: 'mine', attributes: { 'session.id': 'sess-1' } });
      const foreign = span({ spanId: 'foreign', attributes: { 'session.id': 'sess-2' } });
      const out = filterSpansByPreciseCorrelators([mine, foreign], { sessionId: 'sess-1' });
      expect(out.spans.map(s => s.spanId)).toEqual(['mine']);
    });

    it('a span matching ANY strict correlator is kept (session OR trace)', () => {
      const bySession = span({ spanId: 'by-session', attributes: { 'session.id': 'sess-1' } });
      const byTrace = span({ spanId: 'by-trace', traceId: EVAL });
      const foreign = span({ spanId: 'foreign' });
      const out = filterSpansByPreciseCorrelators([bySession, byTrace, foreign], { sessionId: 'sess-1', evalTraceId: EVAL });
      expect(out.spans.map(s => s.spanId).sort()).toEqual(['by-session', 'by-trace']);
    });

    it('runId is positive evidence: spans carrying it survive a strict filter they would otherwise fail', () => {
      const viaRunId = span({ spanId: 'via-run-id', attributes: { 'gen_ai.conversation.id': 'run-1' } });
      const foreign = span({ spanId: 'foreign', attributes: { 'gen_ai.conversation.id': 'run-2' } });
      const out = filterSpansByPreciseCorrelators([viaRunId, foreign], { evalTraceId: EVAL, runId: 'run-1' });
      expect(out.spans.map(s => s.spanId)).toEqual(['via-run-id']);
    });

    it('a non-W3C traceId never black-holes spans (the legacy /execute regression)', () => {
      // report.traceId === report.runId === 'conv-…' — spans found via Strategy B must be judged.
      const found = span({ spanId: 'found', attributes: { 'gen_ai.conversation.id': 'conv-33c29f9d5b8a' } });
      const out = filterSpansByPreciseCorrelators([found], { evalTraceId: 'conv-33c29f9d5b8a', runId: 'conv-33c29f9d5b8a' });
      expect(out.strict).toEqual([]);
      expect(out.spans).toHaveLength(1);
    });
  });
});
