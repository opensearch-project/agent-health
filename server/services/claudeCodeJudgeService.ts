/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude Code Judge Service - LLM evaluation using Claude Code CLI
 *
 * Spawns the `claude` CLI binary to evaluate agent trajectories.
 * Uses the same AWS_PROFILE/AWS_REGION as Bedrock for authentication.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from '@/server/services/bedrockService';
import { JUDGE_SYSTEM_PROMPT } from '@/server/prompts/judgePrompt';
import { debug } from '@/lib/debug';

// ============================================================================
// Constants
// ============================================================================

/** Path to the AGENT_HEALTH.md skill file (appended to system prompt) */
const AGENT_HEALTH_SKILL_PATH = resolve(process.cwd(), 'docs/skills/AGENT_HEALTH.md');

/** Timeout for the claude CLI process (5 minutes) */
const CLAUDE_TIMEOUT_MS = 300_000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Load the AGENT_HEALTH.md skill content for the system prompt.
 * Returns empty string if file is not found.
 */
export function loadSkillContent(): string {
  try {
    return readFileSync(AGENT_HEALTH_SKILL_PATH, 'utf-8');
  } catch {
    debug('ClaudeCodeJudge', 'AGENT_HEALTH.md not found at', AGENT_HEALTH_SKILL_PATH);
    return '';
  }
}

/**
 * Build the full system prompt including skill content
 */
export function buildSystemPrompt(): string {
  const skillContent = loadSkillContent();
  if (skillContent) {
    return `${JUDGE_SYSTEM_PROMPT}\n\n---\n\n## Agent Health Reference\n\n${skillContent}`;
  }
  return JUDGE_SYSTEM_PROMPT;
}

// ============================================================================
// Main Evaluation Function
// ============================================================================

/**
 * Evaluate agent trajectory using Claude Code CLI
 * Spawns `claude --print --output-format json --dangerously-skip-permissions`
 * and pipes the evaluation prompt to stdin.
 *
 * @param request - The judge request containing trajectory and expected outcomes
 * @returns JudgeResponse with pass/fail, accuracy, reasoning, and improvement strategies
 */
export async function evaluateWithClaudeCode(
  request: JudgeRequest
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  debug('ClaudeCodeJudge', '========== CLAUDE CODE JUDGE REQUEST ==========');
  debug('ClaudeCodeJudge', 'Trajectory steps:', trajectory.length);
  debug('ClaudeCodeJudge', 'Expected outcomes:', expectedOutcomes?.length || 0);

  const userPrompt = buildEvaluationPrompt(trajectory, expectedOutcomes, expectedTrajectory, logs);
  debug('ClaudeCodeJudge', 'Prompt built, length:', userPrompt.length, 'characters');

  const systemPrompt = buildSystemPrompt();

  const startTime = Date.now();

  const result = await spawnClaude(userPrompt, systemPrompt);
  const duration = Date.now() - startTime;

  debug('ClaudeCodeJudge', 'Response received in', duration, 'ms');
  debug('ClaudeCodeJudge', '--- Raw Claude Code Response ---');
  debug('ClaudeCodeJudge', result.substring(0, 500) + (result.length > 500 ? '...' : ''));

  // Extract JSON from response — handles markdown code blocks and bare JSON
  let jsonText = result.trim();
  const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1];
    debug('ClaudeCodeJudge', 'Extracted JSON from markdown code block');
  } else {
    const startIdx = jsonText.indexOf('{');
    const endIdx = jsonText.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      jsonText = jsonText.slice(startIdx, endIdx + 1);
      debug('ClaudeCodeJudge', 'Extracted JSON from text');
    }
  }

  const parsed = JSON.parse(jsonText);

  debug('ClaudeCodeJudge', '========== CLAUDE CODE JUDGE RESPONSE ==========');
  debug('ClaudeCodeJudge', 'Pass/Fail Status:', parsed.pass_fail_status?.toUpperCase() || 'MISSING');

  // Handle both simplified format (accuracy at top level) and legacy format
  const accuracy = parsed.accuracy ?? parsed.metrics?.accuracy ?? 0;
  debug('ClaudeCodeJudge', 'Accuracy:', accuracy);
  debug('ClaudeCodeJudge', 'Improvement Strategies:', parsed.improvement_strategies?.length ?? 0, 'items');

  return {
    passFailStatus: (parsed.pass_fail_status || 'failed') as 'passed' | 'failed',
    metrics: {
      accuracy,
      faithfulness: parsed.metrics?.faithfulness,
      latency_score: parsed.metrics?.latency_score,
      trajectory_alignment_score: parsed.metrics?.trajectory_alignment_score,
    },
    llmJudgeReasoning: parsed.reasoning,
    improvementStrategies: parsed.improvement_strategies || [],
    duration,
  };
}

