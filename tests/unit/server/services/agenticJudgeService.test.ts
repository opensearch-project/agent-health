/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ---- All jest.mock calls must be before imports (Jest hoists them) ----

import { EventEmitter } from 'events';

// Mock child_process.spawn
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// Mock bedrockService helpers
jest.mock('@/server/services/bedrockService', () => ({
  buildEvaluationPrompt: jest.fn().mockReturnValue('mock evaluation prompt'),
}));

// Mock judgePrompt
jest.mock('@/server/prompts/judgePrompt', () => ({
  JUDGE_SYSTEM_PROMPT: 'You are an expert evaluator.',
}));

// Mock claudeCodeJudgeService (for loadSkillContent)
jest.mock('@/server/services/claudeCodeJudgeService', () => ({
  loadSkillContent: jest.fn().mockReturnValue('# Agent Health Skill Content'),
}));

// Mock debug
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

// Mock fetch for custom endpoint tests
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { evaluateWithAgenticJudge, parseAgenticJudgeError } from '@/server/services/agenticJudgeService';
import { TrajectoryStep } from '@/types';

// Helper to create a mock child process
function createMockProcess() {
  const proc = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
    },
    on: jest.fn(),
  };

  const handlers: Record<string, Function> = {};
  proc.on.mockImplementation((event: string, handler: Function) => {
    handlers[event] = handler;
    return proc;
  });

  return { proc, handlers };
}

const baseRequest = {
  trajectory: [{ type: 'response' as const, content: 'Root cause: memory leak' } as TrajectoryStep],
  expectedOutcomes: ['Agent identifies root cause'],
};

const mockJudgeResult = {
  pass_fail_status: 'passed',
  accuracy: 92,
  reasoning: 'The agentic judge verified the root cause through tool inspection.',
  improvement_strategies: [
    {
      category: 'Verification',
      issue: 'Could cross-reference more data',
      recommendation: 'Check additional logs',
      priority: 'low',
    },
  ],
};

