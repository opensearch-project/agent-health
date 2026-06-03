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
import { SubprocessConnector } from '@/services/connectors/subprocess/SubprocessConnector';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
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
 * Pi CLI Connector
 * Invokes pi.dev as a subprocess for agent evaluation
 */
export class PiConnector extends SubprocessConnector {
  readonly type = 'pi' as const;
  override readonly name = 'Pi (pi.dev)';

  override traceContext = { propagateEnv: true, serviceName: 'pi-agent' };

  private piOutputBuffer = '';
  private piThinkingBuffer = '';
  private piTextBuffer = '';

  constructor(config?: Partial<SubprocessConfig>) {
    super({ ...PI_DEFAULT_CONFIG, ...config });
  }

  /**
   * Build prompt for Pi
   */
  override buildPayload(request: ConnectorRequest): string {
    const parts: string[] = [];

    // Add system context if available
    if (request.testCase.context && request.testCase.context.length > 0) {
      parts.push('## Context');
      for (const ctx of request.testCase.context) {
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
    onProgress?: ConnectorProgressCallback
  ): void {
    this.piOutputBuffer += chunk;

    // Parse complete JSON lines (NDJSON format)
    const lines = this.piOutputBuffer.split('\n');
    this.piOutputBuffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const steps = this.parsePiEvent(event);
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
  private parsePiEvent(event: any): TrajectoryStep[] {
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
        this.piTextBuffer += assistantEvent.delta;
      } else if (assistantEvent?.type === 'thinking_delta' && assistantEvent.delta) {
        this.piThinkingBuffer += assistantEvent.delta;
      }
    } else if (event.type === 'tool_result') {
      const content = event.content || event.output || JSON.stringify(event);
      steps.push(this.createStep('tool_result',
        typeof content === 'string' ? content : JSON.stringify(content),
        { status: event.is_error ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS }
      ));
    } else if (event.type === 'agent_end') {
      // Flush any remaining buffers on agent_end
      if (this.piThinkingBuffer) {
        steps.push(this.createStep('thinking', this.piThinkingBuffer));
        this.piThinkingBuffer = '';
      }
      if (this.piTextBuffer) {
        steps.push(this.createStep('response', this.piTextBuffer));
        this.piTextBuffer = '';
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
    onProgress?: ConnectorProgressCallback
  ): void {
    if (this.piOutputBuffer.trim()) {
      try {
        const event = JSON.parse(this.piOutputBuffer.trim());
        const steps = this.parsePiEvent(event);
        for (const step of steps) {
          trajectory.push(step);
          onProgress?.(step);
        }
      } catch {
        const step = this.createStep('assistant', this.piOutputBuffer.trim());
        trajectory.push(step);
        onProgress?.(step);
      }
      this.piOutputBuffer = '';
    }

    if (this.piThinkingBuffer) {
      const step = this.createStep('thinking', this.piThinkingBuffer);
      trajectory.push(step);
      onProgress?.(step);
      this.piThinkingBuffer = '';
    }

    if (this.piTextBuffer) {
      const step = this.createStep('response', this.piTextBuffer);
      trajectory.push(step);
      onProgress?.(step);
      this.piTextBuffer = '';
    }
  }

  /**
   * Reset state and apply connectorConfig
   */
  override async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    this.piOutputBuffer = '';
    this.piThinkingBuffer = '';
    this.piTextBuffer = '';

    // Save original config
    const originalArgs = this.config.args ? [...this.config.args] : [];
    const originalEnv = this.config.env ? structuredClone(this.config.env) : {};
    const originalTimeout = this.config.timeout;
    const originalWorkingDir = this.config.workingDir;

    // Apply connectorConfig
    const piConfig = request.connectorConfig as PiConnectorConfig | undefined;
    if (piConfig) {
      if (piConfig.env) {
        this.config.env = { ...this.config.env, ...piConfig.env };
      }
      if (piConfig.timeout !== undefined) {
        this.config.timeout = piConfig.timeout;
      }
      if (piConfig.workingDir) {
        this.config.workingDir = piConfig.workingDir;
      }

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
      if (extraArgs.length > 0) {
        this.config.args = [...(this.config.args || []), ...extraArgs];
      }
    }

    // Pass --model flag from request if specified
    if (request.modelId) {
      this.config.args = [...(this.config.args || []), '--model', request.modelId];
    }

    // Inherit AWS credentials
    if (process.env.AWS_PROFILE) {
      this.config.env = { ...this.config.env, AWS_PROFILE: process.env.AWS_PROFILE };
    }
    if (process.env.AWS_REGION) {
      this.config.env = { ...this.config.env, AWS_REGION: process.env.AWS_REGION };
    }

    try {
      return await super.execute(endpoint, request, auth, onProgress, onRawEvent);
    } finally {
      // Restore config
      this.config.args = originalArgs;
      this.config.env = originalEnv;
      this.config.timeout = originalTimeout;
      this.config.workingDir = originalWorkingDir;
    }
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
