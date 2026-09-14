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
import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from '@/server/services/bedrockService';
import { JUDGE_SYSTEM_PROMPT, AGENT_PATH_SYSTEM_ADDENDUM } from '@/server/prompts/judgePrompt';
import { parseJudgeResponse } from '@/server/services/judgeResponseParser';
import { buildJudgeDebug } from '@/server/services/judgeDebug';
import { Evaluator } from '@/types';
import { debug } from '@/lib/debug';
import { getSkillPath } from '@/lib/packagePaths';
import {
  getAgentPathForSpawn,
  getAgentSourceForPrompt,
  isAgentPathConfigured,
} from '@/server/services/agentPath';

// ============================================================================
// Constants
// ============================================================================

/** Path to the AGENT_HEALTH.md skill file (appended to system prompt) */
const AGENT_HEALTH_SKILL_PATH = getSkillPath('AGENT_HEALTH.md');

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
 * Build the full system prompt including skill content.
 *
 * When the caller passes a saved {@link Evaluator}, its `systemPrompt`
 * REPLACES the hardcoded `JUDGE_SYSTEM_PROMPT` baseline — the same way the
 * `bedrock` and `openai-compatible` providers have always behaved. Without
 * this an evaluator saved in storage (e.g. a custom `cp-oncall` judge prompt)
 * silently falls back to the built-in baseline on the claude-code path,
 * which is exactly the silent-prompt-drop bug fixed in this change.
 *
 * The AGENT_HEALTH.md skill is appended in either case so the judge keeps
 * its operational reference material regardless of the saved prompt.
 *
 * When AH_AGENT_PATH is configured, the agent-path addendum is appended so
 * the judge knows to ground reasoning in the user's agent source.
 */
export function buildSystemPrompt(evaluator?: Evaluator): string {
  const base =
    evaluator?.systemPrompt && evaluator.systemPrompt.trim().length > 0
      ? evaluator.systemPrompt
      : JUDGE_SYSTEM_PROMPT;
  const skillContent = loadSkillContent();
  const agentPathAddendum = isAgentPathConfigured() ? AGENT_PATH_SYSTEM_ADDENDUM : '';
  if (skillContent) {
    return `${base}${agentPathAddendum}\n\n---\n\n## Agent Health Reference\n\n${skillContent}`;
  }
  return base + agentPathAddendum;
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
 * @param evaluator - Optional saved evaluator. When provided, its `systemPrompt`
 *   replaces the hardcoded `JUDGE_SYSTEM_PROMPT` (the AGENT_HEALTH.md skill is
 *   still appended) and its `scoringConfig.metrics` drives dynamic metric
 *   extraction in the parsed response. When absent, falls back to the legacy
 *   hardcoded prompt + 4-metric schema for back-compat with old callers.
 * @returns JudgeResponse with pass/fail, metrics, reasoning, and improvement strategies
 */
export async function evaluateWithClaudeCode(
  request: JudgeRequest,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  debug('ClaudeCodeJudge', '========== CLAUDE CODE JUDGE REQUEST ==========');
  debug('ClaudeCodeJudge', 'Trajectory steps:', trajectory.length);
  debug('ClaudeCodeJudge', 'Expected outcomes:', expectedOutcomes?.length || 0);
  debug('ClaudeCodeJudge', 'Evaluator:', evaluator ? `${evaluator.name} (${evaluator.id})` : '(none, using default prompt)');

  // Pull agent source when AH_AGENT_PATH is configured. The spawned claude
  // CLI will additionally have cwd: agentPath set so it can browse files
  // on demand for any context the injected snapshot doesn't cover.
  const agentSource = isAgentPathConfigured()
    ? await getAgentSourceForPrompt({ trajectory, expectedOutcomes })
    : null;

  const userPrompt = buildEvaluationPrompt(
    trajectory,
    expectedOutcomes,
    expectedTrajectory,
    logs,
    agentSource,
  );
  debug('ClaudeCodeJudge', 'Prompt built, length:', userPrompt.length, 'characters');

  const systemPrompt = buildSystemPrompt(evaluator);

  const startTime = Date.now();

  const result = await spawnClaude(userPrompt, systemPrompt);
  const duration = Date.now() - startTime;

  debug('ClaudeCodeJudge', 'Response received in', duration, 'ms');
  debug('ClaudeCodeJudge', '--- Raw Claude Code Response ---');
  debug('ClaudeCodeJudge', result.substring(0, 500) + (result.length > 500 ? '...' : ''));

  // Shared parser: dynamic metric extraction from `evaluator.scoringConfig.metrics`,
  // captures `rawResponse` for the run-detail debug surface, and stuffs any
  // unexpected JSON keys the model emitted into `extraFields` instead of
  // silently dropping them.
  const parsed = parseJudgeResponse(result, {
    evaluator,
    duration,
    source: 'ClaudeCodeJudge',
  });
  const judgeDebug = buildJudgeDebug({
    provider: 'claude-code',
    evaluatorId: evaluator?.id,
    systemPrompt,
    userPrompt,
  });
  if (judgeDebug) parsed.judgeDebug = judgeDebug;
  // The claude CLI's `--output-format json` envelope carries `modelUsage`
  // keyed by the model id(s) that answered; record the first as the judge
  // model when present. Otherwise only the provider kind is known.
  const usedModel = extractClaudeCodeModel(result);
  if (usedModel) parsed.judgeModel = usedModel;
  parsed.judgeProvider = 'claude-code';
  return parsed;
}

/**
 * Best-effort: the model id the claude CLI reported using. `spawnClaude`
 * resolves to the verdict TEXT (not the envelope) for successful runs, so
 * this only finds a model when the envelope leaked through as raw stdout;
 * returns undefined otherwise. @internal
 */
export function extractClaudeCodeModel(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw);
    const usage = parsed?.modelUsage;
    if (usage && typeof usage === 'object') {
      const [first] = Object.keys(usage);
      if (first) return first;
    }
    if (typeof parsed?.model === 'string' && parsed.model) return parsed.model;
  } catch {
    /* verdict text, not the envelope */
  }
  return undefined;
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
      // When AH_AGENT_PATH is configured, run the spawned claude CLI with
      // the agent path as its CWD so the model can use Read/Grep/Glob to
      // explore the user's repo on demand. Falls back to inheriting the
      // current process CWD when the env var is not set.
      cwd: getAgentPathForSpawn() || undefined,
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
