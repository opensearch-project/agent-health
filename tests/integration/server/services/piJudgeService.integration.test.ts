/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for Pi Judge Service
 *
 * Mocks child_process.spawn to simulate the pi CLI process lifecycle,
 * testing JSON extraction, NDJSON parsing, error handling, and the full
 * evaluateWithPi flow.
 */

import { EventEmitter } from 'events';
import { Writable, Readable } from 'stream';

// Mock child_process.spawn before importing the service
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Mock debug to avoid noise
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

import { evaluateWithPi, parsePiError } from '@/server/services/piJudgeService';
import { TrajectoryStep } from '@/types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock child process that emits events like a real spawned process.
 */
function createMockChildProcess() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  // Attach an error handler so stdin.on('error') doesn't throw
  child.stdin.on('error', () => {});
  return child;
}

/** Sample trajectory for requests */
const sampleTrajectory: TrajectoryStep[] = [
  {
    id: 'step-1',
    timestamp: Date.now(),
    type: 'action',
    content: 'Checking cluster health',
    toolName: 'opensearch_cluster_health',
    toolArgs: {},
  },
  {
    id: 'step-2',
    timestamp: Date.now(),
    type: 'tool_result',
    content: '{"status": "red", "unassigned_shards": 5}',
    status: 'SUCCESS' as any,
  },
  {
    id: 'step-3',
    timestamp: Date.now(),
    type: 'response',
    content: 'Root cause: The cluster is red due to 5 unassigned shards.',
  },
];

const sampleExpectedOutcomes = [
  'Agent checks cluster health',
  'Agent identifies unassigned shards',
];

// ============================================================================
// Tests: evaluateWithPi
// ============================================================================

describe('Pi Judge Service - evaluateWithPi', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should parse a bare JSON response from pi stdout', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      pass_fail_status: 'passed',
      accuracy: 85,
      metrics: {
        faithfulness: 90,
        latency_score: 80,
        trajectory_alignment_score: 88,
      },
      reasoning: 'Agent correctly identified the root cause.',
      improvement_strategies: [
        { priority: 'low', suggestion: 'Could check shard allocation explain API.' },
      ],
    };

    // The pi CLI outputs a { result: "..." } JSON wrapper
    const piOutput = JSON.stringify({ result: JSON.stringify(judgeResult) });

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    // Simulate pi process output
    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(piOutput));
      mockChild.emit('close', 0);
    });

    const response = await promise;

    expect(response.passFailStatus).toBe('passed');
    expect(response.metrics.accuracy).toBe(85);
    expect(response.metrics.faithfulness).toBe(90);
    expect(response.metrics.latency_score).toBe(80);
    expect(response.metrics.trajectory_alignment_score).toBe(88);
    expect(response.llmJudgeReasoning).toBe('Agent correctly identified the root cause.');
    expect(response.improvementStrategies).toHaveLength(1);
    expect(typeof response.duration).toBe('number');
    expect(response.duration).toBeGreaterThanOrEqual(0);
  });

  it('should extract JSON from markdown code blocks', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      pass_fail_status: 'failed',
      accuracy: 30,
      metrics: { faithfulness: 40 },
      reasoning: 'Agent did not use diagnostic tools.',
      improvement_strategies: [],
    };

    // Pi sometimes wraps result in markdown code blocks
    const piOutput = JSON.stringify({
      result: '```json\n' + JSON.stringify(judgeResult) + '\n```',
    });

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(piOutput));
      mockChild.emit('close', 0);
    });

    const response = await promise;

    expect(response.passFailStatus).toBe('failed');
    expect(response.metrics.accuracy).toBe(30);
    expect(response.metrics.faithfulness).toBe(40);
    expect(response.llmJudgeReasoning).toBe('Agent did not use diagnostic tools.');
    expect(response.improvementStrategies).toEqual([]);
  });

  it('should handle NDJSON array response with result object', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      pass_fail_status: 'passed',
      accuracy: 95,
      metrics: { faithfulness: 92 },
      reasoning: 'Excellent trajectory.',
      improvement_strategies: [],
    };

    const ndjsonArray = JSON.stringify([
      { type: 'thinking', content: 'Evaluating...' },
      { type: 'result', result: JSON.stringify(judgeResult) },
    ]);

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(ndjsonArray));
      mockChild.emit('close', 0);
    });

    const response = await promise;

    expect(response.passFailStatus).toBe('passed');
    expect(response.metrics.accuracy).toBe(95);
  });

  it('should handle NDJSON array response with assistant object (fallback)', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      pass_fail_status: 'passed',
      accuracy: 75,
      metrics: {},
      reasoning: 'Decent performance.',
      improvement_strategies: [],
    };

    const ndjsonArray = JSON.stringify([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: JSON.stringify(judgeResult) },
          ],
        },
      },
    ]);

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(ndjsonArray));
      mockChild.emit('close', 0);
    });

    const response = await promise;

    expect(response.passFailStatus).toBe('passed');
    expect(response.metrics.accuracy).toBe(75);
  });

  it('should handle result as an object (not string)', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      pass_fail_status: 'passed',
      accuracy: 60,
      metrics: { faithfulness: 70 },
      reasoning: 'Ok.',
      improvement_strategies: [],
    };

    // result is already an object, not a string
    const piOutput = JSON.stringify({ result: judgeResult });

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(piOutput));
      mockChild.emit('close', 0);
    });

    const response = await promise;

    expect(response.passFailStatus).toBe('passed');
    expect(response.metrics.accuracy).toBe(60);
  });

  it('should default passFailStatus to failed when missing', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      accuracy: 50,
      metrics: {},
      reasoning: 'No explicit pass/fail.',
      improvement_strategies: [],
    };

    const piOutput = JSON.stringify({ result: JSON.stringify(judgeResult) });

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(piOutput));
      mockChild.emit('close', 0);
    });

    const response = await promise;

    expect(response.passFailStatus).toBe('failed');
  });

  it('should use metrics.accuracy when top-level accuracy is missing', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      pass_fail_status: 'passed',
      metrics: { accuracy: 77, faithfulness: 80 },
      reasoning: 'Good.',
      improvement_strategies: [],
    };

    const piOutput = JSON.stringify({ result: JSON.stringify(judgeResult) });

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(piOutput));
      mockChild.emit('close', 0);
    });

    const response = await promise;

    expect(response.metrics.accuracy).toBe(77);
  });

  it('should reject when pi process emits ENOENT error', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      const error = new Error('spawn pi ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockChild.emit('error', error);
    });

    // Assert the stable part of the message; the ENOENT branch returns a richer
    // hint (optionalDependency reinstall guidance) that we don't pin verbatim.
    await expect(promise).rejects.toThrow('Pi CLI not found');
  });

  it('should reject with stderr when pi exits with non-zero code', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stderr.emit('data', Buffer.from('Fatal: authentication failed'));
      mockChild.emit('close', 1);
    });

    await expect(promise).rejects.toThrow('Fatal: authentication failed');
  });

  it('should reject with default message when non-zero exit and no stderr', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.emit('close', 2);
    });

    await expect(promise).rejects.toThrow('Pi CLI exited with code 2');
  });

  it('should reject on invalid JSON from pi stdout (passes raw stdout through, then JSON.parse fails in evaluateWithPi)', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    // Raw stdout that is not valid JSON - spawnPi will resolve with it,
    // then evaluateWithPi will fail on JSON.parse
    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from('not valid json at all'));
      mockChild.emit('close', 0);
    });

    await expect(promise).rejects.toThrow();
  });

  it('should spawn pi with correct arguments', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const judgeResult = {
      pass_fail_status: 'passed',
      accuracy: 80,
      metrics: {},
      reasoning: 'Ok.',
      improvement_strategies: [],
    };

    const piOutput = JSON.stringify({ result: JSON.stringify(judgeResult) });

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from(piOutput));
      mockChild.emit('close', 0);
    });

    await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe('pi');
    expect(args).toContain('--print');
    expect(args).toContain('--mode');
    expect(args).toContain('json');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('--skill');
    expect(args).toContain('--extension');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.timeout).toBe(300_000);
  });

  it('should propagate non-ENOENT spawn errors', async () => {
    const mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);

    const promise = evaluateWithPi({
      trajectory: sampleTrajectory,
      expectedOutcomes: sampleExpectedOutcomes,
    });

    process.nextTick(() => {
      const error = new Error('Permission denied');
      mockChild.emit('error', error);
    });

    await expect(promise).rejects.toThrow('Permission denied');
  });
});

