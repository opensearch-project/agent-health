/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit: fetchTracesForRun forwards the run's own traceId (Strategy A) and
 * session.id (Strategy D) as direct /api/traces clauses — so an agent that
 * emits its own trace (pi) or stamps session.id on spans (Claude Code)
 * correlates immediately, without depending on the deep-dive's window hints.
 *
 * Regression for the comparison "traces not showing" bug: the per-run fetch
 * previously only sent runId (Strategy B) + windowAgents (Strategy C).
 */

import { fetchTracesForRun } from '@/services/traces';

describe('fetchTracesForRun — direct traceId / sessionId correlation', () => {
  let bodies: any[] = [];

  beforeEach(() => {
    bodies = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ spans: [], total: 0 }) } as any;
    });
  });

  it('forwards report.traceId as the traceId clause (Strategy A)', async () => {
    await fetchTracesForRun({ runId: 'subprocess-1', traceId: '91b957e8b8ef6df862c59d871f58e318' });
    expect(bodies[0].traceId).toBe('91b957e8b8ef6df862c59d871f58e318');
    expect(bodies[0].runIds).toEqual(['subprocess-1']);
  });

  it('forwards report.sessionId as the sessionId clause (Strategy D)', async () => {
    await fetchTracesForRun({ runId: 'subprocess-2', sessionId: 'faee44ca-6dff-405e-af72-6c2b41f26588' });
    expect(bodies[0].sessionId).toBe('faee44ca-6dff-405e-af72-6c2b41f26588');
  });

  it('explicit traceId wins over evalTraceId', async () => {
    await fetchTracesForRun({ traceId: 'direct-tid', evalTraceId: 'eval-tid' });
    expect(bodies[0].traceId).toBe('direct-tid');
  });

  it('omits empty traceId / sessionId (no stray clauses)', async () => {
    await fetchTracesForRun({ runId: 'subprocess-3', traceId: undefined, sessionId: '' });
    expect(bodies[0].traceId).toBeUndefined();
    expect(bodies[0].sessionId).toBeUndefined();
  });

  it('still unions windowAgents (Strategy C) carrying sessionId for Strategy D', async () => {
    await fetchTracesForRun({
      runId: 'subprocess-4',
      includeWindowFallback: true,
      windowAgents: [{ serviceName: 'claude-code-agent', startedAt: 1, endedAt: 2, sessionId: 'sid-x' }],
    });
    expect(bodies[0].agents[0]).toMatchObject({ serviceName: 'claude-code-agent', sessionId: 'sid-x' });
  });
});
