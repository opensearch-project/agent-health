/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agentic Judge Service - Evaluation using an agent-based judge
 *
 * Unlike simple LLM judges that make a single inference call, the agentic judge
 * operates as an agent itself — it can use tools, iterate, and reason through
 * multiple steps to produce a more thorough evaluation.
 *
 * Supports multiple backends:
 * - claude-code: Uses Claude Code CLI with full tool access (default)
 * - custom: Connects to any agent endpoint using the connector infrastructure
 */

import { spawn } from 'child_process';
import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from '@/server/services/bedrockService';
import { JUDGE_SYSTEM_PROMPT, AGENT_PATH_SYSTEM_ADDENDUM } from '@/server/prompts/judgePrompt';
import { loadSkillContent } from '@/server/services/claudeCodeJudgeService';
import { parseJudgeResponse as parseSharedJudgeResponse } from '@/server/services/judgeResponseParser';
import { buildJudgeDebug } from '@/server/services/judgeDebug';
import { Evaluator } from '@/types';
import { debug } from '@/lib/debug';
import {
  getAgentPathForSpawn,
  getAgentSourceForPrompt,
  isAgentPathConfigured,
} from '@/server/services/agentPath';

// ============================================================================
// Constants
// ============================================================================

/** Timeout for agentic judge execution (10 minutes — longer than simple judge) */
const AGENTIC_TIMEOUT_MS = 600_000;

/** System prompt addendum for agentic judges */
const AGENTIC_JUDGE_ADDENDUM = `

## Agentic Evaluation Mode

You are operating as an **agentic judge**. Unlike a simple LLM judge, you have the ability to:

1. **Use tools** to verify claims made in the trajectory (e.g., check if referenced data exists)
2. **Iterate** through the evaluation — re-examine steps if something seems inconsistent
3. **Cross-reference** multiple steps to detect contradictions or hallucinations
4. **Validate tool usage** by checking if tools were called with correct parameters

Take your time to thoroughly evaluate. Use your tools when available to verify the agent's work.
Produce your final evaluation in the same JSON format as specified.
`;

// ============================================================================
// Types
// ============================================================================

export interface AgenticJudgeOptions {
  /** Which agentic backend to use */
  backend: 'claude-code' | 'custom';
  /** Custom endpoint for 'custom' backend */
  endpoint?: string;
  /** Additional headers for custom endpoint */
  headers?: Record<string, string>;
}

// ============================================================================
// Main Evaluation Function
// ============================================================================

/**
 * Evaluate agent trajectory using an agentic judge.
 *
 * The agentic judge runs as an agent itself, capable of using tools and
 * iterating through the evaluation rather than making a single LLM call.
 *
 * @param request - The judge request containing trajectory and expected outcomes
 * @param options - Configuration for the agentic judge backend
 * @param evaluator - Optional saved evaluator. When provided, its `systemPrompt`
 *   replaces the hardcoded `JUDGE_SYSTEM_PROMPT` baseline (the
 *   `AGENTIC_JUDGE_ADDENDUM` describing this provider's tool-use contract is
 *   still appended on top). `scoringConfig.metrics` drives dynamic metric
 *   extraction in the parsed response.
 * @returns JudgeResponse with pass/fail, metrics, reasoning, and improvement strategies
 */
export async function evaluateWithAgenticJudge(
  request: JudgeRequest,
  options: AgenticJudgeOptions = { backend: 'claude-code' },
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  debug('AgenticJudge', '========== AGENTIC JUDGE REQUEST ==========');
  debug('AgenticJudge', 'Backend:', options.backend);
  debug('AgenticJudge', 'Trajectory steps:', trajectory.length);
  debug('AgenticJudge', 'Expected outcomes:', expectedOutcomes?.length || 0);
  debug('AgenticJudge', 'Evaluator:', evaluator ? `${evaluator.name} (${evaluator.id})` : '(none, using default prompt)');

  if (options.backend === 'custom' && options.endpoint) {
    return evaluateWithCustomEndpoint(request, options, evaluator);
  }

  // Default: claude-code agentic mode (with tool access)
  return evaluateWithClaudeCodeAgentic(request, evaluator);
}