// ============================================================================
// Subprocess Management
// ============================================================================

/**
 * Spawn the claude CLI and capture its output.
 * The prompt is piped to stdin.
 */
function spawnClaude(prompt: string, systemPrompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '--print',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--append-system-prompt', systemPrompt,
    ];

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_CODE_USE_BEDROCK: '1',
      DISABLE_PROMPT_CACHING: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1',
      ANTHROPIC_API_KEY: '', // Prevent login key from overriding Bedrock
    };

    // Inherit AWS_PROFILE and AWS_REGION from process env
    if (process.env.AWS_PROFILE) {
      env.AWS_PROFILE = process.env.AWS_PROFILE;
    }
    if (process.env.AWS_REGION) {
      env.AWS_REGION = process.env.AWS_REGION;
    }

    debug('ClaudeCodeJudge', 'Spawning claude CLI with args:', args.slice(0, 4).join(' '));

    const child = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLAUDE_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code'));
      } else {
        reject(error);
      }
    });

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const errorMsg = stderr.trim() || `Claude CLI exited with code ${code}`;
        reject(new Error(errorMsg));
        return;
      }

      // Claude --output-format json wraps the result in a JSON object
      // Extract the text content from the response
      try {
        const jsonResponse = JSON.parse(stdout);
        // The JSON output format returns { result: "...", ... }
        // or an array of content blocks
        if (jsonResponse.result) {
          resolvePromise(typeof jsonResponse.result === 'string' ? jsonResponse.result : JSON.stringify(jsonResponse.result));
        } else if (Array.isArray(jsonResponse) && jsonResponse.length > 0) {
          // NDJSON array from --output-format json: [{type:"system",...}, {type:"assistant",...}, {type:"result",...}]
          // First try to find the result object
          const resultObj = jsonResponse.find((block: any) => block.type === 'result');
          if (resultObj?.result) {
            resolvePromise(typeof resultObj.result === 'string' ? resultObj.result : JSON.stringify(resultObj.result));
          } else {
            // Fallback: try assistant message content blocks
            const assistantObj = jsonResponse.find((block: any) => block.type === 'assistant');
            const textContent = assistantObj?.message?.content
              ?.filter((block: any) => block.type === 'text')
              ?.map((block: any) => block.text)
              ?.join('');
            if (textContent) {
              resolvePromise(textContent);
            } else {
              // Legacy: array of plain text blocks [{type:'text', text:'...'}]
              const plainText = jsonResponse
                .filter((block: any) => block.type === 'text')
                .map((block: any) => block.text)
                .join('');
              resolvePromise(plainText || stdout);
            }
          }
        } else {
          // Might be bare JSON response
          resolvePromise(stdout);
        }
      } catch {
        // Not valid JSON wrapper, use raw stdout
        resolvePromise(stdout);
      }
    });

    // Write prompt to stdin and close
    child.stdin.on('error', () => { /* handled by 'close' event */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ============================================================================
// Error Parser
// ============================================================================

/**
 * Parse error messages from Claude Code CLI failures
 */
export function parseClaudeCodeError(error: Error): string {
  const msg = error.message;

  if (msg.includes('ENOENT') || msg.includes('not found')) {
    return 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code';
  } else if (msg.includes('ExpiredToken') || msg.includes('CredentialsProviderError')) {
    return 'AWS credentials expired or invalid. Please refresh your AWS credentials.';
  } else if (msg.includes('ETIMEDOUT') || msg.includes('timed out') || msg.includes('SIGTERM')) {
    return 'Claude Code evaluation timed out. The trajectory may be too large.';
  } else if (msg.includes('JSON') || msg.includes('parse')) {
    return 'Failed to parse Claude Code judge response. The CLI may have returned invalid JSON.';
  } else if (msg.includes('exit code') || msg.includes('exited with code')) {
    return `Claude Code CLI failed: ${msg}`;
  }

  return msg || 'Unknown error occurred';
}
