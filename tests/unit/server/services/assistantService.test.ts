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
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdin = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

describe('AssistantService', () => {
  let assistantService: typeof import('@/server/services/assistantService');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Make claude available by default
    mockExecSync.mockReturnValue('claude version 1.0.0');
  });

  describe('isClaudeAvailable', () => {
    it('should return true when claude CLI is found', () => {
      mockExecSync.mockReturnValue('claude version 1.0.0');
      assistantService = require('@/server/services/assistantService');
      const result = assistantService.isClaudeAvailable();
      expect(result).toBe(true);
    });

    it('should return false when claude CLI is not found', () => {
      mockExecSync.mockImplementation(() => { throw new Error('command not found'); });
      assistantService = require('@/server/services/assistantService');
      const result = assistantService.isClaudeAvailable();
      expect(result).toBe(false);
    });
  });

  describe('streamAssistantResponse', () => {
    it('should stream NDJSON deltas from claude CLI', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      const deltas: string[] = [];

      assistantService.streamAssistantResponse(
        'test-session',
        'Hello',
        {},
        (delta: string) => deltas.push(delta),
        (full: string) => {
          expect(deltas).toContain('Hello');
          expect(deltas).toContain(' world');
          expect(full).toContain('Hello');
          done();
        },
        (err: string) => done(new Error(err))
      );

      // Simulate NDJSON output
      mockProc.stdout.emit('data', Buffer.from(
        '{"type":"assistant","subtype":"text","content":"Hello"}\n' +
        '{"type":"assistant","subtype":"text","content":" world"}\n'
      ));
      mockProc.emit('close', 0);
    });

    it('should store messages in session', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'session-store',
        'Test message',
        undefined,
        () => {},
        () => {
          const messages = assistantService.getSessionMessages('session-store');
          expect(messages).toBeDefined();
          expect(messages.length).toBeGreaterThanOrEqual(2);
          // First non-system message should be the user message
          const userMsg = messages.find((m: any) => m.role === 'user');
          expect(userMsg).toBeDefined();
          expect(userMsg!.content).toBe('Test message');
          done();
        },
        (err: string) => done(new Error(err))
      );

      mockProc.stdout.emit('data', Buffer.from(
        '{"type":"assistant","subtype":"text","content":"Response"}\n'
      ));
      mockProc.emit('close', 0);
    });

    it('should call onError when process exits with non-zero code', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'error-session',
        'Hello',
        undefined,
        () => {},
        () => done(new Error('Should not call onDone')),
        (err: string) => {
          expect(err).toContain('error');
          done();
        }
      );

      mockProc.stderr.emit('data', Buffer.from('Some error occurred'));
      mockProc.emit('close', 1);
    });

    it('should call onError when process emits ENOENT', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'enoent-session',
        'Hello',
        undefined,
        () => {},
        () => done(new Error('Should not call onDone')),
        (err: string) => {
          expect(err).toContain('not found');
          done();
        }
      );

      const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockProc.emit('error', error);
    });

    it('should inherit AWS_PROFILE from environment', (done) => {
      const originalProfile = process.env.AWS_PROFILE;
      const originalRegion = process.env.AWS_REGION;
      process.env.AWS_PROFILE = 'test-profile';
      process.env.AWS_REGION = 'us-west-2';

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'aws-session',
        'Hello',
        undefined,
        () => {},
        () => {
          const spawnCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
          expect(spawnCall[2].env.AWS_PROFILE).toBe('test-profile');
          expect(spawnCall[2].env.AWS_REGION).toBe('us-west-2');

          process.env.AWS_PROFILE = originalProfile;
          process.env.AWS_REGION = originalRegion;
          done();
        },
        (err: string) => { process.env.AWS_PROFILE = originalProfile; process.env.AWS_REGION = originalRegion; done(new Error(err)); }
      );

      mockProc.stdout.emit('data', Buffer.from('{"type":"assistant","subtype":"text","content":"ok"}\n'));
      mockProc.emit('close', 0);
    });

    it('should include system prompt with AGENT_HEALTH.md content', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'prompt-session',
        'Hello',
        undefined,
        () => {},
        () => {
          const spawnCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
          const args: string[] = spawnCall[1];
          expect(args).toContain('--append-system-prompt');
          const sysPromptIdx = args.indexOf('--append-system-prompt');
          expect(args[sysPromptIdx + 1]).toContain('Agent Health');
          done();
        },
        (err: string) => done(new Error(err))
      );

      mockProc.stdout.emit('data', Buffer.from('{"type":"assistant","subtype":"text","content":"ok"}\n'));
      mockProc.emit('close', 0);
    });

    it('should handle partial NDJSON lines correctly', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      const deltas: string[] = [];

      assistantService.streamAssistantResponse(
        'partial-session',
        'Hello',
        undefined,
        (delta: string) => deltas.push(delta),
        () => {
          expect(deltas).toContain('chunk1');
          done();
        },
        (err: string) => done(new Error(err))
      );

      // Send partial line, then complete it
      mockProc.stdout.emit('data', Buffer.from('{"type":"assistant","subtype":"tex'));
      mockProc.stdout.emit('data', Buffer.from('t","content":"chunk1"}\n'));
      mockProc.emit('close', 0);
    });

    it('should include page context in system prompt', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'context-session',
        'What is this benchmark?',
        { currentUrl: '/benchmarks/bench-123', benchmarkId: 'bench-123' },
        () => {},
        () => {
          const spawnCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
          const args: string[] = spawnCall[1];
          const sysPromptIdx = args.indexOf('--append-system-prompt');
          if (sysPromptIdx > -1) {
            const systemPrompt = args[sysPromptIdx + 1];
            expect(systemPrompt).toContain('bench-123');
          }
          done();
        },
        (err: string) => done(new Error(err))
      );

      mockProc.stdout.emit('data', Buffer.from('{"type":"assistant","subtype":"text","content":"ok"}\n'));
      mockProc.emit('close', 0);
    });
  });

  describe('clearSession', () => {
    it('should remove session data', (done) => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      assistantService = require('@/server/services/assistantService');

      assistantService.streamAssistantResponse(
        'clear-session',
        'Hello',
        undefined,
        () => {},
        () => {
          const before = assistantService.getSessionMessages('clear-session');
          expect(before.length).toBeGreaterThan(0);

          assistantService.clearSession('clear-session');
          const after = assistantService.getSessionMessages('clear-session');
          expect(after.length).toBe(0);
          done();
        },
        (err: string) => done(new Error(err))
      );

      mockProc.stdout.emit('data', Buffer.from('{"type":"assistant","subtype":"text","content":"ok"}\n'));
      mockProc.emit('close', 0);
    });

    it('should not throw when clearing non-existent session', () => {
      assistantService = require('@/server/services/assistantService');
      expect(() => assistantService.clearSession('nonexistent')).not.toThrow();
    });
  });

  describe('getSessionMessages', () => {
    it('should return empty array for unknown session', () => {
      assistantService = require('@/server/services/assistantService');
      expect(assistantService.getSessionMessages('unknown')).toEqual([]);
    });
  });

  describe('buildSystemPrompt', () => {
    it('should include skill content', () => {
      assistantService = require('@/server/services/assistantService');
      const prompt = assistantService.buildSystemPrompt();
      expect(prompt).toContain('Agent Health');
    });

    it('should include context when provided', () => {
      assistantService = require('@/server/services/assistantService');
      const prompt = assistantService.buildSystemPrompt({
        currentUrl: '/benchmarks/bench-1',
        benchmarkId: 'bench-1',
      });
      expect(prompt).toContain('bench-1');
      expect(prompt).toContain('/benchmarks/bench-1');
    });
  });
});
