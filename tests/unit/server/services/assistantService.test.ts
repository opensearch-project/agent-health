/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';

// Mock child_process BEFORE importing anything
const mockSpawn = jest.fn();
const mockExecSync = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// Mock fs
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('# Agent Health Skill Content'),
  existsSync: jest.fn().mockReturnValue(true),
}));

// Mock crypto.randomUUID for deterministic session ids
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn().mockReturnValue('00000000-0000-4000-8000-000000000000'),
}));

// Mock config loader
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({
    models: {
      'bedrock-default': {
        model_id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        provider: 'bedrock',
      },
    },
    judge: { provider: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
  }),
}));

// Mock server config
jest.mock('@/server/config/index', () => ({
  __esModule: true,
  default: {
    AWS_REGION: 'us-west-2',
    BEDROCK_MODEL_ID: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    LITELLM_ENDPOINT: 'http://localhost:4000/v1/chat/completions',
    LITELLM_API_KEY: '',
  },
}));

// Mock debug
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

// Mock storage modules used by loadContextSnapshot
const mockGetReportById = jest.fn();
const mockGetTestCaseById = jest.fn();
const mockGetBenchmarkById = jest.fn();
jest.mock('@/services/storage/asyncRunStorage', () => ({
  asyncRunStorage: { getReportById: (...a: any[]) => mockGetReportById(...a) },
}));
jest.mock('@/services/storage/asyncTestCaseStorage', () => ({
  asyncTestCaseStorage: { getById: (...a: any[]) => mockGetTestCaseById(...a) },
}));
jest.mock('@/services/storage/asyncBenchmarkStorage', () => ({
  asyncBenchmarkStorage: { getById: (...a: any[]) => mockGetBenchmarkById(...a) },
}));

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdin = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

// Real-shape NDJSON helpers (matches actual `claude --output-format stream-json`).
function assistantTextLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }) + '\n';
}
function resultLine(result: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', result, ...extras }) + '\n';
}
/** assistant message containing a tool_use block (e.g. Skill, Bash, …). */
function assistantToolUseLine(toolName: string, leadingText?: string): string {
  const content: any[] = [];
  if (leadingText) content.push({ type: 'text', text: leadingText });
  content.push({ type: 'tool_use', id: 'tu_1', name: toolName, input: {} });
  return JSON.stringify({ type: 'assistant', message: { content } }) + '\n';
}

