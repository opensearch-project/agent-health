/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pi Judge Service - LLM evaluation using pi.dev CLI
 *
 * Spawns the `pi` CLI binary to evaluate agent trajectories.
 * Uses the Agent Health pi-package for domain-specific evaluation knowledge.
 */

import { spawn } from 'child_process';
import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from '@/server/services/bedrockService';
import { JUDGE_SYSTEM_PROMPT, AGENT_PATH_SYSTEM_ADDENDUM } from '@/server/prompts/judgePrompt';
import { resolvePiCommand } from '@/server/services/piBinary';
import { parseJudgeResponse } from '@/server/services/judgeResponseParser';
import { buildJudgeDebug } from '@/server/services/judgeDebug';
import { Evaluator } from '@/types';
import { debug } from '@/lib/debug';
import { getPiPackagePath } from '@/lib/packagePaths';
import {
  getAgentPathForSpawn,
  getAgentSourceForPrompt,
  isAgentPathConfigured,
} from '@/server/services/agentPath';

// ============================================================================
// Constants
// ============================================================================

/** Path to the pi-package (for --package flag) */
const PI_PACKAGE_PATH = getPiPackagePath();

/** Timeout for the pi CLI process (5 minutes) */
const PI_TIMEOUT_MS = 300_000;

/** Options for spawning the pi judge CLI. @internal */
export interface SpawnPiOptions {
  /** Extra `--extension <path>` files to load (e.g. the trace-tool pack). */
  extraExtensions?: string[];
  /** Extra env vars to inject into the spawned process. */
  extraEnv?: Record<string, string>;
  /**
   * Skip the observio sample-agent base pack (`PI_PACKAGE_PATH` skills +
   * `agent-health.ts` extension). The agentic trace judge provides its own
   * self-contained tool pack via `extraExtensions` and must NOT load the
   * sample-agent extension (it pulls in `@earendil-works/pi-ai` and other
   * agent-only tools the judge neither needs nor can resolve). @internal
   */
  omitBasePack?: boolean;
}

/**
 * Parse the verdict JSON out of a raw pi judge response string. Handles
 * markdown ```json fences and bare `{...}`.
 *
 * Delegates to the shared {@link parseJudgeResponse} so this provider honors
 * the evaluator's `scoringConfig.metrics` (instead of hardcoding the legacy
 * 4-metric schema) and surfaces extra fields the model emits via
 * `JudgeResponse.extraFields`. The `evaluator` argument is optional for
 * back-compat with the standalone unit test that exercises this helper.
 * @internal
 */
export function parsePiJudgeJson(result: string, evaluator?: Evaluator): JudgeResponse {
  return parseJudgeResponse(result, { evaluator, source: 'PiJudge' });
}

// ============================================================================
// Main Evaluation Function
// ============================================================================

/**
 * Evaluate agent trajectory using pi.dev CLI
 * Spawns `pi --print --mode json` and pipes the evaluation prompt to stdin.
 *
 * @param request - The judge request containing trajectory and expected outcomes
 * @param evaluator - Optional saved evaluator. When provided, its `systemPrompt`
 *   is passed to the pi CLI via `--system-prompt`, fully replacing the
 *   hardcoded `JUDGE_SYSTEM_PROMPT` baseline. `scoringConfig.metrics` drives
 *   dynamic metric extraction from the response.
 */
export async function evaluateWithPi(
  request: JudgeRequest,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  console.warn(
    '[DEPRECATED] The plain pi judge spawns an unrestricted CLI with filesystem/shell tools. ' +
    'Use the agent evidence judge (provider: "agent") with restricted in-process bash instead.'
  );
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  debug('PiJudge', '========== PI JUDGE REQUEST ==========');
  debug('PiJudge', 'Trajectory steps:', trajectory.length);
  debug('PiJudge', 'Expected outcomes:', expectedOutcomes?.length || 0);
  debug('PiJudge', 'Evaluator:', evaluator ? `${evaluator.name} (${evaluator.id})` : '(none, using default prompt)');

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
  debug('PiJudge', 'Prompt built, length:', userPrompt.length, 'characters');

  // Saved evaluator's prompt fully replaces the hardcoded baseline; falling
  // back keeps back-compat with callers that don't pass an evaluator (the
  // SDK pre-evaluator code path and a couple of integration tests).
  const systemPrompt =
    (evaluator?.systemPrompt && evaluator.systemPrompt.trim().length > 0
      ? evaluator.systemPrompt
      : JUDGE_SYSTEM_PROMPT)
    + (agentSource ? AGENT_PATH_SYSTEM_ADDENDUM : '');

  const startTime = Date.now();

  const result = await spawnPi(userPrompt, systemPrompt);
  const duration = Date.now() - startTime;

  debug('PiJudge', 'Response received in', duration, 'ms');
  debug('PiJudge', '--- Raw Pi Response ---');
  debug('PiJudge', result.substring(0, 500) + (result.length > 500 ? '...' : ''));

  const parsed = parseJudgeResponse(result, {
    evaluator,
    duration,
    source: 'PiJudge',
  });
  debug('PiJudge', '========== PI JUDGE RESPONSE ==========');
  debug('PiJudge', 'Pass/Fail Status:', parsed.passFailStatus?.toUpperCase() || 'MISSING');
  const judgeDebug = buildJudgeDebug({
    provider: 'pi',
    evaluatorId: evaluator?.id,
    systemPrompt,
    userPrompt,
  });
  if (judgeDebug) parsed.judgeDebug = judgeDebug;
  return parsed;
}

