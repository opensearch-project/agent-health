/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the /api/evaluate route handler.
 *
 * Focused on the SSE disconnect-recovery contract added in #197:
 *   - Pre-creates a placeholder run with the correct TestCaseRun shape so
 *     listing pages can render it (agentName, modelName, agentKey, etc.).
 *   - Surfaces a clear console.warn when the placeholder cannot be created
 *     (e.g. storage misconfigured) instead of silently dropping recovery.
 *   - When the evaluation throws, the placeholder is updated to status='failed'
 *     with a non-empty llmJudgeReasoning explaining the failure.
 *   - Heartbeat interval is cleaned up on every exit path (no double-clear).
 */

import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

import evaluationRoutes from '@/server/routes/evaluation';
import { getStorageModule } from '@/server/adapters';
import { runSingleUseCase } from '@/services/benchmarkRunner';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';

jest.mock('@/server/adapters', () => ({
  getStorageModule: jest.fn(),
}));
jest.mock('@/services/benchmarkRunner', () => ({
  runSingleUseCase: jest.fn(),
}));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(),
}));
jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn(() => []),
}));

const mockGetStorageModule = getStorageModule as jest.MockedFunction<typeof getStorageModule>;
const mockRunSingleUseCase = runSingleUseCase as jest.MockedFunction<typeof runSingleUseCase>;
const mockLoadConfigSync = loadConfigSync as jest.MockedFunction<typeof loadConfigSync>;
const mockGetCustomAgents = getCustomAgents as jest.MockedFunction<typeof getCustomAgents>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Express response that captures every SSE chunk written.
 * Behaves like the real one for the bits the route uses:
 *   - setHeader / flushHeaders → no-op
 *   - write(chunk) → push to writes[]
 *   - end() → flip writableEnded to true
 *   - status(n).json(body) → captured for non-SSE error paths
 */
function createMockRes() {
  const writes: string[] = [];
  const res = {
    headers: {} as Record<string, string>,
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    setHeader(this: any, k: string, v: string) { this.headers[k] = v; return this; },
    flushHeaders(this: any) { this.headersSent = true; },
    write(this: any, chunk: string) { writes.push(chunk); return true; },
    end(this: any) { this.writableEnded = true; return this; },
    status(this: any, n: number) { this.statusCode = n; return this; },
    json: jest.fn().mockReturnThis(),
  } as any as Response & { writes: string[] };
  (res as any).writes = writes;
  return res as Response & { writes: string[]; statusCode: number; json: jest.Mock };
}

function createMockReq(body: any) {
  const req = new EventEmitter() as any;
  req.body = body;
  return req as Request;
}

/** Parse all SSE events written to a mock response. */
function parseEvents(writes: string[]): any[] {
  const events: any[] = [];
  for (const chunk of writes) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
      }
    }
  }
  return events;
}

