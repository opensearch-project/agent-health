/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CompositeObservabilityModule, type NamedSource } from '@/server/adapters/observability/CompositeObservabilityModule';
import type { IObservabilityModule } from '@/server/adapters/types';
import type { Span, MetricsResult } from '@/types';

const T0 = Date.parse('2026-03-01T10:00:00Z');
function span(id: string, offsetS: number, extra: Partial<Span> = {}): Span {
  return { traceId: 't1', spanId: id, name: `span ${id}`, startTime: new Date(T0 + offsetS * 1000).toISOString(), endTime: new Date(T0 + offsetS * 1000 + 100).toISOString(), status: 'OK', attributes: {}, ...extra };
}
function metrics(runId: string, over: Partial<MetricsResult> = {}): MetricsResult {
  return { runId, traceId: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'pending', hasSpans: false, ...over };
}

/** A fake backend with scripted answers. */
function fake(name: string, opts: { spans?: Span[]; logs?: any[]; metrics?: Record<string, MetricsResult>; fail?: boolean; truncated?: boolean; metricsFail?: boolean; health?: 'ok' | 'error' } = {}): NamedSource {
  const module: IObservabilityModule = {
    traces: {
      query: async () => { if (opts.fail) throw new Error(`${name} is down`); return { spans: opts.spans ?? [], total: (opts.spans ?? []).length, hasMore: false, nextCursor: null, truncated: opts.truncated }; },
      getByTraceId: async () => opts.spans ?? [],
      getByRunIds: async () => opts.spans ?? [],
    },
    logs: { query: async () => { if (opts.fail) throw new Error(`${name} is down`); return { logs: opts.logs ?? [], total: (opts.logs ?? []).length }; } },
    metrics: {
      forRun: async (id) => { if (opts.metricsFail) throw new Error(`${name} throttled`); return opts.metrics?.[id] ?? metrics(id); },
      forRuns: async (ids) => { if (opts.metricsFail) throw new Error(`${name} throttled`); return ids.map((id) => opts.metrics?.[id] ?? metrics(id)); },
    },
    health: async () => (opts.health === 'error' ? { status: 'error', error: 'boom' } : { status: 'ok', index: `${name}-index` }),
    isConfigured: () => true,
    describe: () => ({ type: name.startsWith('cw') ? 'cloudwatch' : 'opensearch', target: `${name}-index` }),
  };
  return { id: name, name, module };
}