// ============================================================================
// Claude Code Agentic Backend
// ============================================================================

/**
 * Run evaluation using Claude Code in full agentic mode (not --print).
 * This allows the judge to use tools, read files, and iterate.
 *
 * The saved evaluator's `systemPrompt` (when provided) replaces the
 * hardcoded `JUDGE_SYSTEM_PROMPT` baseline; the `AGENTIC_JUDGE_ADDENDUM`
 * (the tool-use contract specific to this provider) and the AGENT_HEALTH.md
 * skill are still appended so the agentic-judge contract isn't lost when a
 * user customizes the prompt.
 */
async function evaluateWithClaudeCodeAgentic(
  request: JudgeRequest,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

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
  const skillContent = loadSkillContent();
  const baseSystemPrompt =
    evaluator?.systemPrompt && evaluator.systemPrompt.trim().length > 0
      ? evaluator.systemPrompt
      : JUDGE_SYSTEM_PROMPT;
  const agentPathAddendum = agentSource ? AGENT_PATH_SYSTEM_ADDENDUM : '';
  const systemPrompt = baseSystemPrompt + AGENTIC_JUDGE_ADDENDUM + agentPathAddendum +
    (skillContent ? `\n\n---\n\n## Agent Health Reference\n\n${skillContent}` : '');

  const startTime = Date.now();

  const result = await spawnClaudeAgentic(userPrompt, systemPrompt);
  const duration = Date.now() - startTime;

  debug('AgenticJudge', 'Agentic evaluation completed in', duration, 'ms');
  debug('AgenticJudge', '--- Raw Response ---');
  debug('AgenticJudge', result.substring(0, 500) + (result.length > 500 ? '...' : ''));

  const parsed = parseJudgeResponse(result, duration, evaluator);
  const judgeDebug = buildJudgeDebug({
    provider: 'agentic',
    evaluatorId: evaluator?.id,
    systemPrompt,
    userPrompt,
  });
  if (judgeDebug) parsed.judgeDebug = judgeDebug;
  // The agentic backends (claude-code CLI / custom endpoint) pick their own
  // model and don't report it back through this path — record the backend
  // as the judge identity so the report at least says WHICH agentic judge
  // ran (never a silent `agentic-claude-code` masquerading as a model).
  parsed.judgeProvider = 'agentic';
  return parsed;
}

// ============================================================================
// Custom Endpoint Backend
// ============================================================================

/**
 * Run evaluation via a custom agentic judge endpoint.
 * The endpoint should accept the same JudgeRequest format and return JudgeResponse.
 *
 * The saved evaluator's `systemPrompt` (when provided) replaces the
 * hardcoded baseline before being forwarded so the remote endpoint sees the
 * same prompt the local agentic backend would use.
 */