describe('evaluateWithAgenticJudge', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env = { ...originalEnv, AWS_PROFILE: 'TestProfile', AWS_REGION: 'us-east-1' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  describe('claude-code backend (default)', () => {
    it('should evaluate trajectory and return structured response', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
      proc.stdout.emit('data', Buffer.from(cliOutput));
      handlers.close(0);

      const result = await promise;

      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(92);
      expect(result.llmJudgeReasoning).toContain('agentic judge verified');
      expect(result.improvementStrategies).toHaveLength(1);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should use claude-code backend by default', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
      proc.stdout.emit('data', Buffer.from(cliOutput));
      handlers.close(0);

      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object));
    });

    it('should include agentic addendum in system prompt', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
      proc.stdout.emit('data', Buffer.from(cliOutput));
      handlers.close(0);

      await promise;

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1];
      const systemPromptIdx = args.indexOf('--append-system-prompt');
      const systemPrompt = args[systemPromptIdx + 1];
      expect(systemPrompt).toContain('Agentic Evaluation Mode');
      expect(systemPrompt).toContain('Use tools');
    });

    it('should pass AWS env vars to child process', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
      proc.stdout.emit('data', Buffer.from(cliOutput));
      handlers.close(0);

      await promise;

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;
      expect(env.AWS_PROFILE).toBe('TestProfile');
      expect(env.AWS_REGION).toBe('us-east-1');
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    });

    it('should handle ENOENT (claude not found)', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const error = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      handlers.error(error);

      await expect(promise).rejects.toThrow('Claude CLI not found');
    });

    it('should handle non-zero exit code', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      proc.stderr.emit('data', Buffer.from('Authentication failed'));
      handlers.close(1);

      await expect(promise).rejects.toThrow('Authentication failed');
    });

    it('should handle markdown-wrapped JSON response', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const markdownWrapped = 'Here is the evaluation:\n```json\n' + JSON.stringify(mockJudgeResult) + '\n```\nEnd.';
      const cliOutput = JSON.stringify({ result: markdownWrapped });
      proc.stdout.emit('data', Buffer.from(cliOutput));
      handlers.close(0);

      const result = await promise;
      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(92);
    });

    it('should handle NDJSON array format', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const ndjsonOutput = JSON.stringify([
        { type: 'system', subtype: 'init' },
        { type: 'result', subtype: 'success', result: JSON.stringify(mockJudgeResult) },
      ]);
      proc.stdout.emit('data', Buffer.from(ndjsonOutput));
      handlers.close(0);

      const result = await promise;
      expect(result.passFailStatus).toBe('passed');
    });

    it('should default passFailStatus to failed when missing', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = evaluateWithAgenticJudge(baseRequest);

      const incompleteResult = { accuracy: 30, reasoning: 'Incomplete', improvement_strategies: [] };
      const cliOutput = JSON.stringify({ result: JSON.stringify(incompleteResult) });
      proc.stdout.emit('data', Buffer.from(cliOutput));
      handlers.close(0);

      const result = await promise;
      expect(result.passFailStatus).toBe('failed');
    });
  });

  describe('custom endpoint backend', () => {
    it('should call custom endpoint with judge request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          passFailStatus: 'passed',
          metrics: { accuracy: 88 },
          llmJudgeReasoning: 'Custom judge reasoning',
          improvementStrategies: [],
        }),
      });

      const result = await evaluateWithAgenticJudge(baseRequest, {
        backend: 'custom',
        endpoint: 'http://localhost:9000/judge',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9000/judge',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(88);
    });

    it('should pass custom headers to endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          passFailStatus: 'passed',
          metrics: { accuracy: 75 },
          llmJudgeReasoning: 'OK',
          improvementStrategies: [],
        }),
      });

      await evaluateWithAgenticJudge(baseRequest, {
        backend: 'custom',
        endpoint: 'http://localhost:9000/judge',
        headers: { 'Authorization': 'Bearer test-token' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9000/judge',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should include system prompt in request body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          passFailStatus: 'passed',
          metrics: { accuracy: 80 },
          llmJudgeReasoning: 'OK',
          improvementStrategies: [],
        }),
      });

      await evaluateWithAgenticJudge(baseRequest, {
        backend: 'custom',
        endpoint: 'http://localhost:9000/judge',
      });

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.systemPrompt).toContain('Agentic Evaluation Mode');
      expect(fetchBody.trajectory).toEqual(baseRequest.trajectory);
      expect(fetchBody.expectedOutcomes).toEqual(baseRequest.expectedOutcomes);
    });

    it('should throw on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      await expect(
        evaluateWithAgenticJudge(baseRequest, {
          backend: 'custom',
          endpoint: 'http://localhost:9000/judge',
        })
      ).rejects.toThrow('Custom agentic judge returned 500');
    });

    it('should handle raw string response from custom endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: JSON.stringify(mockJudgeResult),
        }),
      });

      const result = await evaluateWithAgenticJudge(baseRequest, {
        backend: 'custom',
        endpoint: 'http://localhost:9000/judge',
      });

      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(92);
    });

    it('should fall back to claude-code when no endpoint provided', async () => {
      const { proc, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      // custom backend without endpoint falls through to claude-code
      const promise = evaluateWithAgenticJudge(baseRequest, {
        backend: 'custom',
        endpoint: undefined,
      });

      const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
      proc.stdout.emit('data', Buffer.from(cliOutput));
      handlers.close(0);

      const result = await promise;
      expect(result.passFailStatus).toBe('passed');
      expect(mockSpawn).toHaveBeenCalled();
    });
  });
});

describe('parseAgenticJudgeError', () => {
  it('should detect ENOENT (command not found)', () => {
    const result = parseAgenticJudgeError(new Error('spawn claude ENOENT'));
    expect(result).toContain('Claude CLI not found');
  });

  it('should detect expired credentials', () => {
    const result = parseAgenticJudgeError(new Error('ExpiredToken'));
    expect(result).toContain('AWS credentials expired');
  });

  it('should detect CredentialsProviderError', () => {
    const result = parseAgenticJudgeError(new Error('CredentialsProviderError'));
    expect(result).toContain('AWS credentials expired');
  });

  it('should detect timeout (ETIMEDOUT)', () => {
    const result = parseAgenticJudgeError(new Error('ETIMEDOUT'));
    expect(result).toContain('timed out');
  });

  it('should detect timeout (SIGTERM)', () => {
    const result = parseAgenticJudgeError(new Error('SIGTERM'));
    expect(result).toContain('timed out');
  });

  it('should preserve custom endpoint error messages', () => {
    const result = parseAgenticJudgeError(new Error('Custom agentic judge returned 503: Service unavailable'));
    expect(result).toContain('Custom agentic judge returned 503');
  });

  it('should detect JSON parse errors', () => {
    const result = parseAgenticJudgeError(new Error('Unexpected token in JSON'));
    expect(result).toContain('Failed to parse');
  });

  it('should return original message for unknown errors', () => {
    const result = parseAgenticJudgeError(new Error('Something unexpected'));
    expect(result).toBe('Something unexpected');
  });

  it('should return fallback for empty message', () => {
    const result = parseAgenticJudgeError(new Error(''));
    expect(result).toBe('Unknown agentic judge error');
  });
});