describe('CompositeObservabilityModule', () => {
  describe('traces', () => {
    it('merges spans from every source, tags each with its source, newest first, offset-paged', async () => {
      const c = new CompositeObservabilityModule([
        fake('mine', { spans: [span('a', 1), span('b', 3)] }),
        fake('cw-team', { spans: [span('c', 2)] }),
      ]);
      const r = await c.traces.query({ traceId: 't1', size: 2 });
      expect(r.total).toBe(3);
      expect(r.spans.map((s) => [s.spanId, s.attributes!['agent_health.source'], s.attributes!['agent_health.source.type']])).toEqual([['b', 'mine', 'opensearch'], ['c', 'cw-team', 'cloudwatch']]);
      expect(r.hasMore).toBe(true);
      const r2 = await c.traces.query({ traceId: 't1', size: 2, cursor: r.nextCursor! });
      expect(r2.spans.map((s) => s.spanId)).toEqual(['a']);
    });

    it('dedupes a span that was shipped to both sources — the first configured source wins the tag', async () => {
      const c = new CompositeObservabilityModule([
        fake('mine', { spans: [span('dup', 1, { attributes: { from: 'mine' } })] }),
        fake('cw-team', { spans: [span('dup', 1, { attributes: { from: 'cw' } })] }),
      ]);
      const r = await c.traces.query({ traceId: 't1' });
      expect(r.total).toBe(1);
      expect(r.spans[0].attributes).toMatchObject({ from: 'mine', 'agent_health.source': 'mine' });
    });

    it('a failing source is reported by name while the others still answer; truncation propagates', async () => {
      const c = new CompositeObservabilityModule([
        fake('mine', { fail: true }),
        fake('cw-team', { spans: [span('c', 2)], truncated: true }),
      ]);
      const r = await c.traces.query({ traceId: 't1' });
      expect(r.spans).toHaveLength(1);
      expect(r.truncated).toBe(true);
      expect(r.warnings).toEqual([{ source: 'mine', message: 'mine is down' }]);
    });
  });

  describe('logs', () => {
    it('merges and tags log records, newest first, with per-source warnings', async () => {
      const c = new CompositeObservabilityModule([
        fake('mine', { logs: [{ timestamp: new Date(T0 + 1000).toISOString(), message: 'old', index: 'x' }] }),
        fake('cw-team', { logs: [{ timestamp: new Date(T0 + 5000).toISOString(), message: 'new', index: 'g' }] }),
        fake('broken', { fail: true }),
      ]);
      const r = await c.logs.query({ traceId: 'abc' });
      expect(r.logs.map((l) => [l.message, (l as any)['agent_health.source']])).toEqual([['new', 'cw-team'], ['old', 'mine']]);
      expect(r.warnings).toEqual([{ source: 'broken', message: 'broken is down' }]);
    });
  });

  describe('metrics (never summed across sources)', () => {
    it('takes the first source in configured order that holds the run\'s spans — a dual-shipping agent is not double-counted', async () => {
      const m = metrics('r1', { inputTokens: 100, totalTokens: 110, llmCalls: 2, status: 'success', hasSpans: true });
      const c = new CompositeObservabilityModule([fake('mine', { metrics: { r1: m } }), fake('cw-team', { metrics: { r1: { ...m, inputTokens: 100 } } })]);
      const [r] = await c.metrics.forRuns(['r1']);
      expect(r).toMatchObject({ runId: 'r1', inputTokens: 100, llmCalls: 2, source: 'mine' });
    });

    it('a complete result beats a partial one from an earlier source; a zero-counter result with hasSpans:true still counts as holding the run', async () => {
      const partial = metrics('r1', { inputTokens: 5, totalTokens: 5, llmCalls: 1, status: 'success', hasSpans: true, partial: true });
      const complete = metrics('r1', { inputTokens: 100, totalTokens: 110, llmCalls: 2, status: 'success', hasSpans: true });
      const c = new CompositeObservabilityModule([fake('mine', { metrics: { r1: partial } }), fake('cw-team', { metrics: { r1: complete } })]);
      expect(await c.metrics.forRun('r1')).toMatchObject({ inputTokens: 100, source: 'cw-team' });
      const zero = metrics('r1', { status: 'success', hasSpans: true }); // spans present, nothing to count (e.g. only tool spans without tokens or duration)
      const c2 = new CompositeObservabilityModule([fake('mine', { metrics: { r1: zero } }), fake('cw-team', { metrics: { r1: complete } })]);
      expect(await c2.metrics.forRun('r1')).toMatchObject({ inputTokens: 0, source: 'mine' });
    });

    it('falls through to a later source when the first has no spans for the run', async () => {
      const m = metrics('r1', { inputTokens: 7, totalTokens: 7, llmCalls: 1, status: 'success', hasSpans: true });
      const c = new CompositeObservabilityModule([fake('mine'), fake('cw-team', { metrics: { r1: m } })]);
      const r = await c.metrics.forRun('r1');
      expect(r).toMatchObject({ inputTokens: 7, source: 'cw-team' });
    });

    it('a source error surfaces (unknown, retry) only when NO source found spans', async () => {
      const m = metrics('r1', { inputTokens: 7, totalTokens: 7, llmCalls: 1, status: 'success', hasSpans: true });
      const found = new CompositeObservabilityModule([fake('mine', { metricsFail: true }), fake('cw-team', { metrics: { r1: m } })]);
      expect(await found.metrics.forRun('r1')).toMatchObject({ status: 'success', inputTokens: 7, source: 'cw-team' });
      const nothing = new CompositeObservabilityModule([fake('mine', { metricsFail: true }), fake('cw-team')]);
      const r = await nothing.metrics.forRun('r1');
      expect(r.status).toBe('error');
      expect(r.error).toBe('mine: mine throttled');
      expect(r.hasSpans).toBeUndefined();
    });

    it('a source that matched only Agent Health\'s own eval span (hasSpans:false, evalOnlySpans) does NOT hold the run — a later source with the agent\'s spans wins', async () => {
      // The owner's shape (2026-10-24): the eval `test_case` span lands in OpenSearch, the agent exports to CloudWatch.
      const evalOnly = metrics('r1', { status: 'pending', hasSpans: false, evalOnlySpans: 1, traceId: 'eval-trace' });
      const agent = metrics('r1', { inputTokens: 23_906, totalTokens: 24_000, llmCalls: 8, status: 'success', hasSpans: true });
      const c = new CompositeObservabilityModule([fake('mine', { metrics: { r1: evalOnly } }), fake('cw-team', { metrics: { r1: agent } })]);
      expect(await c.metrics.forRun('r1')).toMatchObject({ inputTokens: 23_906, llmCalls: 8, hasSpans: true, source: 'cw-team' });
      // When NO source has the agent's spans, the eval-only answer is preferred over a plain empty one (it carries the why).
      const c2 = new CompositeObservabilityModule([fake('cw-team'), fake('mine', { metrics: { r1: evalOnly } })]);
      expect(await c2.metrics.forRun('r1')).toMatchObject({ status: 'pending', hasSpans: false, evalOnlySpans: 1, source: 'mine' });
    });

    it('no spans anywhere and no errors → pending / hasSpans false (same as a single backend)', async () => {
      const c = new CompositeObservabilityModule([fake('mine'), fake('cw-team')]);
      expect(await c.metrics.forRun('r1')).toMatchObject({ status: 'pending', hasSpans: false });
    });
  });

  describe('health / describe', () => {
    it('is ok only when every source is ok; names the failing source otherwise', async () => {
      expect(await new CompositeObservabilityModule([fake('mine'), fake('cw-team')]).health()).toMatchObject({ status: 'ok' });
      const h = await new CompositeObservabilityModule([fake('mine'), fake('cw-team', { health: 'error' })]).health();
      expect(h).toMatchObject({ status: 'error', error: 'cw-team: boom' });
    });

    it('describes itself as composite with every source, or as the single source', async () => {
      expect(new CompositeObservabilityModule([fake('mine'), fake('cw-team')]).describe()).toEqual({ type: 'composite', target: 'mine (opensearch) + cw-team (cloudwatch)' });
      expect(new CompositeObservabilityModule([fake('mine')]).describe().type).toBe('opensearch');
      expect(() => new CompositeObservabilityModule([])).toThrow(/at least one source/);
    });

    it('healthBySource lists every source', async () => {
      const list = await new CompositeObservabilityModule([fake('mine'), fake('cw-team', { health: 'error' })]).healthBySource();
      expect(list.map((x) => [x.name, x.type, x.health.status])).toEqual([['mine', 'opensearch', 'ok'], ['cw-team', 'cloudwatch', 'error']]);
    });
  });
});