// ============================================================================
// Subprocess Management
// ============================================================================

/**
 * Spawn the pi CLI and capture its output. @internal
 *
 * `extraExtensions` adds `--extension <path>` flags (e.g. the trace-tool
 * pack for the agentic judge); `extraEnv` injects env (e.g. the runId the
 * trace tools scope to).
 */
/**
 * Extract the judge verdict text from pi's NDJSON (`--mode json`) output.
 * pi streams one JSON event per line; the verdict lives either in an explicit
 * `{ type: 'result', result }` event or in the last assistant message's text
 * content. Returns `undefined` when no usable text is found. @internal
 */
export function extractFromNdjson(stdout: string): string | undefined {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  let resultText: string | undefined;
  let lastAssistantText: string | undefined;
  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type === 'result' && ev.result) {
      resultText = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result);
    }
    const msg = ev?.message;
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      const text = msg.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('');
      if (text.trim()) lastAssistantText = text;
    }
  }
  return resultText ?? lastAssistantText;
}

export function spawnPi(
  prompt: string,
  systemPrompt: string,
  options: SpawnPiOptions = {}
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '--print',
      '--mode', 'json',
      '--system-prompt', systemPrompt,
    ];
    if (!options.omitBasePack) {
      args.push(
        '--skill', `${PI_PACKAGE_PATH}/skills/*`,
        '--extension', `${PI_PACKAGE_PATH}/extensions/agent-health.ts`,
      );
    }
    for (const ext of options.extraExtensions ?? []) {
      args.push('--extension', ext);
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(options.extraEnv ?? {}),
    };

    // Inherit AWS credentials
    if (process.env.AWS_PROFILE) env.AWS_PROFILE = process.env.AWS_PROFILE;
    if (process.env.AWS_REGION) env.AWS_REGION = process.env.AWS_REGION;

    const pi = resolvePiCommand();
    debug('PiJudge', `Spawning pi CLI (${pi.bundled ? 'bundled' : 'PATH'}) with args:`, args.slice(0, 4).join(' '));

    const child = spawn(pi.command, [...pi.prefixArgs, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PI_TIMEOUT_MS,
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
        reject(new Error('Pi CLI not found. It ships as the optionalDependency "@earendil-works/pi-coding-agent"; reinstall without --no-optional, or install pi from https://pi.dev'));
      } else {
        reject(error);
      }
    });

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const errorMsg = stderr.trim() || `Pi CLI exited with code ${code}`;
        reject(new Error(errorMsg));
        return;
      }

      // Parse Pi's JSON output format
      try {
        const jsonResponse = JSON.parse(stdout);
        if (jsonResponse.result) {
          resolvePromise(typeof jsonResponse.result === 'string' ? jsonResponse.result : JSON.stringify(jsonResponse.result));
        } else if (Array.isArray(jsonResponse)) {
          // NDJSON array: find result object
          const resultObj = jsonResponse.find((block: any) => block.type === 'result');
          if (resultObj?.result) {
            resolvePromise(typeof resultObj.result === 'string' ? resultObj.result : JSON.stringify(resultObj.result));
          } else {
            const assistantObj = jsonResponse.find((block: any) => block.type === 'assistant');
            const textContent = assistantObj?.message?.content
              ?.filter((block: any) => block.type === 'text')
              ?.map((block: any) => block.text)
              ?.join('');
            resolvePromise(textContent || stdout);
          }
        } else {
          resolvePromise(stdout);
        }
      } catch (parseError) {
        // pi `--mode json` streams NDJSON (one event per line), not a single
        // JSON document, so JSON.parse(stdout) throws. Parse line-by-line and
        // extract the verdict: prefer an explicit `result` event, else the
        // last assistant message's text content (which carries the JSON the
        // judge system prompt asked for).
        const ndjson = extractFromNdjson(stdout);
        if (ndjson) {
          resolvePromise(ndjson);
        } else {
          debug('PiJudge', 'Failed to parse Pi CLI output as JSON, using raw stdout:', (parseError as Error).message);
          resolvePromise(stdout);
        }
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
 * Parse error messages from Pi CLI failures
 */
export function parsePiError(error: Error): string {
  const msg = error.message;

  if (msg.includes('ENOENT') || msg.includes('not found')) {
    return 'Pi CLI not found. Install it from https://pi.dev';
  } else if (msg.includes('ExpiredToken') || msg.includes('CredentialsProviderError')) {
    return 'AWS credentials expired or invalid. Please refresh your AWS credentials.';
  } else if (msg.includes('ETIMEDOUT') || msg.includes('timed out') || msg.includes('SIGTERM')) {
    return 'Pi evaluation timed out. The trajectory may be too large.';
  } else if (msg.includes('JSON') || msg.includes('parse')) {
    return 'Failed to parse Pi judge response. The CLI may have returned invalid JSON.';
  }

  return msg || 'Unknown error occurred';
}
