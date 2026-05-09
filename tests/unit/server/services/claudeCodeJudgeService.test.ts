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

// Mock fs.readFileSync for AGENT_HEALTH.md loading
const mockReadFileSync = jest.fn();
jest.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}));

// Mock path.resolve
jest.mock('path', () => ({
  resolve: jest.fn((...args: string[]) => args.join('/')),
}));

// Mock bedrockService helpers
jest.mock('@/server/services/bedrockService', () => ({
  buildEvaluationPrompt: jest.fn().mockReturnValue('mock evaluation prompt'),
}));

// Mock judgePrompt
jest.mock('@/server/prompts/judgePrompt', () => ({
  JUDGE_SYSTEM_PROMPT: 'You are an expert evaluator.',
}));

// Mock debug
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

import { evaluateWithClaudeCode, parseClaudeCodeError, loadSkillContent, buildSystemPrompt } from '@/server/services/claudeCodeJudgeService';
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

  // Store the event handlers so tests can trigger them
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
  accuracy: 85,
  reasoning: 'The agent correctly identified the root cause.',
  improvement_strategies: [
    {
      category: 'Analysis Depth',
      issue: 'Could provide more detail',
      recommendation: 'Include metric evidence',
      priority: 'low',
    },
  ],
};

describe('evaluateWithClaudeCode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env = { ...originalEnv, AWS_PROFILE: 'TestProfile', AWS_REGION: 'us-east-1' };
    mockReadFileSync.mockReturnValue('# Agent Health Skill Content');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should parse bare JSON response from claude CLI', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    // Simulate claude CLI output: JSON wrapper with result field
    const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    const result = await promise;

    expect(result.passFailStatus).toBe('passed');
    expect(result.metrics.accuracy).toBe(85);
    expect(result.llmJudgeReasoning).toBe('The agent correctly identified the root cause.');
    expect(result.improvementStrategies).toHaveLength(1);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('should parse markdown-wrapped JSON response', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    // Claude returns text with markdown code block
    const markdownWrapped = 'Here is the evaluation:\n```json\n' + JSON.stringify(mockJudgeResult) + '\n```\nEnd.';
    const cliOutput = JSON.stringify({ result: markdownWrapped });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    const result = await promise;

    expect(result.passFailStatus).toBe('passed');
    expect(result.metrics.accuracy).toBe(85);
  });

  it('should handle non-zero exit code', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    proc.stderr.emit('data', Buffer.from('Authentication failed'));
    handlers.close(1);

    await expect(promise).rejects.toThrow('Authentication failed');
  });

  it('should handle non-zero exit code with no stderr', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);
    handlers.close(42);

    await expect(promise).rejects.toThrow('Claude CLI exited with code 42');
  });

  it('should handle timeout (process killed)', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    proc.stderr.emit('data', Buffer.from('Process timed out'));
    handlers.close(1);

    await expect(promise).rejects.toThrow('Process timed out');
  });

  it('should handle invalid JSON in response', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    // Return non-JSON output
    const cliOutput = JSON.stringify({ result: 'This is not valid JSON at all' });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    await expect(promise).rejects.toThrow();
  });

  it('should handle command not found (ENOENT)', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    const error = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    handlers.error(error);

    await expect(promise).rejects.toThrow('Claude CLI not found');
  });

  it('should pass AWS_PROFILE to child process environment', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    // Return valid response
    const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    await promise;

    // Check that spawn was called with correct env
    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.AWS_PROFILE).toBe('TestProfile');
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('should pass correct CLI args', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    await promise;

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[0]).toBe('claude');
    const args = spawnCall[1];
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--append-system-prompt');
  });

  it('should write prompt to stdin and close it', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    const cliOutput = JSON.stringify({ result: JSON.stringify(mockJudgeResult) });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    await promise;

    expect(proc.stdin.write).toHaveBeenCalledWith('mock evaluation prompt');
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it('should handle array content blocks in response', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    // Claude returns array of content blocks
    const arrayOutput = JSON.stringify([
      { type: 'text', text: JSON.stringify(mockJudgeResult) },
    ]);
    proc.stdout.emit('data', Buffer.from(arrayOutput));
    handlers.close(0);

    const result = await promise;
    expect(result.passFailStatus).toBe('passed');
  });

  it('should handle NDJSON array format from --output-format json', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    // Real Claude CLI --output-format json returns an array with system, assistant, and result objects
    const ndjsonOutput = JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'test-session' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: JSON.stringify(mockJudgeResult) }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify(mockJudgeResult),
        duration_ms: 5000,
      },
    ]);
    proc.stdout.emit('data', Buffer.from(ndjsonOutput));
    handlers.close(0);

    const result = await promise;
    expect(result.passFailStatus).toBe('passed');
    expect(result.metrics.accuracy).toBe(85);
  });

  it('should fall back to assistant message when result object has no result field', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    const ndjsonOutput = JSON.stringify([
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: JSON.stringify(mockJudgeResult) }],
        },
      },
      { type: 'result', subtype: 'success' },
    ]);
    proc.stdout.emit('data', Buffer.from(ndjsonOutput));
    handlers.close(0);

    const result = await promise;
    expect(result.passFailStatus).toBe('passed');
  });

  it('should handle accuracy in metrics sub-object (legacy format)', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const legacyResult = {
      pass_fail_status: 'failed',
      metrics: { accuracy: 45, faithfulness: 50 },
      reasoning: 'Poor performance',
      improvement_strategies: [],
    };

    const promise = evaluateWithClaudeCode(baseRequest);

    const cliOutput = JSON.stringify({ result: JSON.stringify(legacyResult) });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    const result = await promise;
    expect(result.passFailStatus).toBe('failed');
    expect(result.metrics.accuracy).toBe(45);
    expect(result.metrics.faithfulness).toBe(50);
  });

  it('should handle generic spawn errors', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = evaluateWithClaudeCode(baseRequest);

    handlers.error(new Error('Spawn failed'));

    await expect(promise).rejects.toThrow('Spawn failed');
  });

  it('should default passFailStatus to failed when missing', async () => {
    const { proc, handlers } = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const incompleteResult = {
      accuracy: 30,
      reasoning: 'Incomplete',
      improvement_strategies: [],
    };

    const promise = evaluateWithClaudeCode(baseRequest);

    const cliOutput = JSON.stringify({ result: JSON.stringify(incompleteResult) });
    proc.stdout.emit('data', Buffer.from(cliOutput));
    handlers.close(0);

    const result = await promise;
    expect(result.passFailStatus).toBe('failed');
  });
});

