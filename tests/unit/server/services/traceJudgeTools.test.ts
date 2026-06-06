/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the in-process trace-judge tools. Verifies the two read-only
 * tools are registered and that they are hard-scoped to the closure `runId`
 * (the model cannot pivot to other runs) and hit the local read endpoints.
 */

import { createTraceJudgeExtension } from '@/server/services/traceJudgeTools';

interface CapturedTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

function collectTools(runId: string | undefined, serverUrl = 'http://localhost:4055'): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const pi: any = { registerTool: (t: CapturedTool) => tools.set(t.name, t) };
  createTraceJudgeExtension(runId, serverUrl)(pi);
  return tools;
}

const parseText = (res: any) => JSON.parse(res.content[0].text);

describe('createTraceJudgeExtension', () => {
  afterEach(() => {
    (global.fetch as any) = undefined;
  });

  it('registers query_spans and query_logs', () => {
    const tools = collectTools('run-1');
    expect([...tools.keys()].sort()).toEqual(['query_logs', 'query_spans']);
  });

  it('disables the tools (no query) when there is no runId', async () => {
    const tools = collectTools(undefined);
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    const spans = await tools.get('query_spans')!.execute('t1', {});
    const logs = await tools.get('query_logs')!.execute('t2', {});
    expect(parseText(spans).error).toMatch(/no run id/i);
    expect(parseText(logs).error).toMatch(/no run id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('query_spans posts only the scoped runId and applies nameFilter', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ spans: [{ name: 'execute_tool' }, { name: 'chat' }, { name: 'execute_tool' }] }),
    });
    (global as any).fetch = fetchMock;
    const tools = collectTools('run-XYZ');
    const res = await tools.get('query_spans')!.execute('t1', { nameFilter: 'execute_tool' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4055/api/traces');
    expect(JSON.parse(opts.body).runIds).toEqual(['run-XYZ']); // hard-scoped — no other runs
    const out = parseText(res);
    expect(out.runId).toBe('run-XYZ');
    expect(out.spanCount).toBe(2); // chat filtered out
  });

  it('query_logs posts the scoped runId and query filter', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ logs: ['err'] }) });
    (global as any).fetch = fetchMock;
    const tools = collectTools('run-9');
    await tools.get('query_logs')!.execute('t1', { query: 'ERROR' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ runId: 'run-9', query: 'ERROR', size: 200 });
  });

  it('surfaces a non-ok HTTP status as an error result', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const tools = collectTools('run-1');
    expect(parseText(await tools.get('query_spans')!.execute('t', {})).error).toMatch(/HTTP 503/);
  });
});
