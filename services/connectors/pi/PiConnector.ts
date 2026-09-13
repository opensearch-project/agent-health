/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pi Connector
 * Subprocess connector for pi.dev CLI — a minimal terminal coding harness.
 * Spawns `pi` with --print mode and parses JSON output.
 */

import type { TrajectoryStep } from '@/types';
import { ToolCallStatus } from '@/types';
import {
  SubprocessConnector,
  type SubprocessExecutionState,
} from '@/services/connectors/subprocess/SubprocessConnector';
import { agentPromptContext } from '@/services/connectors/types';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorProgressCallback,
  SubprocessConfig,
} from '@/services/connectors/types';

/**
 * Configuration options for Pi connector
 * Passed via agent.connectorConfig in agent-health.config.ts
 */
export interface PiConnectorConfig {
  env?: Record<string, string>;
  /** Path to pi package to load (e.g., ./observio-sample-agent/pi-package) */
  packagePath?: string;
  /** Pi model override (e.g., 'claude-sonnet-4-5') */
  model?: string;
  /** Working directory for pi */
  workingDir?: string;
  /** Timeout in ms (default: 600000 = 10 minutes) */
  timeout?: number;
  /** Additional CLI args to pass to pi */
  additionalArgs?: string[];
}

/**
 * Default Pi configuration
 */
const PI_DEFAULT_CONFIG: Partial<SubprocessConfig> = {
  command: 'pi',
  args: ['--print', '--mode', 'json'],
  env: {},
  inputMode: 'stdin',
  outputParser: 'streaming',
  timeout: 600000, // 10 minutes
};

/**
 * Per-invocation parse state (see `SubprocessExecutionState`: the registry
 * shares ONE connector instance across concurrent runs, so buffers must not
 * live on `this`).
 */
interface PiExecutionState extends SubprocessExecutionState {
  piOutputBuffer: string;
  piThinkingBuffer: string;
  piTextBuffer: string;
}

/**
 * Pi CLI Connector
 * Invokes pi.dev as a subprocess for agent evaluation
 */
export class PiConnector extends SubprocessConnector<PiExecutionState> {
  readonly type = 'pi' as const;
  override readonly name = 'Pi (pi.dev)';

  override traceContext = { propagateEnv: true, serviceName: 'pi-agent' };

  constructor(config?: Partial<SubprocessConfig>) {
    super({ ...PI_DEFAULT_CONFIG, ...config });
  }

  protected override createExecutionState(): PiExecutionState {
    return { ...super.createExecutionState(), piOutputBuffer: '', piThinkingBuffer: '', piTextBuffer: '' };
  }

  /**
   * Build prompt for Pi
   */
  override buildPayload(request: ConnectorRequest): string {
    const parts: string[] = [];

    // Add system context if available
    if (agentPromptContext(request.testCase.context).length > 0) {
      parts.push('## Context');
      for (const ctx of agentPromptContext(request.testCase.context)) {
        parts.push(`**${ctx.description}:**`);
        parts.push(ctx.value);
        parts.push('');
      }
    }

    // Add the main prompt
    parts.push('## Task');
    parts.push(request.testCase.initialPrompt);

    return parts.join('\n');
  }