async function evaluateWithCustomEndpoint(
  request: JudgeRequest,
  options: AgenticJudgeOptions,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const startTime = Date.now();

  debug('AgenticJudge', 'Calling custom endpoint:', options.endpoint);

  const baseSystemPrompt =
    evaluator?.systemPrompt && evaluator.systemPrompt.trim().length > 0
      ? evaluator.systemPrompt
      : JUDGE_SYSTEM_PROMPT;

  const response = await fetch(options.endpoint!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: JSON.stringify({
      trajectory: request.trajectory,
      expectedOutcomes: request.expectedOutcomes,
      expectedTrajectory: request.expectedTrajectory,
      logs: request.logs,
      systemPrompt: baseSystemPrompt + AGENTIC_JUDGE_ADDENDUM + (isAgentPathConfigured() ? AGENT_PATH_SYSTEM_ADDENDUM : ''),
    }),
    signal: AbortSignal.timeout(AGENTIC_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Custom agentic judge returned ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  const duration = Date.now() - startTime;

  debug('AgenticJudge', 'Custom endpoint responded in', duration, 'ms');

  // If the custom endpoint returns a full JudgeResponse, use it directly
  if (result.passFailStatus && result.metrics) {
    return { ...result, duration };
  }

  // Otherwise, try to parse the result as raw LLM output
  if (typeof result === 'string' || result.result) {
    return parseJudgeResponse(result.result || result, duration, evaluator);
  }

  return parseJudgeResponse(JSON.stringify(result), duration, evaluator);
}

// ============================================================================
// Subprocess Management
// ============================================================================

/**
 * Spawn Claude Code in print mode for evaluation.
 * Uses --print (read-only, no tool access) to prevent prompt injection risks.
 * The agentic judge evaluates based on the trajectory content without executing tools.
 */
function spawnClaudeAgentic(prompt: string, systemPrompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Use --print mode only (no --dangerously-skip-permissions)
    // This ensures the judge cannot modify files or access tools,
    // preventing prompt injection from trajectory/log content.
    const args = [
      '--print',
      '--output-format', 'json',
      '--append-system-prompt', systemPrompt,
    ];

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_CODE_USE_BEDROCK: '1',
      DISABLE_PROMPT_CACHING: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1',
      ANTHROPIC_API_KEY: '',
    };

    if (process.env.AWS_PROFILE) {
      env.AWS_PROFILE = process.env.AWS_PROFILE;
    }
    if (process.env.AWS_REGION) {
      env.AWS_REGION = process.env.AWS_REGION;
    }

    debug('AgenticJudge', 'Spawning claude CLI in agentic mode');

    const child = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: AGENTIC_TIMEOUT_MS,
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

      try {
        const jsonResponse = JSON.parse(stdout);
        if (jsonResponse.result) {
          resolvePromise(typeof jsonResponse.result === 'string' ? jsonResponse.result : JSON.stringify(jsonResponse.result));
        } else if (Array.isArray(jsonResponse) && jsonResponse.length > 0) {
          const resultObj = jsonResponse.find((block: any) => block.type === 'result');
          if (resultObj?.result) {
            resolvePromise(typeof resultObj.result === 'string' ? resultObj.result : JSON.stringify(resultObj.result));
          } else {
            const assistantObj = jsonResponse.find((block: any) => block.type === 'assistant');
            const textContent = assistantObj?.message?.content
              ?.filter((block: any) => block.type === 'text')
              ?.map((block: any) => block.text)
              ?.join('');
            if (textContent) {
              resolvePromise(textContent);
            } else {
              resolvePromise(stdout);
            }
          }
        } else {
          resolvePromise(stdout);
        }
      } catch {
        resolvePromise(stdout);
      }
    });

    child.stdin.on('error', () => { /* handled by 'close' event */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse raw judge response into structured JudgeResponse.
 *
 * Delegates to the shared {@link parseSharedJudgeResponse} so the agentic
 * provider honors `evaluator.scoringConfig.metrics` (instead of hardcoding
 * the legacy 4-metric schema) and surfaces extra fields the model emits.
 */
function parseJudgeResponse(result: string, duration: number, evaluator?: Evaluator): JudgeResponse {
  return parseSharedJudgeResponse(result, {
    evaluator,
    duration,
    source: 'AgenticJudge',
  });
}

// ============================================================================
// Error Parser
// ============================================================================

/**
 * Parse error messages from agentic judge failures
 */
export function parseAgenticJudgeError(error: Error): string {
  const msg = error.message;

  if (msg.includes('ENOENT') || msg.includes('not found')) {
    return 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code';
  } else if (msg.includes('ExpiredToken') || msg.includes('CredentialsProviderError')) {
    return 'AWS credentials expired or invalid. Please refresh your AWS credentials.';
  } else if (msg.includes('ETIMEDOUT') || msg.includes('timed out') || msg.includes('SIGTERM')) {
    return 'Agentic judge evaluation timed out (10 min limit). The trajectory may be too complex.';
  } else if (msg.includes('Custom agentic judge returned')) {
    return msg;
  } else if (msg.includes('JSON') || msg.includes('parse')) {
    return 'Failed to parse agentic judge response.';
  }

  return msg || 'Unknown agentic judge error';
}
