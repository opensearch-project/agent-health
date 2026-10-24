/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the assistant's tool surface and its pi-SDK wiring. The READ-ONLY
 * guarantee is `tools: ASK_TOOLS` passed to `createAgentSession` — nothing
 * built-in (read/bash/edit/write), no MCP, no user extensions. If someone
 * widens the list, this test is what goes red.
 */

const mockModel = { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-6' };
const mockConfig = jest.fn(() => ({ assistant: {} }));
jest.mock('@/lib/config/index', () => ({ loadConfigSync: () => mockConfig() }));

describe('askService — pi SDK wiring (read-only by construction)', () => {
  let createAgentSession: jest.Mock;
  let resourceLoaderOpts: any;
  let sessionCreate: jest.Mock;
  let sessionOpen: jest.Mock;
  let prompted: string[];
  let appendedCustom: Array<[string, unknown]>;
  let promptGate: (() => void) | null;
  let getById: jest.Mock;
  let fakeSm: any;

  beforeEach(() => {
    jest.resetModules();
    resourceLoaderOpts = undefined;
    prompted = [];
    appendedCustom = [];
    mockConfig.mockReturnValue({ assistant: {} });
    promptGate = null;
    fakeSm = {
      getSessionId: () => 'ask-test-session',
      getSessionFile: () => '/tmp/ask-sessions/x_ask-test-session.jsonl',
      getEntries: () => [],
      getSessionName: () => undefined,
      getHeader: () => null,
      appendCustomEntry: (t: string, d: unknown) => { appendedCustom.push([t, d]); return 'id'; },
      appendSessionInfo: jest.fn(() => 'id'),
    };
    sessionCreate = jest.fn(() => fakeSm);
    sessionOpen = jest.fn(() => ({ ...fakeSm, getSessionId: () => 'ask-from-disk', getEntries: () => [{ type: 'custom', customType: 'agent-health.ask', data: { page: { route: '/runs/report-1' }, selections: [], createdAt: 'x' } }, { type: 'custom', customType: 'agent-health.ask.turn', data: { id: 't0', question: 'earlier', answer: 'said', selections: [], startedAt: 'x', toolCalls: [] } }] }));
    // Real-shaped pi session: `prompt()` APPENDS the user message and the turn's assistant
    // message(s) to `messages` (pi persists them as it goes) and emits `message_end` for each
    // finished message to subscribers; earlier turns stay in the array.
    createAgentSession = jest.fn(async () => {
      const messages: any[] = [];
      const listeners = new Set<(e: any) => void>();
      const emit = (e: any) => { for (const l of listeners) l(e); };
      return {
        session: {
          messages,
          prompt: jest.fn(async (p: string) => {
            prompted.push(p);
            messages.push({ role: 'user', content: [{ type: 'text', text: p }] });
            if (promptGate) await new Promise<void>((r) => { promptGate = r; });
            const m = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'the answer' }] };
            messages.push(m);
            emit({ type: 'message_end', message: m });
          }),
          subscribe: jest.fn((l: any) => { listeners.add(l); l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'the ' } }); l({ type: 'tool_execution_start', toolName: 'get_report' }); l({ type: 'tool_execution_end', toolName: 'get_report' }); return () => { listeners.delete(l); }; }),
        },
      };
    });
    getById = jest.fn(async (id: string) => (id === 'report-1' ? { id: 'report-1', testCaseId: 'tc-1', passFailStatus: 'failed', trajectory: [] } : null));
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession,
        SessionManager: { create: sessionCreate, open: sessionOpen, inMemory: jest.fn() },
        ModelRuntime: { create: jest.fn(async () => ({ getAvailable: jest.fn(async () => [mockModel]) })) },
        DefaultResourceLoader: jest.fn().mockImplementation((opts: any) => { resourceLoaderOpts = opts; return { reload: jest.fn(async () => {}) }; }),
        getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
      }),
      { virtual: true }
    );
    jest.doMock('@/lib/debug', () => ({ debug: jest.fn() }));
    jest.doMock('@/server/adapters/index', () => ({
      getStorageModule: () => ({
        runs: { getById: (id: string) => getById(id), getByExperimentRun: async () => [] },
        evaluationRuns: { getById: async () => null },
        testCases: { getById: async () => null },
        benchmarks: { getById: async () => null },
      }),
    }));
  });

  const realFetch = global.fetch;
  afterEach(() => {
    (global as any).fetch = realFetch; // some tests stub fetch; the real-HTTP tests below need the real one
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.dontMock('@/lib/debug');
    jest.dontMock('@/server/adapters/index');
  });

  it('ASK_TOOLS is exactly the five read-only tools', () => {
    const { ASK_TOOLS } = require('@/server/services/ask/askService');
    expect([...ASK_TOOLS]).toEqual(['get_report', 'get_evaluation_run', 'get_test_case', 'get_benchmark', 'query_spans']);
  });

  it('createAgentSession gets tools: ASK_TOOLS (no built-ins), an isolated resource loader, and a FILE-backed pi session in the ask dir', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, ASK_TOOLS, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const done = await new Promise<any>((resolve, reject) => {
      streamAsk(
        { question: 'why?', selections: [{ text: 'hl' }], pageContext: { route: '/runs/report-1' } },
        { onMeta: () => {}, onDelta: () => {}, onTool: () => {}, onDone: resolve, onError: (e: string) => reject(new Error(e)) }
      );
    });
    expect(done.answer).toBe('the answer');

    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toEqual([...ASK_TOOLS]);
    expect(opts.model).toEqual(mockModel);
    expect(opts.sessionManager).toBe(sessionCreate.mock.results[0].value);

    // pi session persisted by pi itself, in OUR directory (not ~/.pi/agent/sessions/<cwd>).
    expect(sessionCreate).toHaveBeenCalledWith(process.cwd(), '/tmp/ask-proto-unit-sessions', expect.objectContaining({ id: expect.stringMatching(/^ask-/) }));

    // Isolation: no user extensions / skills / prompt templates / context files; only our tools extension.
    expect(resourceLoaderOpts).toMatchObject({ noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    expect(resourceLoaderOpts.extensionFactories).toHaveLength(1);
    const registered: string[] = [];
    resourceLoaderOpts.extensionFactories[0]({ registerTool: (d: any) => registered.push(d.name) });
    expect(registered).toEqual([...ASK_TOOLS]);

    // The prompt carried the highlight + question; metadata rode along as pi custom entries.
    expect(prompted[0]).toContain('> hl');
    expect(prompted[0]).toContain('## Question\nwhy?');
    expect(appendedCustom.map(([t]) => t)).toEqual(['agent-health.ask', 'agent-health.ask.turn']);
    expect(appendedCustom[1][1]).toMatchObject({ question: 'why?', answer: 'the answer', selections: [{ text: 'hl' }] });
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  function ask(streamAsk: any, req: any) {
    const events: any[] = [];
    const done = new Promise<any>((resolve) => {
      streamAsk(req, {
        onMeta: (m: any) => events.push(['meta', m]),
        onDelta: (d: string) => events.push(['delta', d]),
        onTool: (t: any) => events.push(['tool', t]),
        onDone: (r: any) => resolve({ ...r, events }),
        onError: (e: string) => resolve({ error: e, events }),
      });
    });
    return done;
  }

  it('prepareAsk builds the snapshot + pi session once; the first ask reuses them (prepared: true) and never re-reads storage', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { prepareAsk, streamAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const p = await prepareAsk({ pageContext: { route: '/runs/report-1' }, selections: [{ text: 'hl' }] });
    expect(p).toMatchObject({ sessionId: 'ask-test-session', loaded: ['report report-1'], model: `${mockModel.provider}/${mockModel.id}` });
    expect(getById).toHaveBeenCalledTimes(1);
    expect(createAgentSession).toHaveBeenCalledTimes(1);

    const r = await ask(streamAsk, { question: 'why?', selections: [{ text: 'hl' }], pageContext: { route: '/runs/report-1' }, sessionId: p.sessionId });
    expect(r.answer).toBe('the answer');
    expect(r.events[0][1]).toMatchObject({ sessionId: 'ask-test-session', prepared: true, loaded: ['report report-1'] });
    expect(r.events.filter((e: any) => e[0] === 'delta').map((e: any) => e[1])).toEqual(['the ']);
    expect(r.toolCalls).toEqual(['get_report']);
    expect(getById).toHaveBeenCalledTimes(1); // no second snapshot
    expect(createAgentSession).toHaveBeenCalledTimes(1); // same pi session
    expect(prompted[0]).toContain('## Data snapshot');

    // follow-up on the same page: no snapshot, pi has it in context
    const r2 = await ask(streamAsk, { question: 'and?', pageContext: { route: '/runs/report-1' }, sessionId: p.sessionId });
    expect(r2.answer).toBe('the answer');
    expect(prompted[1]).toContain('Follow-up: the data snapshot from earlier');
    expect(prompted[1]).not.toContain('## Data snapshot');
    expect(getById).toHaveBeenCalledTimes(1);
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('an unknown sessionId that exists on disk is re-opened through pi (restart) and continues without a snapshot', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const fs = require('fs');
    fs.mkdirSync('/tmp/ask-proto-unit-sessions', { recursive: true });
    fs.writeFileSync('/tmp/ask-proto-unit-sessions/2026_ask-from-disk.jsonl', '');
    try {
      const r = await ask(streamAsk, { question: 'repeat', pageContext: { route: '/runs/report-1' }, sessionId: 'ask-from-disk' });
      expect(r.answer).toBe('the answer');
      expect(sessionOpen).toHaveBeenCalledWith('/tmp/ask-proto-unit-sessions/2026_ask-from-disk.jsonl', '/tmp/ask-proto-unit-sessions');
      expect(createAgentSession.mock.calls[0][0].sessionManager.getSessionId()).toBe('ask-from-disk');
      expect(r.events[0][1]).toMatchObject({ sessionId: 'ask-from-disk', prepared: false, loaded: [] });
      expect(prompted[0]).toContain('Follow-up');
      const missing = await ask(streamAsk, { question: 'x', pageContext: { route: '/' }, sessionId: 'ask-nope' });
      expect(missing.error).toMatch(/not found/);
    } finally {
      fs.rmSync('/tmp/ask-proto-unit-sessions', { recursive: true, force: true });
      delete process.env.AH_ASK_SESSIONS_DIR;
    }
  });

  it('maxConcurrent caps simultaneous answers with AskBusyError; the slot is released afterwards', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    mockConfig.mockReturnValue({ assistant: { maxConcurrent: 1 } });
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    promptGate = () => {}; // first prompt blocks until released
    const first = ask(streamAsk, { question: 'slow', pageContext: { route: '/' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(askInFlight()).toBe(1);
    const second = await ask(streamAsk, { question: 'fast', pageContext: { route: '/' } });
    expect(second.error).toMatch(/already answering 1 question;/);
    (promptGate as () => void)();
    const r1 = await first;
    expect(r1.answer).toBe('the answer');
    expect(askInFlight()).toBe(0);
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('the registered tools are plain GETs (and the traces POST) against this server and never anything else', async () => {
    const { createAskToolsExtension } = require('@/server/services/ask/askService');
    const calls: Array<[string, any]> = [];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ run: { id: 'r', trajectory: [{ type: 'assistant', content: 'x'.repeat(2000) }], rawEvents: [1] }, evaluationRun: { id: 'e', results: { tc: { reportId: 'r' } }, testCaseSnapshots: [{ id: 'tc', name: 'case' }] }, testCase: { id: 'tc', sourceCode: 'secret' }, benchmark: { id: 'b', runs: [{ id: 'x', stats: {} }] }, spans: [{ spanId: 's', name: 'llm_request', attributes: {} }], correlation: { strategy: 'traceId' } }) };
    });
    const tools: Record<string, any> = {};
    createAskToolsExtension('http://localhost:5381')({ registerTool: (d: any) => { tools[d.name] = d; } });
    const report = await tools.get_report.execute('id', { reportId: 'r/../x' });
    expect(calls[0][0]).toBe('http://localhost:5381/api/storage/runs/r%2F..%2Fx');
    expect(report.details.rawEvents).toBeUndefined();
    expect(report.details.trajectory[0].content).toHaveLength(1500);
    const run = await tools.get_evaluation_run.execute('id', { runId: 'e' });
    expect(run.details.results.tc.testCase).toBe('case');
    const tc = await tools.get_test_case.execute('id', { testCaseId: 'tc' });
    expect(tc.details.sourceCode).toBeUndefined();
    await tools.get_benchmark.execute('id', { benchmarkId: 'b' });
    const spans = await tools.query_spans.execute('id', { traceId: 'abc', nameFilter: 'LLM' });
    expect(spans.details.spanCount).toBe(1);
    const noArgs = await tools.query_spans.execute('id', {});
    expect(noArgs.details.error).toMatch(/Provide traceId/);
    for (const [url, init] of calls) {
      expect(url.startsWith('http://localhost:5381/api/')).toBe(true);
      expect(init?.method ?? 'GET').toBe(url.endsWith('/api/traces') ? 'POST' : 'GET');
    }
  });

  it('tool error paths: HTTP failures become {error} results, odd shapes pass through untouched, query_spans shapes runId/sessionId correlators', async () => {
    const { createAskToolsExtension } = require('@/server/services/ask/askService');
    const calls: Array<[string, any]> = [];
    let status = 404;
    let payload: any = {};
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push([url, init]);
      return { ok: status < 400, status, json: async () => payload };
    });
    const tools: Record<string, any> = {};
    createAskToolsExtension('http://localhost:5381')({ registerTool: (d: any) => { tools[d.name] = d; } });

    // 404s from our own API are reported, never thrown (the model sees the error text)
    expect((await tools.get_report.execute('id', { reportId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/runs/nope' });
    expect((await tools.get_evaluation_run.execute('id', { runId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/evaluation-runs/nope' });
    expect((await tools.get_test_case.execute('id', { testCaseId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/test-cases/nope' });
    expect((await tools.get_benchmark.execute('id', { benchmarkId: 'nope' })).details).toEqual({ error: 'HTTP 404 for /api/storage/benchmarks/nope?fields=full' });
    expect((await tools.query_spans.execute('id', { runId: 'r' })).details).toEqual({ error: 'traces query failed: HTTP 404' });

    // shapes without the optional fields: nothing to trim / rename
    status = 200;
    payload = { id: 'bare' };
    expect((await tools.get_report.execute('id', { reportId: 'r' })).details).toEqual({ id: 'bare' });
    expect((await tools.get_evaluation_run.execute('id', { runId: 'e' })).details).toEqual({ id: 'bare' });
    expect((await tools.get_benchmark.execute('id', { benchmarkId: 'b' })).details).toEqual({ id: 'bare' });
    payload = null;
    expect((await tools.get_test_case.execute('id', { testCaseId: 't' })).details).toBeNull();
    // a trajectory with non-string content / tool output is passed through; the benchmark's runs are capped to the last 30
    payload = { run: { trajectory: [{ type: 'tool_result', toolName: 'search', content: { a: 1 }, toolOutput: 'y'.repeat(2000), toolArgs: { q: 1 } }] } };
    const rep = (await tools.get_report.execute('id', { reportId: 'r' })).details;
    expect(rep.trajectory[0]).toEqual({ i: 0, type: 'tool_result', toolName: 'search', content: { a: 1 }, toolArgs: { q: 1 }, toolOutput: 'y'.repeat(1500) });
    payload = { benchmark: { runs: Array.from({ length: 40 }, (_, i) => ({ id: `run-${i}`, name: `n${i}`, stats: { passed: i }, extra: 'dropped' })) } };
    const bench = (await tools.get_benchmark.execute('id', { benchmarkId: 'b' })).details;
    expect(bench.runs).toHaveLength(30);
    expect(bench.runs[0].id).toBe('run-10');
    expect(bench.runs[0].extra).toBeUndefined();
    // an evaluation run whose results lack an entry for a snapshot still gets names for the ones it has
    payload = { evaluationRun: { id: 'e', testCaseSnapshots: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } };
    expect((await tools.get_evaluation_run.execute('id', { runId: 'e' })).details).toEqual({ id: 'e', results: {} });

    // query_spans: runId → runIds, sessionId → an agents hint; no `spans` array → empty, duration fallback
    payload = { correlation: { strategy: 'runIds' } };
    const empty = (await tools.query_spans.execute('id', { runId: 'run-1', sessionId: 'sess-1' })).details;
    expect(empty).toEqual({ correlation: { strategy: 'runIds' }, spanCount: 0, spans: [] });
    const body = JSON.parse(calls[calls.length - 1][1].body);
    expect(body).toMatchObject({ size: 300, runIds: ['run-1'], agents: [expect.objectContaining({ sessionId: 'sess-1', serviceName: 'unknown', startedAt: 0 })] });
    expect(body.traceId).toBeUndefined();
    payload = { spans: [{ spanId: 's1', name: 'chat', duration: 12, attributes: { 'gen_ai.operation.name': 'chat' } }, { spanId: 's2', name: 'execute_tool search', durationMs: 3 }] };
    const spans = (await tools.query_spans.execute('id', { traceId: 'abc' })).details;
    expect(spans.spanCount).toBe(2);
    expect(spans.spans[0]).toMatchObject({ spanId: 's1', durationMs: 12, attributes: { 'gen_ai.operation.name': 'chat' } });
    expect(spans.spans[1].durationMs).toBe(3);
    expect((await tools.query_spans.execute('id', { traceId: 'abc', nameFilter: 'tool' })).details.spans.map((x: any) => x.spanId)).toEqual(['s2']);
  });

  it('streamAsk failure modes: a thrown prompt releases the slot and reports the message; an empty answer is an error; abort suppresses callbacks; a busy session refuses a second question', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, prepareAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();

    // 1. the model call throws → onError with the message, slot released, session reusable
    createAgentSession.mockImplementationOnce(async () => ({
      session: { prompt: jest.fn(async () => { throw new Error('ThrottlingException: slow down'); }), subscribe: jest.fn(() => () => {}), messages: [] },
    }));
    const failed = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
    expect(failed.error).toBe('ThrottlingException: slow down');
    expect(askInFlight()).toBe(0);

    // 2. a turn that streams nothing and leaves no assistant text → "returned no text" error, recorded on the turn
    createAgentSession.mockImplementationOnce(async () => ({
      session: { prompt: jest.fn(async () => {}), subscribe: jest.fn(() => () => {}), messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }] },
    }));
    const empty = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
    expect(empty.error).toBe('The assistant returned no text.');
    expect(appendedCustom.filter(([t]) => t === 'agent-health.ask.turn').pop()![1]).toMatchObject({ error: 'The assistant returned no text.', answer: '' });

    // 3. a second assistant message mid-turn separates paragraphs; a tool error is flagged; the streamed text is the answer when messages carry none
    createAgentSession.mockImplementationOnce(async () => ({
      session: {
        prompt: jest.fn(async () => {}),
        subscribe: jest.fn((l: any) => {
          l({ type: 'message_start', message: { role: 'assistant' } }); // first → nothing yet to separate
          l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } }); // empty delta ignored
          l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Part one.' } });
          l({ type: 'tool_execution_start', toolName: 'query_spans', args: { traceId: 't' } });
          l({ type: 'tool_execution_end', toolName: 'query_spans', isError: true });
          l({ type: 'message_start', message: { role: 'assistant' } });
          l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Part two.' } });
          return () => {};
        }),
        messages: [],
      },
    }));
    const two = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
    expect(two.answer).toBe('Part one.\n\nPart two.');
    expect(two.events.filter((e: any) => e[0] === 'delta').map((e: any) => e[1])).toEqual(['Part one.', '\n\n', 'Part two.']);
    expect(two.events.filter((e: any) => e[0] === 'tool').map((e: any) => e[1])).toEqual([
      { name: 'query_spans', status: 'start', args: { traceId: 't' } },
      { name: 'query_spans', status: 'end', isError: true },
    ]);
    expect(two.toolCalls).toEqual(['query_spans']);
    expect(two.firstTokenMs).toBeGreaterThanOrEqual(0);

    // 4. abort while the prompt is in flight → pi's abort is called, no done/error reaches the client, slot released
    const sessionAbort = jest.fn(async () => {});
    createAgentSession.mockImplementationOnce(async () => ({
      session: {
        prompt: jest.fn(async () => { await new Promise<void>((r) => { promptGate = r; }); }),
        subscribe: jest.fn((l: any) => { l({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }); return () => {}; }),
        abort: sessionAbort,
        messages: [],
      },
    }));
    const events: string[] = [];
    let settled = false;
    const handle = streamAsk({ question: 'q', pageContext: { route: '/' } }, {
      onMeta: () => events.push('meta'), onDelta: () => events.push('delta'), onTool: () => {},
      onDone: () => { settled = true; }, onError: () => { settled = true; },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['meta', 'delta']);
    handle.abort();
    expect(sessionAbort).toHaveBeenCalledTimes(1);
    (promptGate as () => void)();
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(askInFlight()).toBe(0);

    // 5. asking the same prepared session twice at once → the second is refused
    promptGate = () => {};
    const p = await prepareAsk({ pageContext: { route: '/' } });
    const first = ask(streamAsk, { question: 'one', pageContext: { route: '/' }, sessionId: p.sessionId });
    await new Promise((r) => setTimeout(r, 20));
    const second = await ask(streamAsk, { question: 'two', pageContext: { route: '/' }, sessionId: p.sessionId });
    expect(second.error).toMatch(/still answering a previous question/);
    (promptGate as () => void)();
    expect((await first).answer).toBe('the answer');
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('an abort that lands while the snapshot is still being built releases the concurrency slot (no permanent 429)', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    mockConfig.mockReturnValue({ assistant: { maxConcurrent: 1 } });
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    // a slow storage read: the client gives up (closes the SSE) before the first byte
    let releaseStorage: (() => void) | null = null;
    getById.mockImplementationOnce(() => new Promise((r) => { releaseStorage = () => r({ id: 'report-1', testCaseId: 'tc-1', trajectory: [] }); }));
    const prompt = jest.fn(async () => {});
    createAgentSession.mockImplementationOnce(async () => ({ session: { prompt, subscribe: jest.fn(() => () => {}), messages: [] } }));
    const events: string[] = [];
    const handle = streamAsk({ question: 'q', pageContext: { route: '/runs/report-1' } }, {
      onMeta: () => events.push('meta'), onDelta: () => events.push('delta'), onTool: () => {}, onDone: () => events.push('done'), onError: (e: string) => events.push('error:' + e),
    });
    await new Promise((r) => setTimeout(r, 20));
    handle.abort();
    (releaseStorage as unknown as () => void)();
    await new Promise((r) => setTimeout(r, 30));
    expect(prompt).not.toHaveBeenCalled(); // the model was never invoked for an abandoned question
    expect(events).toEqual([]); // nothing reaches a client that left
    expect(askInFlight()).toBe(0); // the slot is free again …
    const next = await ask(streamAsk, { question: 'next', pageContext: { route: '/' } });
    expect(next.answer).toBe('the answer'); // … so the next question is answered, not 429'd
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('model selection: the config pin is honoured exactly — provider-qualified pins match that provider only, an unavailable pin is an error (never a silent fallback), the request cannot override it', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const sdk = require('@earendil-works/pi-coding-agent');
    // The SAME model id under two providers: the pin decides where the data goes.
    const viaAnthropic = { provider: 'anthropic', id: 'claude-opus-4-1' };
    const viaBedrock = { provider: 'amazon-bedrock', id: 'claude-opus-4-1' };
    sdk.ModelRuntime.create = jest.fn(async () => ({ getAvailable: jest.fn(async () => [viaAnthropic, viaBedrock, mockModel]) }));
    const { prepareAsk, resetAskServiceState, resolvePinnedModel } = require('@/server/services/ask/askService');

    mockConfig.mockReturnValue({ assistant: { model: 'amazon-bedrock/claude-opus-4-1' } });
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' } })).model).toBe('amazon-bedrock/claude-opus-4-1');
    mockConfig.mockReturnValue({ assistant: { model: 'anthropic/claude-opus-4-1' } });
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' } })).model).toBe('anthropic/claude-opus-4-1');
    // a bare pin matches any provider (first registry hit)
    mockConfig.mockReturnValue({ assistant: { model: 'claude-opus-4-1' } });
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' } })).model).toBe('anthropic/claude-opus-4-1');
    // a request-level model id is not part of the contract any more: it is ignored, the config pin wins
    expect((await prepareAsk({ pageContext: { route: '/' }, modelId: 'amazon-bedrock/claude-opus-4-1' } as any)).model).toBe('anthropic/claude-opus-4-1');
    // an unavailable pin (wrong provider, or unknown id) is a clear error naming the pin — not another model
    mockConfig.mockReturnValue({ assistant: { model: 'openai/claude-opus-4-1' } });
    resetAskServiceState();
    await expect(prepareAsk({ pageContext: { route: '/' } })).rejects.toThrow(/pinned model "openai\/claude-opus-4-1" is not in the credentialed pi registry/);
    mockConfig.mockReturnValue({ assistant: { model: 'does-not-exist' } });
    resetAskServiceState();
    await expect(prepareAsk({ pageContext: { route: '/' } })).rejects.toThrow(/pinned model "does-not-exist"/);
    expect(() => resolvePinnedModel([], 'x')).toThrow(/no credentialed model at all/);
    // Bedrock's region inference profile is still preferred within a pin's candidates — unless the pin names a variant verbatim
    const variants = [{ provider: 'amazon-bedrock', id: 'anthropic.claude-sonnet-4-6' }, { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-6' }, { provider: 'amazon-bedrock', id: 'global.anthropic.claude-sonnet-4-6' }];
    expect(resolvePinnedModel(variants, 'amazon-bedrock/anthropic.claude-sonnet-4-6').id).toBe('us.anthropic.claude-sonnet-4-6');
    expect(resolvePinnedModel(variants, 'amazon-bedrock/global.anthropic.claude-sonnet-4-6').id).toBe('global.anthropic.claude-sonnet-4-6');
    expect(resolvePinnedModel(variants, 'global.anthropic.claude-sonnet-4-6').id).toBe('global.anthropic.claude-sonnet-4-6');
    // a slash inside a bare id (Bedrock ARN) is not a provider separator
    const arn = { provider: 'amazon-bedrock', id: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom' };
    expect(resolvePinnedModel([arn, ...variants], arn.id)).toBe(arn);

    // no pin: the newest Claude; a registry with no Claude still yields its newest model; an EMPTY registry is a clear error
    mockConfig.mockReturnValue({ assistant: {} });
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' } })).model).toBe(`${mockModel.provider}/${mockModel.id}`);
    sdk.ModelRuntime.create = jest.fn(async () => ({ getAvailable: jest.fn(async () => [{ provider: 'openai', id: 'gpt-x' }]) }));
    resetAskServiceState();
    expect((await prepareAsk({ pageContext: { route: '/' } })).model).toBe('openai/gpt-x');
    sdk.ModelRuntime.create = jest.fn(async () => ({ getAvailable: jest.fn(async () => []) }));
    resetAskServiceState();
    await expect(prepareAsk({ pageContext: { route: '/' } })).rejects.toThrow(/no credentialed model/);
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('the pi ModelRuntime is wrapped for Bedrock credential rotation before any session is created (askModelRuntime)', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { prepareAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    await prepareAsk({ pageContext: { route: '/' } });
    const runtime = createAgentSession.mock.calls[0][0].modelRuntime;
    // The wrapper's streamSimple is OUR async function, not the SDK's: a Bedrock call goes through the credential refresh.
    expect(typeof runtime.streamSimple).toBe('function');
    expect(runtime.streamSimple.constructor.name).toBe('AsyncFunction');
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('a failed follow-up reports THAT turn\'s error, never the previous answer (pi: prompt() resolves, the terminal assistant message carries stopReason "error")', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, prepareAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const messages: any[] = [];
    let script: 'ok' | 'error' | 'partial' | 'aborted' = 'ok';
    let listener: ((e: any) => void) | null = null;
    createAgentSession.mockImplementationOnce(async () => ({
      session: {
        messages,
        subscribe: jest.fn((l: any) => { listener = l; return () => { listener = null; }; }),
        prompt: jest.fn(async (p: string) => {
          messages.push({ role: 'user', content: [{ type: 'text', text: p }] });
          let m: any;
          if (script === 'ok') m = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'First answer.' }] };
          else if (script === 'error') m = { role: 'assistant', stopReason: 'error', errorMessage: 'Validation error: synthetic failure', content: [] };
          else if (script === 'partial') {
            listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Half an ' } });
            m = { role: 'assistant', stopReason: 'error', errorMessage: 'socket hang up', content: [{ type: 'text', text: 'Half an ' }] };
          } else m = { role: 'assistant', stopReason: 'aborted', content: [] };
          messages.push(m);
          listener?.({ type: 'message_end', message: m });
        }),
        abort: jest.fn(async () => {}),
      },
    }));
    const p = await prepareAsk({ pageContext: { route: '/' } });
    const first = await ask(streamAsk, { question: 'one', pageContext: { route: '/' }, sessionId: p.sessionId });
    expect(first.answer).toBe('First answer.');

    script = 'error';
    const second = await ask(streamAsk, { question: 'two', pageContext: { route: '/' }, sessionId: p.sessionId });
    expect(second.answer).toBeUndefined();
    expect(second.error).toBe('Validation error: synthetic failure');
    // the failed turn is persisted as failed (history shows the error, not a duplicate of turn one)
    const recorded = () => appendedCustom.filter(([t]) => t === 'agent-health.ask.turn').map(([, d]: any) => d);
    expect(recorded()[1]).toMatchObject({ question: 'two', answer: '', error: 'Validation error: synthetic failure' });

    script = 'partial';
    const third = await ask(streamAsk, { question: 'three', pageContext: { route: '/' }, sessionId: p.sessionId });
    expect(third.error).toBe('socket hang up');
    expect(third.events.filter((e: any) => e[0] === 'delta').map((e: any) => e[1])).toEqual(['Half an ']);
    expect(recorded()[2]).toMatchObject({ question: 'three', answer: 'Half an ', error: 'socket hang up' });

    // an interruption that was NOT ours (pi aborted the run) is reported as such, again not as the old answer
    script = 'aborted';
    const fourth = await ask(streamAsk, { question: 'four', pageContext: { route: '/' }, sessionId: p.sessionId });
    expect(fourth.error).toBe('The answer was interrupted.');
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('session exclusivity: concurrent cold resumes open ONE pi session; a held session refuses extra questions without releasing the holder', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const fs = require('fs');
    fs.mkdirSync('/tmp/ask-proto-unit-sessions', { recursive: true });
    fs.writeFileSync('/tmp/ask-proto-unit-sessions/2026_ask-from-disk.jsonl', '');
    try {
      // 1. two follow-ups race in right after a restart: one SessionManager.open, one createAgentSession
      promptGate = () => {};
      const prompts: Array<Promise<any>> = [
        ask(streamAsk, { question: 'a', pageContext: { route: '/' }, sessionId: 'ask-from-disk' }),
        ask(streamAsk, { question: 'b', pageContext: { route: '/' }, sessionId: 'ask-from-disk' }),
      ];
      await new Promise((r) => setTimeout(r, 30));
      expect(sessionOpen).toHaveBeenCalledTimes(1);
      expect(createAgentSession).toHaveBeenCalledTimes(1);
      expect(prompted).toHaveLength(1);
      expect(askInFlight()).toBe(1);

      // 2. a THIRD and FOURTH question on the held session: refused, and the holder is still holding
      const third = await ask(streamAsk, { question: 'c', pageContext: { route: '/' }, sessionId: 'ask-from-disk' });
      expect(third.error).toMatch(/still answering a previous question/);
      const fourth = await ask(streamAsk, { question: 'd', pageContext: { route: '/' }, sessionId: 'ask-from-disk' });
      expect(fourth.error).toMatch(/still answering a previous question/);
      expect(prompted).toHaveLength(1); // exactly one question reached pi
      expect(askInFlight()).toBe(1); // a refused request never touched the holder's slot

      // 3. the holder finishes → the session is free; the next question runs
      (promptGate as () => void)();
      const settled = await Promise.all(prompts);
      expect(settled.filter((r) => r.answer === 'the answer')).toHaveLength(1);
      expect(settled.filter((r) => /still answering/.test(r.error ?? ''))).toHaveLength(1);
      expect(askInFlight()).toBe(0);
      promptGate = null;
      const after = await ask(streamAsk, { question: 'e', pageContext: { route: '/' }, sessionId: 'ask-from-disk' });
      expect(after.answer).toBe('the answer');
      expect(prompted).toHaveLength(2);
    } finally {
      fs.rmSync('/tmp/ask-proto-unit-sessions', { recursive: true, force: true });
      delete process.env.AH_ASK_SESSIONS_DIR;
    }
  });

  it('a held HTTP lookup is cancelled by the client disconnect and the concurrency slot is reusable within a bounded interval (real fetch, real held server)', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    mockConfig.mockReturnValue({ assistant: { maxConcurrent: 1 } });
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const http = require('http');
    const held: Array<{ req: any; closed: boolean }> = [];
    const server = http.createServer((req: any) => { const h = { req, closed: false }; req.on('close', () => { h.closed = true; }); held.push(h); /* never answer */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.AH_JUDGE_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
    try {
      // The fake pi session behaves like the real agent loop: it runs the registered tool with the
      // run's abort signal and only resolves prompt() once the tool has settled.
      let runAbort: AbortController | null = null;
      createAgentSession.mockImplementationOnce(async () => ({
        session: {
          messages: [],
          subscribe: jest.fn(() => () => {}),
          prompt: jest.fn(async () => {
            const tools: Record<string, any> = {};
            resourceLoaderOpts.extensionFactories[0]({ registerTool: (d: any) => { tools[d.name] = d; } });
            runAbort = new AbortController();
            await tools.get_report.execute('call-1', { reportId: 'held' }, runAbort.signal);
          }),
          abort: jest.fn(async () => { runAbort?.abort(); }),
        },
      }));
      let settled = false;
      const handle = streamAsk({ question: 'q', pageContext: { route: '/' } }, { onMeta: () => {}, onDelta: () => {}, onTool: () => {}, onDone: () => { settled = true; }, onError: () => { settled = true; } });
      await new Promise<void>((r) => { const t = setInterval(() => { if (held.length) { clearInterval(t); r(); } }, 5); });
      expect(askInFlight()).toBe(1);
      const t0 = Date.now();
      handle.abort(); // the SSE client went away
      await new Promise<void>((r) => { const t = setInterval(() => { if (askInFlight() === 0) { clearInterval(t); r(); } }, 5); setTimeout(() => { clearInterval(t); r(); }, 1500); });
      expect(askInFlight()).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(held[0].closed).toBe(true); // the in-flight lookup itself was torn down, not just forgotten
      expect(settled).toBe(false); // nothing is sent to a client that left
      const next = await ask(streamAsk, { question: 'next', pageContext: { route: '/' } });
      expect(next.answer).toBe('the answer'); // the slot was free, no 429
    } finally {
      server.close();
      delete process.env.AH_JUDGE_SERVER_URL;
      delete process.env.AH_ASK_SESSIONS_DIR;
    }
  });

  it('a tool lookup has a deadline of its own (assistant.toolTimeoutMs): a stalled API call becomes an error result, not a hung turn', async () => {
    const { createAskToolsExtension } = require('@/server/services/ask/askService');
    const http = require('http');
    const server = http.createServer(() => { /* never answer */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const tools: Record<string, any> = {};
      createAskToolsExtension(`http://127.0.0.1:${server.address().port}`, 150)({ registerTool: (d: any) => { tools[d.name] = d; } });
      const t0 = Date.now();
      const r = await tools.get_report.execute('id', { reportId: 'slow' });
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(r.details).toEqual({ error: 'GET /api/storage/runs/slow timed out' });
      const spans = await tools.query_spans.execute('id', { traceId: 't' });
      expect(spans.details).toEqual({ error: 'traces query timed out' });
      // pi's own abort signal cancels a lookup too (reported as cancelled, not timed out)
      const ac = new AbortController();
      const pending = tools.get_test_case.execute('id', { testCaseId: 'x' }, ac.signal);
      ac.abort();
      expect((await pending).details).toEqual({ error: 'GET /api/storage/test-cases/x was cancelled' });
    } finally {
      server.close();
    }
  });

  it('turn budget: lookups are admitted BEFORE dispatch — a parallel batch beyond assistant.maxToolCalls has its extra calls refused, an over-budget follow-up response ends the turn; the slot is released', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    mockConfig.mockReturnValue({ assistant: { maxToolCalls: 3 } });
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const http = require('http');
    let hits = 0;
    const server = http.createServer((_req: any, res: any) => { hits += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ run: { id: 'ok' } })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.AH_JUDGE_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
    const sessionAbort = jest.fn(async () => {});
    const batchOutcomes: string[][] = [];
    try {
      // The fake agent loop runs the registered tools the way pi does: all calls of one model
      // response in parallel, a `message_end` per model response, until aborted.
      createAgentSession.mockImplementationOnce(async () => {
        const messages: any[] = [];
        let listener: any;
        return {
          session: {
            messages,
            abort: sessionAbort,
            subscribe: jest.fn((l: any) => { listener = l; return () => {}; }),
            prompt: jest.fn(async () => {
              const tools: Record<string, any> = {};
              resourceLoaderOpts.extensionFactories[0]({ registerTool: (d: any) => { tools[d.name] = d; } });
              for (let step = 0; step < 3 && !sessionAbort.mock.calls.length; step++) {
                listener({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [] } });
                const batch = await Promise.all([0, 1, 2, 3, 4].map((i) => {
                  listener({ type: 'tool_execution_start', toolName: 'get_report', args: { reportId: String(i) } });
                  return tools.get_report.execute(`c${step}-${i}`, { reportId: String(i) }, new AbortController().signal);
                }));
                batchOutcomes.push(batch.map((r: any) => (r.details?.error ? 'refused' : 'served')));
              }
              messages.push({ role: 'assistant', stopReason: 'aborted', content: [] });
              listener({ type: 'message_end', message: messages[messages.length - 1] });
            }),
          },
        };
      });
      const r = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
      expect(batchOutcomes[0]).toEqual(['served', 'served', 'served', 'refused', 'refused']); // the batch overrun is contained
      expect(hits).toBe(3); // exactly the budget reached the API
      expect(batchOutcomes[1]).toEqual(['refused', 'refused', 'refused', 'refused', 'refused']); // nothing left → the turn is cut
      expect(sessionAbort).toHaveBeenCalledTimes(1);
      expect(r.error).toBe('The assistant stopped after 3 tool lookups (assistant.maxToolCalls).');
      expect(askInFlight()).toBe(0);
      const turn: any = appendedCustom.filter(([t]) => t === 'agent-health.ask.turn').pop()![1];
      expect(turn.error).toContain('3 tool lookups');
    } finally {
      server.close();
      delete process.env.AH_JUDGE_SERVER_URL;
      delete process.env.AH_ASK_SESSIONS_DIR;
    }
  });

  it('compaction: pi rewriting session.messages mid-turn (shrunk array) must not turn a partial failure into a success', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, prepareAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    let listener: any;
    const messages: any[] = Array.from({ length: 20 }, () => ({ role: 'assistant', content: [{ type: 'text', text: 'old' }], stopReason: 'stop' }));
    createAgentSession.mockImplementationOnce(async () => ({ session: {
      messages,
      subscribe: (l: any) => { listener = l; return () => {}; },
      prompt: async () => {
        // what auto-compaction does: the array is replaced by a summary + the tail
        messages.splice(0, messages.length, { role: 'compactionSummary', content: 'summary' });
        listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Half an answer' } });
        const terminal = { role: 'assistant', content: [{ type: 'text', text: 'Half an answer' }], stopReason: 'error', errorMessage: 'synthetic provider failure' };
        messages.push(terminal);
        listener({ type: 'message_end', message: terminal });
      },
    } }));
    const p = await prepareAsk({ pageContext: { route: '/' } });
    const r = await ask(streamAsk, { question: 'q', pageContext: { route: '/' }, sessionId: p.sessionId });
    expect(r.answer).toBeUndefined();
    expect(r.error).toBe('synthetic provider failure');
    expect(appendedCustom.filter(([t]) => t === 'agent-health.ask.turn').pop()![1]).toMatchObject({ answer: 'Half an answer', error: 'synthetic provider failure' });
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('a prompt that throws leaves the thread on its first turn: the next question rebuilds the snapshot instead of being treated as a follow-up', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    const { streamAsk, prepareAsk, resetAskServiceState } = require('@/server/services/ask/askService');
    resetAskServiceState();
    let fail = true;
    createAgentSession.mockImplementationOnce(async () => {
      const messages: any[] = [];
      let listener: any;
      return { session: { messages, subscribe: jest.fn((l: any) => { listener = l; return () => {}; }), prompt: jest.fn(async (p: string) => { prompted.push(p); if (fail) throw new Error('ThrottlingException'); const m = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }; messages.push(m); listener({ type: 'message_end', message: m }); }) } };
    });
    const p = await prepareAsk({ pageContext: { route: '/runs/report-1' }, selections: [] });
    expect((await ask(streamAsk, { question: 'q1', pageContext: { route: '/runs/report-1' }, sessionId: p.sessionId })).error).toBe('ThrottlingException');
    fail = false;
    expect(getById).toHaveBeenCalledTimes(1);
    const r = await ask(streamAsk, { question: 'q2', pageContext: { route: '/runs/report-1' }, sessionId: p.sessionId });
    expect(r.answer).toBe('ok');
    expect(getById).toHaveBeenCalledTimes(2); // the snapshot was rebuilt for the retried first turn
    expect(prompted[1]).toContain('## Data snapshot');
    expect(prompted[1]).not.toContain('Follow-up');
    delete process.env.AH_ASK_SESSIONS_DIR;
  });

  it('hard budget: a prompt that ignores the abort gives back its SLOT after the grace period, but the thread stays held until that prompt settles — no second writer on its file', async () => {
    const fs = require('fs');
    const dir = fs.mkdtempSync('/tmp/ask-grace-');
    process.env.AH_ASK_SESSIONS_DIR = dir;
    process.env.AH_ASK_ABORT_GRACE_MS = '60';
    process.env.AH_ASK_TURN_TIMEOUT_MS = '40';
    mockConfig.mockReturnValue({ assistant: { maxConcurrent: 1 } });
    const { streamAsk, prepareAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    let oldStillAlive = false;
    let releaseOld: (() => void) | null = null;
    createAgentSession.mockImplementationOnce(async () => {
      const messages: any[] = [];
      let listener: any;
      return { session: {
        messages, subscribe: jest.fn((l: any) => { listener = l; return () => {}; }), abort: jest.fn(async () => { /* ignored: non-cooperative */ }),
        prompt: jest.fn(async () => {
          oldStillAlive = true;
          await new Promise<void>((r) => { releaseOld = r; });
          oldStillAlive = false;
          const m = { role: 'assistant', stopReason: 'aborted', content: [] };
          messages.push(m); listener({ type: 'message_end', message: m });
        }),
      } };
    });
    try {
      const p = await prepareAsk({ pageContext: { route: '/' } });
      fs.writeFileSync(`${dir}/2026_${p.sessionId}.jsonl`, ''); // the thread IS persisted: a reopen would be a second writer
      const t0 = Date.now();
      const first = await ask(streamAsk, { question: 'stuck', pageContext: { route: '/' }, sessionId: p.sessionId });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(first.error).toBe('The assistant ran out of time after 0s (assistant.turnTimeoutMs).');
      expect(askInFlight()).toBe(0); // the slot is back …
      expect(oldStillAlive).toBe(true); // … while the old prompt is still running
      // a follow-up now is refused (the thread is quarantined), NOT answered by a second pi session on the same JSONL
      const second = await ask(streamAsk, { question: 'second writer', pageContext: { route: '/' }, sessionId: p.sessionId });
      expect(second.answer).toBeUndefined();
      expect(second.error).toMatch(/still answering a previous question/);
      expect(createAgentSession).toHaveBeenCalledTimes(1);
      // the old prompt finally settles → the hold is released and the same (single) session answers again
      (releaseOld as unknown as () => void)();
      await new Promise((r) => setTimeout(r, 20));
      createAgentSession.mockImplementation(async () => { throw new Error('must not open a second session'); });
      const sessionAfter = await ask(streamAsk, { question: 'after', pageContext: { route: '/' }, sessionId: p.sessionId });
      expect(sessionAfter.error).not.toMatch(/still answering/);
      expect(createAgentSession).toHaveBeenCalledTimes(1);
    } finally {
      (releaseOld as unknown as (() => void) | null)?.();
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.AH_ASK_ABORT_GRACE_MS;
      delete process.env.AH_ASK_TURN_TIMEOUT_MS;
      delete process.env.AH_ASK_SESSIONS_DIR;
    }
  });

  it('turn budget: the wall-clock deadline (assistant.turnTimeoutMs) aborts a turn that never finishes', async () => {
    process.env.AH_ASK_SESSIONS_DIR = '/tmp/ask-proto-unit-sessions';
    process.env.AH_ASK_TURN_TIMEOUT_MS = '120';
    const { streamAsk, resetAskServiceState, askInFlight } = require('@/server/services/ask/askService');
    resetAskServiceState();
    const messages: any[] = [];
    let release: (() => void) | null = null;
    let listener: any;
    createAgentSession.mockImplementationOnce(async () => ({
      session: {
        messages,
        subscribe: jest.fn((l: any) => { listener = l; return () => {}; }),
        prompt: jest.fn(async () => { await new Promise<void>((r) => { release = r; }); const m = { role: 'assistant', stopReason: 'aborted', content: [] }; messages.push(m); listener({ type: 'message_end', message: m }); }),
        abort: jest.fn(async () => { release?.(); }),
      },
    }));
    const t0 = Date.now();
    const r = await ask(streamAsk, { question: 'q', pageContext: { route: '/' } });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.error).toBe('The assistant ran out of time after 0s (assistant.turnTimeoutMs).');
    expect(askInFlight()).toBe(0);
    delete process.env.AH_ASK_TURN_TIMEOUT_MS;
    delete process.env.AH_ASK_SESSIONS_DIR;
  });
});