  /**
   * Parse Pi streaming output (JSON format)
   * Pi's --mode json produces NDJSON lines
   */
  protected override parseStreamingOutput(
    chunk: string,
    trajectory: TrajectoryStep[],
    onProgress: ConnectorProgressCallback | undefined,
    state: PiExecutionState
  ): void {
    state.piOutputBuffer += chunk;

    // Parse complete JSON lines (NDJSON format)
    const lines = state.piOutputBuffer.split('\n');
    state.piOutputBuffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const steps = this.parsePiEvent(event, state);
        for (const step of steps) {
          trajectory.push(step);
          onProgress?.(step);
        }
      } catch {
        // Not JSON, treat as plain text
        if (trimmed) {
          const step = this.createStep('assistant', trimmed);
          trajectory.push(step);
          onProgress?.(step);
        }
      }
    }
  }

  /**
   * Parse a single JSON event from Pi output.
   *
   * Pi's --mode json NDJSON format uses these event types:
   *  - session, agent_start, agent_end — lifecycle (ignored)
   *  - turn_start, turn_end — turn boundaries
   *  - message_start / message_end — full message with content blocks
   *  - message_update — streaming deltas with assistantMessageEvent
   */
  private parsePiEvent(event: any, state: PiExecutionState): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    // message_end contains the full final message with all content blocks
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'thinking' && block.thinking) {
            steps.push(this.createStep('thinking', block.thinking));
          } else if (block.type === 'text' && block.text) {
            steps.push(this.createStep('assistant', block.text));
          } else if (block.type === 'tool_use') {
            steps.push(this.createStep('action', JSON.stringify(block.input || {}), {
              toolName: block.name,
              toolArgs: block.input,
            }));
          }
        }
      }
    } else if (event.type === 'message_update') {
      // Streaming deltas — accumulate into buffers
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent?.type === 'text_delta' && assistantEvent.delta) {
        state.piTextBuffer += assistantEvent.delta;
      } else if (assistantEvent?.type === 'thinking_delta' && assistantEvent.delta) {
        state.piThinkingBuffer += assistantEvent.delta;
      }
    } else if (event.type === 'tool_result') {
      const content = event.content || event.output || JSON.stringify(event);
      steps.push(this.createStep('tool_result',
        typeof content === 'string' ? content : JSON.stringify(content),
        { status: event.is_error ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS }
      ));
    } else if (event.type === 'agent_end') {
      // Flush any remaining buffers on agent_end
      if (state.piThinkingBuffer) {
        steps.push(this.createStep('thinking', state.piThinkingBuffer));
        state.piThinkingBuffer = '';
      }
      if (state.piTextBuffer) {
        steps.push(this.createStep('response', state.piTextBuffer));
        state.piTextBuffer = '';
      }
    }

    return steps;
  }

  /**
   * Parse final output for Pi
   */
  override parseResponse(data: { stdout: string; stderr: string; exitCode: number }): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];
    const response = data.stdout.trim();

    if (response) {
      steps.push(this.createStep('response', response));
    }

    if (data.exitCode !== 0 && data.stderr.trim()) {
      steps.push(this.createStep('tool_result', `Error: ${data.stderr.trim()}`, {
        status: ToolCallStatus.FAILURE,
      }));
    }

    return steps;
  }

  /**
   * Flush remaining buffers when the subprocess stream ends.
   */
  protected override onBeforeStreamEnd(
    trajectory: TrajectoryStep[],
    onProgress: ConnectorProgressCallback | undefined,
    state: PiExecutionState
  ): void {
    if (state.piOutputBuffer.trim()) {
      try {
        const event = JSON.parse(state.piOutputBuffer.trim());
        const steps = this.parsePiEvent(event, state);
        for (const step of steps) {
          trajectory.push(step);
          onProgress?.(step);
        }
      } catch {
        const step = this.createStep('assistant', state.piOutputBuffer.trim());
        trajectory.push(step);
        onProgress?.(step);
      }
      state.piOutputBuffer = '';
    }

    if (state.piThinkingBuffer) {
      const step = this.createStep('thinking', state.piThinkingBuffer);
      trajectory.push(step);
      onProgress?.(step);
      state.piThinkingBuffer = '';
    }

    if (state.piTextBuffer) {
      const step = this.createStep('response', state.piTextBuffer);
      trajectory.push(step);
      onProgress?.(step);
      state.piTextBuffer = '';
    }
  }

  /**
   * Translate `PiConnectorConfig` into the effective per-execution subprocess
   * config. Pure — `this.config` is never written, so concurrent executions
   * on the shared singleton cannot see each other's args / env / timeout.
   */
  protected override resolveExecutionConfig(request: ConnectorRequest) {
    const piConfig = (request.connectorConfig || {}) as PiConnectorConfig;
    const base = super.resolveExecutionConfig({
      ...request,
      connectorConfig: {
        ...(piConfig.env ? { env: piConfig.env } : {}),
        ...(piConfig.timeout !== undefined ? { timeout: piConfig.timeout } : {}),
        ...(piConfig.workingDir ? { workingDir: piConfig.workingDir } : {}),
      },
    });

    // Build additional args from config
    const extraArgs: string[] = [];
    if (piConfig.packagePath) {
      // Pi uses --skill and --extension to load package components
      extraArgs.push('--skill', `${piConfig.packagePath}/skills/*`);
      extraArgs.push('--extension', `${piConfig.packagePath}/extensions/agent-health.ts`);
      extraArgs.push('--append-system-prompt', `${piConfig.packagePath}/prompts/agent-health.md`);
    }
    if (piConfig.model) {
      extraArgs.push('--model', piConfig.model);
    }
    if (piConfig.additionalArgs) {
      extraArgs.push(...piConfig.additionalArgs);
    }
    let args = [...(this.config.args || []), ...extraArgs];

    // Pass --model flag from request if specified. request.modelId always
    // wins over connectorConfig.model above — strip any --model pair the
    // config block may have already pushed so the final argv carries exactly
    // one --model flag instead of two.
    if (request.modelId) {
      args = [...this.stripModelFlag(args), '--model', request.modelId];
    }

    // Inherit AWS credentials
    const env = { ...(base.env || {}) };
    if (process.env.AWS_PROFILE) env.AWS_PROFILE = process.env.AWS_PROFILE;
    if (process.env.AWS_REGION) env.AWS_REGION = process.env.AWS_REGION;

    return { ...base, args, env };
  }

  /**
   * Remove any `--model <value>` (two-token) or `--model=<value>` (single-
   * token) occurrence from an argv array. Used so `request.modelId` can
   * override `connectorConfig.model` without leaving a stale second
   * `--model` flag in the final argv.
   *
   * This connector only ever generates the two-token form itself, but
   * `connectorConfig.additionalArgs` is user-supplied and could plausibly
   * contain the `--model=value` form, so both are handled (codex_review
   * finding: a stray `--model=value` from `additionalArgs` would otherwise
   * survive alongside the newly-appended two-token flag, recreating the
   * duplicate-flag bug). If a bare `--model` has no following value (or is
   * the last element), only the bare flag is removed — the next token is
   * left alone rather than being swallowed as a "value" when it's actually
   * another flag (codex_review finding: guards against corrupting unrelated
   * malformed argv, e.g. `['--foo', '--model', '--bar']`).
   */
  private stripModelFlag(args: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--model') {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          i++; // also skip the value that follows
        }
        continue;
      }
      if (arg.startsWith('--model=')) {
        continue;
      }
      result.push(arg);
    }
    return result;
  }

  /**
   * Health check - verify pi command exists
   */
  override async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    return super.healthCheck(endpoint || 'pi', auth);
  }
}

/** Singleton instance for registry */
export const piConnector = new PiConnector();

/**
 * Create a Pi connector with the Agent Health package pre-configured
 */
export function createAgentHealthPiConnector(packagePath?: string): PiConnector {
  const args = ['--print', '--mode', 'json'];
  if (packagePath) {
    args.push('--skill', `${packagePath}/skills/*`);
    args.push('--extension', `${packagePath}/extensions/agent-health.ts`);
    args.push('--append-system-prompt', `${packagePath}/prompts/agent-health.md`);
  }
  return new PiConnector({ args });
}