/** Wait one microtask + macrotask so async dispatch in streamAssistantResponse runs. */
async function flushAsync() {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('AssistantService', () => {
  let assistantService: typeof import('@/server/services/assistantService');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockExecSync.mockReturnValue('claude version 1.0.0');
    mockGetReportById.mockResolvedValue(null);
    mockGetTestCaseById.mockResolvedValue(null);
    mockGetBenchmarkById.mockResolvedValue(null);
  });

  describe('isClaudeAvailable', () => {
    it('returns true when claude CLI is found', () => {
      mockExecSync.mockReturnValue('claude version 1.0.0');
      assistantService = require('@/server/services/assistantService');
      expect(assistantService.isClaudeAvailable()).toBe(true);
    });

    it('returns false when claude CLI is not found', () => {
      mockExecSync.mockImplementation(() => { throw new Error('command not found'); });
      assistantService = require('@/server/services/assistantService');
      expect(assistantService.isClaudeAvailable()).toBe(false);
    });
  });

  describe('streamAssistantResponse — claude CLI', () => {
    it('streams real-shape NDJSON deltas (parsed.message.content[].text)', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const deltas: string[] = [];
      assistantService.streamAssistantResponse(
        'real-shape',
        'Hello',
        {},
        (d: string) => deltas.push(d),
        (full: string) => {
          expect(deltas).toEqual(['Hello', ' world']);
          expect(full).toBe('Hello world');
          done();
        },
        (err: string) => done(new Error('unexpected error: ' + err))
      );

      flushAsync().then(() => {
        mockProc.stdout.emit('data', Buffer.from(assistantTextLine('Hello') + assistantTextLine(' world')));
        mockProc.emit('close', 0);
      });
    });

    it('emits onError (not onDone) when CLI returns no text', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'empty',
        'Hi',
        undefined,
        () => {},
        () => done(new Error('should not call onDone with empty response')),
        (err: string) => {
          expect(err).toMatch(/no text/i);
          done();
        }
      );

      flushAsync().then(() => {
        mockProc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'));
        mockProc.emit('close', 0);
      });
    });

    it('uses --session-id on first turn and --resume on second turn (same sessionId)', async () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);
      assistantService = require('@/server/services/assistantService');

      // Turn 1
      const turn1 = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'continuity',
          'first message',
          undefined,
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      proc1.stdout.emit('data', Buffer.from(assistantTextLine('reply1')));
      proc1.emit('close', 0);
      await turn1;

      // Turn 2
      const turn2 = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'continuity',
          'second message',
          undefined,
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      proc2.stdout.emit('data', Buffer.from(assistantTextLine('reply2')));
      proc2.emit('close', 0);
      await turn2;

      const args1: string[] = mockSpawn.mock.calls[0][1];
      const args2: string[] = mockSpawn.mock.calls[1][1];
      expect(args1).toContain('--session-id');
      expect(args1).toContain('00000000-0000-4000-8000-000000000000');
      expect(args1).not.toContain('--resume');
      expect(args2).toContain('--resume');
      expect(args2).toContain('00000000-0000-4000-8000-000000000000');
      expect(args2).not.toContain('--session-id');

      // Only the latest user message should be sent on stdin (not concatenated history).
      expect(proc2.stdin.write).toHaveBeenCalledWith('second message');
    });

    it('strips CLAUDECODE / CLAUDE_CODE_* env vars from the spawned child', async () => {
      const original = { ...process.env };
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE_SSE_PORT = '12345';
      process.env.CLAUDE_CODE_ENTRYPOINT = '/usr/bin/claude';

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      try {
        const turn = new Promise<void>((resolve, reject) => {
          assistantService.streamAssistantResponse(
            'env-strip',
            'Hi',
            undefined,
            () => {},
            () => resolve(),
            (err: string) => reject(new Error(err))
          );
        });
        await flushAsync();
        mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
        mockProc.emit('close', 0);
        await turn;

        const env = mockSpawn.mock.calls[0][2].env;
        expect(env).not.toHaveProperty('CLAUDECODE');
        expect(env).not.toHaveProperty('CLAUDE_CODE_SSE_PORT');
        expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
      } finally {
        process.env = original;
      }
    });

    it('appends a denial note when result.permission_denials is non-empty', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      let fullResponse = '';
      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'denials',
          'Do something',
          undefined,
          () => {},
          (full: string) => { fullResponse = full; resolve(); },
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();

      mockProc.stdout.emit('data', Buffer.from(
        assistantTextLine('Sure thing.') +
        resultLine('Sure thing.', { permission_denials: [{ tool_name: 'Bash' }] })
      ));
      mockProc.emit('close', 0);
      await turn;

      expect(fullResponse).toContain('1 tool call(s) were denied');
      expect(fullResponse).toContain('Bash');
    });

    it('renders a tool_use block as an inline “using tool” note (tools enabled)', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      let fullResponse = '';
      const deltas: string[] = [];
      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'tool-use',
          'Why did this run fail?',
          undefined,
          (d: string) => deltas.push(d),
          (full: string) => { fullResponse = full; resolve(); },
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();

      // With tools enabled (the default), the assistant streams text, then
      // emits a tool_use block. We surface a friendly inline note while the
      // tool runs; the next text block (here implicit) would follow normally.
      mockProc.stdout.emit('data', Buffer.from(
        assistantTextLine('Looking at the trajectory…') +
        assistantToolUseLine('Bash', 'Let me grep the logs.')
      ));
      mockProc.emit('close', 0);
      await turn;

      expect(fullResponse).toContain('Looking at the trajectory');
      expect(fullResponse).toContain('Let me grep the logs');
      // New marker format: "🔧 Using `Bash`…" instead of the old disabled note.
      expect(fullResponse).toMatch(/Using `Bash`/);
      expect(fullResponse).not.toMatch(/tool execution is disabled/);
      // And the marker streams live.
      expect(deltas.some((d) => /Using `Bash`/.test(d))).toBe(true);
    });

    it('does NOT pass --disallowed-tools — tools are enabled by default', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'with-tools',
          'Hi',
          undefined,
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
      mockProc.emit('close', 0);
      await turn;

      const args: string[] = mockSpawn.mock.calls[0][1];
      expect(args).not.toContain('--disallowed-tools');
      // --dangerously-skip-permissions is still set so MCP tools run without prompts.
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('system prompt advertises tool access (Claude CLI path)', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'tools-prompt',
          'Hi',
          undefined,
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
      mockProc.emit('close', 0);
      await turn;

      const args: string[] = mockSpawn.mock.calls[0][1];
      const idx = args.indexOf('--append-system-prompt');
      const sysPrompt = args[idx + 1];
      expect(sysPrompt).toMatch(/full tool access|chrome-devtools|MCP/i);
      expect(sysPrompt).not.toMatch(/NO tools enabled/);
    });

    it('passes --mcp-config pointing at ~/.claude.json so user MCPs (chrome-devtools, github, …) load', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'mcp-config',
          'Hi',
          undefined,
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
      mockProc.emit('close', 0);
      await turn;

      const args: string[] = mockSpawn.mock.calls[0][1];
      const idx = args.indexOf('--mcp-config');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toMatch(/\.claude\.json$/);
    });

    it('inlines all comparison runs when comparisonRunIds is provided', async () => {
      mockGetReportById.mockImplementation((id: string) => {
        const map: Record<string, any> = {
          'run-A': {
            id: 'run-A',
            agentName: 'agent-alpha',
            modelName: 'claude-3-5-sonnet',
            passFailStatus: 'passed',
            metrics: { accuracy: 90 },
            testCaseId: 'tc-1',
            llmJudgeReasoning: 'Alpha did the thing.',
            trajectory: [],
          },
          'run-B': {
            id: 'run-B',
            agentName: 'agent-beta',
            modelName: 'claude-3-5-sonnet',
            passFailStatus: 'failed',
            metrics: { accuracy: 30 },
            testCaseId: 'tc-1',
            llmJudgeReasoning: 'Beta forgot the thing.',
            trajectory: [],
          },
        };
        return Promise.resolve(map[id] ?? null);
      });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'compare',
          'Which tests passed for which agent?',
          {
            currentUrl: '/compare/bench-X?runs=run-A,run-B',
            benchmarkId: 'bench-X',
            comparisonRunIds: ['run-A', 'run-B'],
          },
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
      mockProc.emit('close', 0);
      await turn;

      const args: string[] = mockSpawn.mock.calls[0][1];
      const idx = args.indexOf('--append-system-prompt');
      const sysPrompt = args[idx + 1];

      expect(sysPrompt).toContain('Comparison Runs (2 of 2)');
      expect(sysPrompt).toContain('run-A');
      expect(sysPrompt).toContain('run-B');
      expect(sysPrompt).toContain('agent-alpha');
      expect(sysPrompt).toContain('agent-beta');
      expect(sysPrompt).toContain('Beta forgot the thing.');
      expect(mockGetReportById).toHaveBeenCalledWith('run-A');
      expect(mockGetReportById).toHaveBeenCalledWith('run-B');
    });

    it('inherits AWS_PROFILE / AWS_REGION', async () => {
      const original = { profile: process.env.AWS_PROFILE, region: process.env.AWS_REGION };
      process.env.AWS_PROFILE = 'test-profile';
      process.env.AWS_REGION = 'us-west-2';

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      try {
        const turn = new Promise<void>((resolve, reject) => {
          assistantService.streamAssistantResponse(
            'aws',
            'Hi',
            undefined,
            () => {},
            () => resolve(),
            (err: string) => reject(new Error(err))
          );
        });
        await flushAsync();
        mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
        mockProc.emit('close', 0);
        await turn;

        const env = mockSpawn.mock.calls[0][2].env;
        expect(env.AWS_PROFILE).toBe('test-profile');
        expect(env.AWS_REGION).toBe('us-west-2');
      } finally {
        process.env.AWS_PROFILE = original.profile;
        process.env.AWS_REGION = original.region;
      }
    });

    it('inlines run snapshot from storage into system prompt when runId is provided', async () => {
      mockGetReportById.mockResolvedValue({
        id: 'run-123',
        status: 'completed',
        passFailStatus: 'failed',
        metrics: { accuracy: 20 },
        agentName: 'Claude Code',
        modelName: 'claude-opus-4-7',
        testCaseId: 'tc-abc',
        llmJudgeReasoning: 'The agent did not produce a final response.',
        improvementStrategies: [],
        trajectory: [{ type: 'thinking', content: 'reasoning step' } as any],
      });
      mockGetTestCaseById.mockResolvedValue({
        id: 'tc-abc',
        name: 'Investigate ticket',
        description: 'desc',
        labels: ['category:RCA'],
        currentVersion: 3,
        initialPrompt: 'do the thing',
        versions: [{ expectedOutcomes: 'final response with next steps' } as any],
      });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'snap',
          'Why did this fail?',
          { runId: 'run-123', currentUrl: '/runs/run-123' },
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
      mockProc.emit('close', 0);
      await turn;

      const args: string[] = mockSpawn.mock.calls[0][1];
      const idx = args.indexOf('--append-system-prompt');
      const sysPrompt = args[idx + 1];

      expect(sysPrompt).toContain('Live Data Snapshot');
      expect(sysPrompt).toContain('run-123');
      expect(sysPrompt).toContain('did not produce a final response');
      expect(sysPrompt).toContain('Investigate ticket');
      expect(sysPrompt).toContain('expectedOutcomes');
      expect(mockGetReportById).toHaveBeenCalledWith('run-123');
      // Test case fetched via run.testCaseId fallback
      expect(mockGetTestCaseById).toHaveBeenCalledWith('tc-abc');
    });

    it('reassembles partial NDJSON lines across data chunks', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const deltas: string[] = [];
      assistantService.streamAssistantResponse(
        'partial',
        'Hi',
        undefined,
        (d: string) => deltas.push(d),
        () => {
          expect(deltas).toEqual(['chunk1']);
          done();
        },
        (err: string) => done(new Error(err))
      );

      flushAsync().then(() => {
        const line = assistantTextLine('chunk1');
        // Split mid-line
        mockProc.stdout.emit('data', Buffer.from(line.slice(0, 30)));
        mockProc.stdout.emit('data', Buffer.from(line.slice(30)));
        mockProc.emit('close', 0);
      });
    });

    it('calls onError on non-zero exit', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'err',
        'Hi',
        undefined,
        () => {},
        () => done(new Error('should not call onDone')),
        (err: string) => {
          expect(err).toContain('boom');
          done();
        }
      );

      flushAsync().then(() => {
        mockProc.stderr.emit('data', Buffer.from('boom'));
        mockProc.emit('close', 1);
      });
    });

    it('reports ENOENT clearly', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'enoent',
        'Hi',
        undefined,
        () => {},
        () => done(new Error('should not call onDone')),
        (err: string) => {
          expect(err).toContain('not found');
          done();
        }
      );

      flushAsync().then(() => {
        const e = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        mockProc.emit('error', e);
      });
    });
  });

  describe('session management', () => {
    it('stores user + assistant messages in session', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'msgs',
          'Test message',
          undefined,
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      mockProc.stdout.emit('data', Buffer.from(assistantTextLine('Response')));
      mockProc.emit('close', 0);
      await turn;

      const messages = assistantService.getSessionMessages('msgs');
      expect(messages.length).toBe(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Test message' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Response' });
    });

    it('clearSession removes session data', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);
      assistantService = require('@/server/services/assistantService');

      const turn = new Promise<void>((resolve, reject) => {
        assistantService.streamAssistantResponse(
          'clr',
          'Hi',
          undefined,
          () => {},
          () => resolve(),
          (err: string) => reject(new Error(err))
        );
      });
      await flushAsync();
      mockProc.stdout.emit('data', Buffer.from(assistantTextLine('ok')));
      mockProc.emit('close', 0);
      await turn;

      expect(assistantService.getSessionMessages('clr').length).toBeGreaterThan(0);
      assistantService.clearSession('clr');
      expect(assistantService.getSessionMessages('clr')).toEqual([]);
    });

    it('clearSession on unknown session is a no-op', () => {
      assistantService = require('@/server/services/assistantService');
      expect(() => assistantService.clearSession('nope')).not.toThrow();
    });

    it('getSessionMessages returns [] for unknown session', () => {
      assistantService = require('@/server/services/assistantService');
      expect(assistantService.getSessionMessages('nope')).toEqual([]);
    });
  });

  describe('buildSystemPrompt', () => {
    it('includes skill content', () => {
      assistantService = require('@/server/services/assistantService');
      const prompt = assistantService.buildSystemPrompt();
      expect(prompt).toContain('Agent Health');
    });

    it('includes context fields when provided', () => {
      assistantService = require('@/server/services/assistantService');
      const prompt = assistantService.buildSystemPrompt({
        currentUrl: '/benchmarks/bench-1',
        benchmarkId: 'bench-1',
      });
      expect(prompt).toContain('bench-1');
      expect(prompt).toContain('/benchmarks/bench-1');
    });

    it('renders comparison run IDs in the page-context section', () => {
      assistantService = require('@/server/services/assistantService');
      const prompt = assistantService.buildSystemPrompt({
        currentUrl: '/compare/bench-X?runs=a,b',
        benchmarkId: 'bench-X',
        comparisonRunIds: ['run-a', 'run-b'],
      });
      expect(prompt).toContain('Comparison run IDs: run-a, run-b');
    });

    it('toolsAvailable=true advertises tool access; default forbids tools', () => {
      assistantService = require('@/server/services/assistantService');
      const noTools = assistantService.buildSystemPrompt(undefined, false);
      expect(noTools).toMatch(/NO tool access/);
      const withTools = assistantService.buildSystemPrompt(undefined, true);
      expect(withTools).toMatch(/full tool access|chrome-devtools/i);
      expect(withTools).not.toMatch(/NO tool access/);
    });
  });
});
