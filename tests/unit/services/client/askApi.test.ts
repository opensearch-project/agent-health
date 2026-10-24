/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { streamAsk, prepareAsk, listAskSessions, getAskSession, getAskStatus } from '@/services/client/askApi';

function sseResponse(events: Array<Record<string, unknown>>, chunking: 'one' | 'split' = 'one'): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + ': ping\n\n';
  const enc = new TextEncoder();
  const chunks = chunking === 'one' ? [text] : [text.slice(0, 17), text.slice(17, 40), text.slice(40)];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('askApi.streamAsk', () => {
  const fetchMock = jest.fn();
  beforeEach(() => { fetchMock.mockReset(); (global as any).fetch = fetchMock; });

  it('posts the body, dispatches meta/delta/tool events and resolves with the done event', async () => {
    fetchMock.mockResolvedValue(sseResponse([
      { type: 'meta', sessionId: 's1', turnId: 't1', agent: { key: 'a', name: 'A', model: 'm' }, refs: {}, loaded: ['report r'], prepared: true },
      { type: 'tool', name: 'get_report', status: 'start' },
      { type: 'delta', content: 'Hel' },
      { type: 'delta', content: 'lo' },
      { type: 'done', answer: 'Hello', durationMs: 42, firstTokenMs: 7, toolCalls: ['get_report'] },
    ], 'split'));
    const meta = jest.fn(); const deltas: string[] = []; const tools = jest.fn();
    const done = await streamAsk({ question: 'q', pageContext: { route: '/x' }, sessionId: 's1' }, { onMeta: meta, onDelta: (d) => deltas.push(d), onTool: tools });
    expect(fetchMock).toHaveBeenCalledWith('/api/ask', expect.objectContaining({ method: 'POST', body: JSON.stringify({ question: 'q', pageContext: { route: '/x' }, sessionId: 's1' }) }));
    expect(meta).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', prepared: true }));
    expect(deltas.join('')).toBe('Hello');
    expect(tools).toHaveBeenCalledWith(expect.objectContaining({ name: 'get_report', status: 'start' }));
    expect(done).toMatchObject({ answer: 'Hello', durationMs: 42, firstTokenMs: 7 });
  });

  it('turns an error event into a rejection', async () => {
    fetchMock.mockResolvedValue(sseResponse([{ type: 'meta', sessionId: 's' }, { type: 'error', error: 'The assistant returned no text.' }]));
    await expect(streamAsk({ question: 'q', pageContext: { route: '/' } }, {})).rejects.toThrow('The assistant returned no text.');
  });

  it('rejects on a non-2xx with the server error message, and when the stream ends without done', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Too many assistant requests; retry in 30s.' }), { status: 429 }));
    await expect(streamAsk({ question: 'q', pageContext: { route: '/' } }, {})).rejects.toThrow(/Too many assistant requests/);
    fetchMock.mockResolvedValue(sseResponse([{ type: 'delta', content: 'partial' }]));
    await expect(streamAsk({ question: 'q', pageContext: { route: '/' } }, {})).rejects.toThrow(/ended without an answer/);
  });
});

describe('askApi — plain endpoints', () => {
  const fetchMock = jest.fn();
  beforeEach(() => { fetchMock.mockReset(); (global as any).fetch = fetchMock; });

  it('prepareAsk posts and returns the prepared session; errors carry the server message', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'ask-1', refs: {}, loaded: [], model: 'm' }), { status: 200 }));
    expect(await prepareAsk({ pageContext: { route: '/r' }, selections: [{ text: 'x' }] })).toMatchObject({ sessionId: 'ask-1' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ pageContext: { route: '/r' }, selections: [{ text: 'x' }] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'disabled' }), { status: 404 }));
    await expect(prepareAsk({ pageContext: { route: '/r' } })).rejects.toThrow('disabled');
  });

  it('listAskSessions passes route/limit as query params; getAskSession maps 404 to null; getAskStatus returns the body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [{ id: 'a' }] }), { status: 200 }));
    expect(await listAskSessions({ route: '/compare/b?runs=x,y', limit: 5 })).toEqual([{ id: 'a' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ask/sessions?route=%2Fcompare%2Fb%3Fruns%3Dx%2Cy&limit=5');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    expect(await listAskSessions()).toEqual([]);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/ask/sessions');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await getAskSession('nope')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 's', turns: [] } }), { status: 200 }));
    expect(await getAskSession('s')).toEqual({ id: 's', turns: [] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false, local: true }), { status: 200 }));
    expect(await getAskStatus()).toMatchObject({ enabled: false, local: true });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500, statusText: 'boom' }));
    await expect(getAskStatus()).rejects.toThrow(/boom/);
  });
});