describe('loadSkillContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return file content when AGENT_HEALTH.md exists', () => {
    mockReadFileSync.mockReturnValue('# Skill Content');
    const result = loadSkillContent();
    expect(result).toBe('# Skill Content');
  });

  it('should return empty string when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = loadSkillContent();
    expect(result).toBe('');
  });
});

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should include skill content when available', () => {
    mockReadFileSync.mockReturnValue('# Skill Content');
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('You are an expert evaluator.');
    expect(prompt).toContain('Agent Health Reference');
    expect(prompt).toContain('# Skill Content');
  });

  it('should return base prompt when skill file is missing', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const prompt = buildSystemPrompt();
    expect(prompt).toBe('You are an expert evaluator.');
    expect(prompt).not.toContain('Agent Health Reference');
  });
});

describe('parseClaudeCodeError', () => {
  it('should detect ENOENT (command not found)', () => {
    const result = parseClaudeCodeError(new Error('spawn claude ENOENT'));
    expect(result).toContain('Claude CLI not found');
  });

  it('should detect "not found" in message', () => {
    const result = parseClaudeCodeError(new Error('Claude CLI not found'));
    expect(result).toContain('Claude CLI not found');
  });

  it('should detect expired AWS credentials', () => {
    const result = parseClaudeCodeError(new Error('ExpiredToken: The security token is expired'));
    expect(result).toContain('AWS credentials expired');
  });

  it('should detect CredentialsProviderError', () => {
    const result = parseClaudeCodeError(new Error('CredentialsProviderError'));
    expect(result).toContain('AWS credentials expired');
  });

  it('should detect timeout errors', () => {
    const result = parseClaudeCodeError(new Error('Process timed out'));
    expect(result).toContain('timed out');
  });

  it('should detect ETIMEDOUT', () => {
    const result = parseClaudeCodeError(new Error('ETIMEDOUT'));
    expect(result).toContain('timed out');
  });

  it('should detect SIGTERM (killed)', () => {
    const result = parseClaudeCodeError(new Error('SIGTERM'));
    expect(result).toContain('timed out');
  });

  it('should detect JSON parse errors', () => {
    const result = parseClaudeCodeError(new Error('Unexpected token in JSON'));
    expect(result).toContain('Failed to parse');
  });

  it('should detect exit code errors', () => {
    const result = parseClaudeCodeError(new Error('Claude CLI exited with code 1'));
    expect(result).toContain('Claude Code CLI failed');
  });

  it('should return original message for unknown errors', () => {
    const result = parseClaudeCodeError(new Error('Something unexpected'));
    expect(result).toBe('Something unexpected');
  });

  it('should return "Unknown error occurred" for empty message', () => {
    const result = parseClaudeCodeError(new Error(''));
    expect(result).toBe('Unknown error occurred');
  });
});