// ============================================================================
// Tests: parsePiError
// ============================================================================

describe('Pi Judge Service - parsePiError', () => {
  it('should map ENOENT to Pi CLI not found message', () => {
    const error = new Error('spawn pi ENOENT');
    expect(parsePiError(error)).toBe('Pi CLI not found. Install it from https://pi.dev');
  });

  it('should map "not found" to Pi CLI not found message', () => {
    const error = new Error('command not found: pi');
    expect(parsePiError(error)).toBe('Pi CLI not found. Install it from https://pi.dev');
  });

  it('should map ExpiredToken to AWS credentials message', () => {
    const error = new Error('ExpiredToken: The security token has expired');
    expect(parsePiError(error)).toBe(
      'AWS credentials expired or invalid. Please refresh your AWS credentials.'
    );
  });

  it('should map CredentialsProviderError to AWS credentials message', () => {
    const error = new Error('CredentialsProviderError: Could not load credentials');
    expect(parsePiError(error)).toBe(
      'AWS credentials expired or invalid. Please refresh your AWS credentials.'
    );
  });

  it('should map ETIMEDOUT to timeout message', () => {
    const error = new Error('connect ETIMEDOUT 10.0.0.1:443');
    expect(parsePiError(error)).toBe(
      'Pi evaluation timed out. The trajectory may be too large.'
    );
  });

  it('should map "timed out" to timeout message', () => {
    const error = new Error('Request timed out after 300000ms');
    expect(parsePiError(error)).toBe(
      'Pi evaluation timed out. The trajectory may be too large.'
    );
  });

  it('should map SIGTERM to timeout message', () => {
    const error = new Error('Process terminated with SIGTERM');
    expect(parsePiError(error)).toBe(
      'Pi evaluation timed out. The trajectory may be too large.'
    );
  });

  it('should map JSON parse errors to parse failure message', () => {
    const error = new Error('Unexpected token in JSON at position 0');
    expect(parsePiError(error)).toBe(
      'Failed to parse Pi judge response. The CLI may have returned invalid JSON.'
    );
  });

  it('should map "parse" errors to parse failure message', () => {
    const error = new Error('Could not parse response body');
    expect(parsePiError(error)).toBe(
      'Failed to parse Pi judge response. The CLI may have returned invalid JSON.'
    );
  });

  it('should return original message for unrecognized errors', () => {
    const error = new Error('Something completely different happened');
    expect(parsePiError(error)).toBe('Something completely different happened');
  });

  it('should return "Unknown error occurred" for empty message', () => {
    const error = new Error('');
    expect(parsePiError(error)).toBe('Unknown error occurred');
  });
});