/** Locate the registered POST handler for /api/evaluate on the router. */
function getEvaluateHandler(): (req: Request, res: Response) => Promise<void> {
  const layer = (evaluationRoutes as any).stack.find(
    (l: any) => l.route?.path === '/api/evaluate' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('POST /api/evaluate not registered');
  return layer.route.stack[0].handle;
}

// ---------------------------------------------------------------------------
// Standard fixtures
// ---------------------------------------------------------------------------

const FIXTURE_AGENT = {
  key: 'claude-code',
  name: 'Claude Code',
  endpoint: 'claude',
  description: 'CC',
  connectorType: 'claude-code',
  headers: {},
  builtIn: true,
};

const FIXTURE_MODEL = {
  model_id: 'us.anthropic.claude-sonnet-4-5',
  display_name: 'Claude Sonnet 4.5',
  provider: 'bedrock',
  context_window: 200000,
  max_output_tokens: 4096,
};

const FIXTURE_TEST_CASE = {
  id: 'inline-tc-1',
  name: 'Inline test',
  description: 'desc',
  labels: [],
  category: 'Custom',
  difficulty: 'Easy',
  currentVersion: 2,
  versions: [],
  isPromoted: false,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  initialPrompt: 'do the thing',
  context: [],
};

function setupConfigMocks() {
  mockLoadConfigSync.mockReturnValue({
    agents: [FIXTURE_AGENT],
    models: { 'claude-sonnet-4.5': FIXTURE_MODEL } as any,
  } as any);
  mockGetCustomAgents.mockReturnValue([]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/evaluate — disconnect recovery contract', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setupConfigMocks();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('pre-creates a placeholder run with the full TestCaseRun shape', async () => {
    const placeholderId = 'placeholder-abc';
    let captured: any = null;
    const mockStorage = {
      runs: {
        create: jest.fn().mockImplementation(async (doc) => {
          captured = doc;
          return { ...doc, id: placeholderId };
        }),
        update: jest.fn(),
        getById: jest.fn().mockResolvedValue({
          id: placeholderId,
          status: 'completed',
          passFailStatus: 'passed',
          metrics: { accuracy: 95 },
          trajectory: [{ type: 'action' }],
          llmJudgeReasoning: 'good',
        }),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);
    mockRunSingleUseCase.mockResolvedValue(placeholderId);

    const req = createMockReq({
      testCase: FIXTURE_TEST_CASE,
      agentKey: 'claude-code',
      modelId: 'claude-sonnet-4.5',
    });
    const res = createMockRes();

    await getEvaluateHandler()(req, res);

    expect(mockStorage.runs.create).toHaveBeenCalledTimes(1);
    expect(captured).toMatchObject({
      testCaseId: 'inline-tc-1',
      testCaseVersion: 2,
      agentKey: 'claude-code',
      agentName: 'Claude Code',
      // Both names are populated so app-side and storage-side queries find the record
      agentId: 'claude-code',
      modelId: 'claude-sonnet-4.5',
      modelName: 'Claude Sonnet 4.5',
      status: 'running',
      trajectory: [],
      llmJudgeReasoning: '',
    });
    // metrics is an object (so listing pages don't render `undefined`)
    expect(captured.metrics).toEqual({});
    // timestamp is ISO-formatted
    expect(typeof captured.timestamp).toBe('string');
    expect(() => new Date(captured.timestamp).toISOString()).not.toThrow();

    // The 'started' SSE event must include the placeholder reportId
    const started = parseEvents(res.writes).find((e) => e.type === 'started');
    expect(started).toBeDefined();
    expect(started.reportId).toBe(placeholderId);
  });

  it('warns clearly when the placeholder cannot be created and continues without it', async () => {
    const mockStorage = {
      runs: {
        create: jest.fn().mockRejectedValue(new Error('storage offline')),
        update: jest.fn(),
        getById: jest.fn().mockResolvedValue({
          id: 'final-id',
          status: 'completed',
          passFailStatus: 'passed',
          metrics: { accuracy: 80 },
          trajectory: [],
          llmJudgeReasoning: 'ok',
        }),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);
    mockRunSingleUseCase.mockResolvedValue('final-id');

    const req = createMockReq({
      testCase: FIXTURE_TEST_CASE,
      agentKey: 'claude-code',
      modelId: 'claude-sonnet-4.5',
    });
    const res = createMockRes();

    await getEvaluateHandler()(req, res);

    // Clear, user-visible warning explaining the consequence
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/SSE disconnect recovery will be unavailable/),
    );
    expect(warnSpy.mock.calls[0][0]).toMatch(/storage offline/);

    // Started event must still be sent — eval can proceed; the reportId is null
    // so clients without recovery just consume the stream as before.
    const started = parseEvents(res.writes).find((e) => e.type === 'started');
    expect(started).toBeDefined();
    expect(started.reportId).toBeNull();

    // Eval still finishes normally
    const completed = parseEvents(res.writes).find((e) => e.type === 'completed');
    expect(completed).toBeDefined();
    expect(completed.report.status).toBe('completed');
  });

  it('writes llmJudgeReasoning when the eval throws, so the UI can show why', async () => {
    const placeholderId = 'placeholder-fail';
    const mockStorage = {
      runs: {
        create: jest.fn().mockResolvedValue({ id: placeholderId }),
        update: jest.fn().mockResolvedValue({ id: placeholderId }),
        getById: jest.fn(),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);
    mockRunSingleUseCase.mockRejectedValue(new Error('Connector blew up'));

    const req = createMockReq({
      testCase: FIXTURE_TEST_CASE,
      agentKey: 'claude-code',
      modelId: 'claude-sonnet-4.5',
    });
    const res = createMockRes();

    await getEvaluateHandler()(req, res);

    // Placeholder must be flipped to failed AND carry the error message
    expect(mockStorage.runs.update).toHaveBeenCalledWith(
      placeholderId,
      expect.objectContaining({
        status: 'failed',
        llmJudgeReasoning: expect.stringContaining('Connector blew up'),
      }),
    );

    // The error event is sent to the (still connected) client
    const errorEvt = parseEvents(res.writes).find((e) => e.type === 'error');
    expect(errorEvt).toBeDefined();
    expect(errorEvt.error).toMatch(/Connector blew up/);
    // Stream is closed so the client doesn't hang
    expect(res.writableEnded).toBe(true);
  });

  it('does NOT write the completed event after the client disconnects', async () => {
    const placeholderId = 'placeholder-disc';
    const mockStorage = {
      runs: {
        create: jest.fn().mockResolvedValue({ id: placeholderId }),
        update: jest.fn(),
        getById: jest.fn().mockResolvedValue({
          id: placeholderId,
          status: 'completed',
          passFailStatus: 'passed',
          metrics: { accuracy: 100 },
          trajectory: [],
          llmJudgeReasoning: 'done',
        }),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);

    // Simulate the client dropping the connection while runSingleUseCase is in flight
    mockRunSingleUseCase.mockImplementation(async (_run, _tc, _store, _onStep) => {
      // Fire 'close' on the request mid-eval
      (req as unknown as EventEmitter).emit('close');
      return placeholderId;
    });

    const req = createMockReq({
      testCase: FIXTURE_TEST_CASE,
      agentKey: 'claude-code',
      modelId: 'claude-sonnet-4.5',
    });
    const res = createMockRes();

    await getEvaluateHandler()(req, res);

    // Started event always goes out before the disconnect
    const events = parseEvents(res.writes);
    expect(events.some((e) => e.type === 'started')).toBe(true);
    // Completed event MUST NOT be written \u2014 client is gone
    expect(events.some((e) => e.type === 'completed')).toBe(false);
    // ...but the server still fetched the final report (proving it kept running)
    expect(mockStorage.runs.getById).toHaveBeenCalledWith(placeholderId);
  });

  it('emits heartbeat events while the eval is running and stops after completion', async () => {
    jest.useFakeTimers();
    const placeholderId = 'placeholder-hb';
    let resolveEval: (id: string) => void;
    const evalDone = new Promise<string>((r) => { resolveEval = r; });

    const mockStorage = {
      runs: {
        create: jest.fn().mockResolvedValue({ id: placeholderId }),
        update: jest.fn(),
        getById: jest.fn().mockResolvedValue({
          id: placeholderId,
          status: 'completed',
          passFailStatus: 'passed',
          metrics: { accuracy: 80 },
          trajectory: [],
          llmJudgeReasoning: 'ok',
        }),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);
    mockRunSingleUseCase.mockImplementation(() => evalDone);

    const req = createMockReq({
      testCase: FIXTURE_TEST_CASE,
      agentKey: 'claude-code',
      modelId: 'claude-sonnet-4.5',
    });
    const res = createMockRes();

    const promise = getEvaluateHandler()(req, res);

    // Let the synchronous setup (placeholder create + started event) settle.
    await Promise.resolve();
    await Promise.resolve();

    // Two heartbeat ticks: at 15s and 30s into the eval.
    jest.advanceTimersByTime(15_000);
    jest.advanceTimersByTime(15_000);

    let heartbeats = parseEvents(res.writes).filter((e) => e.type === 'heartbeat');
    expect(heartbeats.length).toBe(2);

    // Finish the eval
    resolveEval!(placeholderId);
    jest.useRealTimers();
    await promise;

    // Once completed, advancing time more should NOT produce extra heartbeats
    // (cleanup() cleared the interval).
    const beforeAdvance = parseEvents(res.writes).filter((e) => e.type === 'heartbeat').length;
    jest.useFakeTimers();
    jest.advanceTimersByTime(60_000);
    const afterAdvance = parseEvents(res.writes).filter((e) => e.type === 'heartbeat').length;
    expect(afterAdvance).toBe(beforeAdvance);
  });
});

// ---------------------------------------------------------------------------
// Run-name persistence
//
// Single test case runs historically had no `name` field — the runs list
// was forced to render `id.slice(0, 10)` (e.g. `report-178…`) which is
// meaningless to users. The route now:
//   - persists `runName` from the request body onto the pre-created placeholder
//   - auto-generates `Run <short-id>` and patches the placeholder when
//     `runName` is omitted, so every run — not just user-named ones — has
//     a recognizable label in the runs list.
// ---------------------------------------------------------------------------
describe('POST /api/evaluate — run name persistence', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setupConfigMocks();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('persists the user-supplied runName onto the placeholder run', async () => {
    const placeholderId = 'report-1780000000000-name001';
    let captured: any = null;
    const mockStorage = {
      runs: {
        create: jest.fn().mockImplementation(async (doc) => {
          captured = doc;
          return { ...doc, id: placeholderId };
        }),
        // No auto-generation patch is expected when runName is supplied,
        // but the route may still call update() in other paths — keep
        // the spy around so we can assert it was NOT invoked for naming.
        update: jest.fn().mockResolvedValue({ id: placeholderId }),
        getById: jest.fn().mockResolvedValue({
          id: placeholderId, status: 'completed', passFailStatus: 'passed',
          metrics: { accuracy: 90 }, trajectory: [], llmJudgeReasoning: 'ok',
        }),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);
    mockRunSingleUseCase.mockResolvedValue(placeholderId);

    const req = createMockReq({
      testCase: FIXTURE_TEST_CASE,
      agentKey: 'claude-code',
      modelId: 'claude-sonnet-4.5',
      runName: 'Baseline',
      runDescription: 'Smoke test of the v2 prompt',
    });
    const res = createMockRes();

    await getEvaluateHandler()(req, res);

    expect(captured.name).toBe('Baseline');
    expect(captured.description).toBe('Smoke test of the v2 prompt');
    // Auto-generation patch must NOT fire when the user supplied a name.
    const namingPatch = mockStorage.runs.update.mock.calls.find(
      ([, updates]: any[]) => updates && Object.prototype.hasOwnProperty.call(updates, 'name'),
    );
    expect(namingPatch).toBeUndefined();
  });

  it('trims whitespace-only runName so it falls back to auto-generated', async () => {
    const placeholderId = 'report-1780000000000-trim01';
    let captured: any = null;
    const mockStorage = {
      runs: {
        create: jest.fn().mockImplementation(async (doc) => {
          captured = doc;
          return { ...doc, id: placeholderId };
        }),
        update: jest.fn().mockResolvedValue({ id: placeholderId }),
        getById: jest.fn().mockResolvedValue({
          id: placeholderId, status: 'completed', passFailStatus: 'passed',
          metrics: { accuracy: 90 }, trajectory: [], llmJudgeReasoning: 'ok',
        }),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);
    mockRunSingleUseCase.mockResolvedValue(placeholderId);

    await getEvaluateHandler()(
      createMockReq({
        testCase: FIXTURE_TEST_CASE,
        agentKey: 'claude-code',
        modelId: 'claude-sonnet-4.5',
        runName: '   ',
      }),
      createMockRes(),
    );

    // create() is called with name: undefined (whitespace trimmed away)...
    expect(captured.name).toBeUndefined();
    // ...and the auto-generation patch fires using the trailing 6 chars
    // of the freshly-allocated id, mirroring `getRunDisplayName` on the client.
    const expectedShortId = placeholderId.slice(-6);
    expect(mockStorage.runs.update).toHaveBeenCalledWith(
      placeholderId,
      expect.objectContaining({ name: `Run ${expectedShortId}` }),
    );
  });

  it('auto-generates `Run <short-id>` when runName is omitted', async () => {
    const placeholderId = 'report-1780000000000-auto42';
    let captured: any = null;
    const mockStorage = {
      runs: {
        create: jest.fn().mockImplementation(async (doc) => {
          captured = doc;
          return { ...doc, id: placeholderId };
        }),
        update: jest.fn().mockResolvedValue({ id: placeholderId }),
        getById: jest.fn().mockResolvedValue({
          id: placeholderId, status: 'completed', passFailStatus: 'passed',
          metrics: { accuracy: 75 }, trajectory: [], llmJudgeReasoning: 'ok',
        }),
      },
    };
    mockGetStorageModule.mockReturnValue(mockStorage as any);
    mockRunSingleUseCase.mockResolvedValue(placeholderId);

    await getEvaluateHandler()(
      createMockReq({
        testCase: FIXTURE_TEST_CASE,
        agentKey: 'claude-code',
        modelId: 'claude-sonnet-4.5',
        // no runName — we expect the server to fill one in
      }),
      createMockRes(),
    );

    expect(captured.name).toBeUndefined();
    expect(mockStorage.runs.update).toHaveBeenCalledWith(
      placeholderId,
      { name: `Run ${placeholderId.slice(-6)}` },
    );
  });
});
