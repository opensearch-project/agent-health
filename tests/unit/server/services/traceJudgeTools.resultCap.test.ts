/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trace-tool result budget. A single `query_spans` result for one run was
 * measured at 400k–970k chars — appended to the judge's context by the pi
 * SDK, that alone overflowed a 200k-token window and turned judgeable cases
 * into deterministic "Input is too long for requested model" failures on the
 * judge's second turn.
 */

import {
  DEFAULT_TOOL_RESULT_CAP_CHARS,
  boundLogsPayload,
  boundSpansPayload,
  createTraceJudgeExtension,
  resolveToolResultCap,
} from '@/server/services/traceJudgeTools';

interface CapturedTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

function collectTools(runId: string): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const pi: any = { registerTool: (t: CapturedTool) => tools.set(t.name, t) };
  createTraceJudgeExtension(runId, 'http://localhost:4056')(pi);
  return tools;
}

const bigSpan = (i: number) => ({
  spanId: `s${i}`,
  traceId: 't',
  name: 'execute_tool search',
  startTime: i,
  endTime: i + 1,
  status: { code: 0 },
  attributes: { 'gen_ai.tool.name': 'search', 'tool.output': JSON.stringify({ hits: 'h'.repeat(40_000) }), 'db.query.text': '{…}' },
});

describe('resolveToolResultCap', () => {
  const saved = process.env.AH_JUDGE_TOOL_RESULT_CAP;
  afterEach(() => {
    if (saved === undefined) delete process.env.AH_JUDGE_TOOL_RESULT_CAP;
    else process.env.AH_JUDGE_TOOL_RESULT_CAP = saved;
  });
  it('defaults and honours the env override', () => {
    delete process.env.AH_JUDGE_TOOL_RESULT_CAP;
    expect(resolveToolResultCap()).toBe(DEFAULT_TOOL_RESULT_CAP_CHARS);
    process.env.AH_JUDGE_TOOL_RESULT_CAP = '5000';
    expect(resolveToolResultCap()).toBe(5000);
    process.env.AH_JUDGE_TOOL_RESULT_CAP = '-1';
    expect(resolveToolResultCap()).toBe(DEFAULT_TOOL_RESULT_CAP_CHARS);
  });
});

describe('boundSpansPayload', () => {
  it('passes small payloads through untouched', () => {
    const spans = [{ spanId: 'a', attributes: { k: 'v' } }];
    expect(boundSpansPayload(spans, 10_000)).toEqual({ spans });
  });

  it('caps long attribute values first and keeps every span when that is enough', () => {
    const spans = Array.from({ length: 3 }, bigSpan);
    const out = boundSpansPayload(spans, 20_000);
    expect(out.spans).toHaveLength(3);
    expect(out.truncation).toMatchObject({ attributeValuesCapped: true, droppedSpans: 0 });
    expect((out.spans[0].attributes as any)['tool.output']).toMatch(/…\[truncated \d+ chars\]$/);
    expect((out.spans[0].attributes as any)['gen_ai.tool.name']).toBe('search'); // short values intact
    expect(JSON.stringify(out.spans).length).toBeLessThanOrEqual(20_000);
    expect(out.truncation!.note).toContain('nameFilter');
  });

  it('drops spans from the MIDDLE (head + tail kept) when attribute capping alone is not enough', () => {
    const spans = Array.from({ length: 400 }, (_, i) => bigSpan(i));
    const out = boundSpansPayload(spans, 30_000);
    expect(out.spans.length).toBeLessThan(400);
    expect(out.spans.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.spans).length).toBeLessThanOrEqual(30_000);
    expect(out.truncation!.droppedSpans).toBe(400 - out.spans.length);
    // The first span (setup/intent) and the last span (outcome/failure evidence) survive.
    expect(out.spans[0].spanId).toBe('s0');
    expect(out.spans[out.spans.length - 1].spanId).toBe('s399');
    expect(out.truncation!.note).toMatch(/\d+ of 400 spans were dropped from the middle/);
    // Attribute values were tightened to the quarter cap before any span was dropped.
    expect(out.truncation!.note).toMatch(/cut to 500 chars/);
  });

  it('does not mutate the input spans', () => {
    const spans = [bigSpan(1)];
    const before = JSON.stringify(spans);
    boundSpansPayload(spans, 1_000);
    expect(JSON.stringify(spans)).toBe(before);
  });
});

describe('boundLogsPayload', () => {
  it('passes through when small, drops trailing lines when big', () => {
    const small = ['a', 'b'];
    expect(boundLogsPayload(small, 1_000)).toEqual({ logs: small });
    const logs = Array.from({ length: 500 }, (_, i) => ({ i, msg: 'm'.repeat(200) }));
    const out = boundLogsPayload(logs, 20_000);
    expect(out.logs.length).toBeLessThan(500);
    expect(JSON.stringify(out.logs).length).toBeLessThanOrEqual(20_000);
    expect(out.truncation!.droppedLogs).toBe(500 - out.logs.length);
  });
});

describe('query_spans / query_logs apply the cap end-to-end', () => {
  const saved = process.env.AH_JUDGE_TOOL_RESULT_CAP;
  afterEach(() => {
    (global.fetch as any) = undefined;
    if (saved === undefined) delete process.env.AH_JUDGE_TOOL_RESULT_CAP;
    else process.env.AH_JUDGE_TOOL_RESULT_CAP = saved;
  });

  it('query_spans returns spanCount (total) vs returnedSpanCount plus a truncation note, and the text is compact JSON', async () => {
    process.env.AH_JUDGE_TOOL_RESULT_CAP = '25000';
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ spans: Array.from({ length: 50 }, bigSpan) }),
    });
    const res = await collectTools('run-1').get('query_spans')!.execute('t1', {});
    const text: string = res.content[0].text;
    const out = JSON.parse(text);
    expect(out.spanCount).toBe(50);
    expect(out.returnedSpanCount).toBeLessThanOrEqual(50);
    expect(out.truncation.attributeValuesCapped).toBe(true);
    // Large results are not pretty-printed (indentation is ~30% more context).
    expect(text).not.toMatch(/\n {2}"/);
    expect(text.length).toBeLessThan(25_000 + 2_000);
  });

  it('query_spans leaves small results pretty-printed and without a truncation field', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ spans: [{ name: 'chat', attributes: {} }] }) });
    const res = await collectTools('run-1').get('query_spans')!.execute('t1', {});
    expect(res.content[0].text).toMatch(/\n {2}"/);
    expect(JSON.parse(res.content[0].text).truncation).toBeUndefined();
  });

  it('query_logs drops trailing lines over the cap and says so', async () => {
    process.env.AH_JUDGE_TOOL_RESULT_CAP = '5000';
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ logs: Array.from({ length: 200 }, (_, i) => ({ i, msg: 'x'.repeat(100) })) }),
    });
    const out = JSON.parse((await collectTools('run-1').get('query_logs')!.execute('t1', {})).content[0].text);
    expect(out.logs.length).toBeLessThan(200);
    expect(out.truncation.droppedLogs).toBe(200 - out.logs.length);
  });

  it('query_logs tolerates a non-array payload', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ logs: { total: 0 } }) });
    const out = JSON.parse((await collectTools('run-1').get('query_logs')!.execute('t1', {})).content[0].text);
    expect(out.logs).toEqual({ total: 0 });
    expect(out.truncation).toBeUndefined();
  });
});
