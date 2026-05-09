/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for Claude Code Judge Service
 *
 * Tests with the real claude binary if available.
 * Skips gracefully if claude is not installed.
 */

import { execSync } from 'child_process';
import { TrajectoryStep } from '@/types';

// Check if claude CLI is available before running tests
function isClaudeAvailable(): boolean {
  try {
    execSync('which claude', { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const claudeAvailable = isClaudeAvailable();

// Conditionally skip the entire suite
const describeIfClaude = claudeAvailable ? describe : describe.skip;

describeIfClaude('Claude Code Judge Integration', () => {
  // These tests call the real claude CLI and may take 30+ seconds
  jest.setTimeout(120_000);

  it('should evaluate a simple trajectory and return valid JudgeResponse', async () => {
    // Dynamic import to avoid loading child_process mocks from unit tests
    const { evaluateWithClaudeCode } = await import('@/server/services/claudeCodeJudgeService');

    const trajectory: TrajectoryStep[] = [
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
        content: 'Root cause: The cluster is in red status due to 5 unassigned shards.',
      },
    ];

    const result = await evaluateWithClaudeCode({
      trajectory,
      expectedOutcomes: ['Agent checks cluster health', 'Agent identifies unassigned shards as root cause'],
    });

    // Verify JudgeResponse shape
    expect(result).toHaveProperty('passFailStatus');
    expect(['passed', 'failed']).toContain(result.passFailStatus);
    expect(result).toHaveProperty('metrics');
    expect(typeof result.metrics.accuracy).toBe('number');
    expect(result.metrics.accuracy).toBeGreaterThanOrEqual(0);
    expect(result.metrics.accuracy).toBeLessThanOrEqual(100);
    expect(typeof result.llmJudgeReasoning).toBe('string');
    expect(result.llmJudgeReasoning.length).toBeGreaterThan(0);
    expect(Array.isArray(result.improvementStrategies)).toBe(true);
    expect(typeof result.duration).toBe('number');
    expect(result.duration).toBeGreaterThan(0);
  });

  it('should return improvement strategies for a poor trajectory', async () => {
    const { evaluateWithClaudeCode } = await import('@/server/services/claudeCodeJudgeService');

    const trajectory: TrajectoryStep[] = [
      {
        id: 'step-1',
        timestamp: Date.now(),
        type: 'response',
        content: 'I am not sure what the issue is.',
      },
    ];

    const result = await evaluateWithClaudeCode({
      trajectory,
      expectedOutcomes: [
        'Agent uses diagnostic tools',
        'Agent checks cluster health',
        'Agent identifies root cause',
      ],
    });

    expect(result.passFailStatus).toBe('failed');
    expect(result.metrics.accuracy).toBeLessThan(70);
  });
});

describe('Claude Code Judge - CLI availability check', () => {
  it('should report whether claude CLI is available', () => {
    if (claudeAvailable) {
      console.log('claude CLI is available - integration tests will run');
    } else {
      console.log('claude CLI not found - integration tests skipped');
    }
    // This test always passes - it just logs the status
    expect(true).toBe(true);
  });
});
