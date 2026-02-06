/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude Code Connector
 * Specialized subprocess connector for Claude Code CLI
 */

import type { TrajectoryStep } from '@/types';
import { ToolCallStatus } from '@/types';
import { SubprocessConnector } from '@/services/connectors/subprocess/SubprocessConnector';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorProgressCallback,
  SubprocessConfig,
} from '@/services/connectors/types';

/**
 * Default Claude Code configuration
 *
 * Telemetry: Set OTEL_EXPORTER_OTLP_ENDPOINT in your environment to enable
 * OpenTelemetry traces. Claude Code respects standard OTEL env vars.
 */
const CLAUDE_CODE_DEFAULT_CONFIG: Partial<SubprocessConfig> = {
  command: 'claude',
  args: ['--print', '--verbose', '--output-format', 'stream-json'], // Structured JSON output (--verbose required with stream-json)
  env: {
    // These can be overridden by agent config or environment
    DISABLE_PROMPT_CACHING: '1',
    DISABLE_ERROR_REPORTING: '1',
    // Note: DISABLE_TELEMETRY removed - telemetry enabled by default
    // Configure OTEL_EXPORTER_OTLP_ENDPOINT in .env to send traces
  },
  inputMode: 'stdin',
  outputParser: 'streaming',
  timeout: 600000, // 10 minutes for Claude Code
};

/**
 * Claude Code CLI Connector
 * Invokes Claude Code as a subprocess for agent evaluation
 */
export class ClaudeCodeConnector extends SubprocessConnector {
  readonly type = 'claude-code' as const;
  override readonly name = 'Claude Code CLI';

  private outputBuffer = '';
  private thinkingBuffer = '';
  private isInThinking = false;

  constructor(config?: Partial<SubprocessConfig>) {
    super({ ...CLAUDE_CODE_DEFAULT_CONFIG, ...config });
  }

  /**
   * Build prompt for Claude Code
   * Structures the input to get the best RCA results
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
   * Parse Claude Code streaming output (stream-json format)
   * Each line is a JSON object with type and content
   */
  protected override parseStreamingOutput(
    chunk: string,
    trajectory: TrajectoryStep[],
    onProgress?: ConnectorProgressCallback
  ): void {
    this.outputBuffer += chunk;

    // Parse complete JSON lines (NDJSON format)
    const lines = this.outputBuffer.split('\n');
    this.outputBuffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const steps = this.parseJsonEvent(event);
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
   * Parse a single JSON event from stream-json output
   */
  private parseJsonEvent(event: any): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    // Handle different event types from Claude Code stream-json
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
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
    } else if (event.type === 'content_block_delta') {
      // Streaming delta updates
      if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
        this.thinkingBuffer += event.delta.thinking;
      } else if (event.delta?.type === 'text_delta' && event.delta.text) {
        steps.push(this.createStep('assistant', event.delta.text));
      }
    } else if (event.type === 'content_block_stop' && this.thinkingBuffer) {
      // Flush thinking buffer when block ends
      steps.push(this.createStep('thinking', this.thinkingBuffer));
      this.thinkingBuffer = '';
    } else if (event.type === 'result' && event.result) {
      // Final result message
      steps.push(this.createStep('response',
        typeof event.result === 'string' ? event.result : JSON.stringify(event.result)
      ));
    } else if (event.type === 'tool_result') {
      steps.push(this.createStep('tool_result',
        typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
        { status: event.is_error ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS }
      ));
    }

    return steps;
  }

  /**
   * Parse final output for Claude Code
   */
  override parseResponse(data: { stdout: string; stderr: string; exitCode: number }): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];
    let content = data.stdout;

    // Extract thinking blocks
    const thinkingMatches = content.matchAll(/<thinking>([\s\S]*?)<\/thinking>/g);
    for (const match of thinkingMatches) {
      const thinking = match[1].trim();
      if (thinking) {
        steps.push(this.createStep('thinking', thinking));
      }
      content = content.replace(match[0], '');
    }

    // The remaining content is the response
    const response = content.trim();
    if (response) {
      steps.push(this.createStep('response', response));
    }

    // Add error if there was stderr
    if (data.exitCode !== 0 && data.stderr.trim()) {
      steps.push(this.createStep('tool_result', `Error: ${data.stderr.trim()}`, {
        status: ToolCallStatus.FAILURE,
      }));
    }

    return steps;
  }

  /**
   * Reset state for new execution
   */
  private resetState(): void {
    this.outputBuffer = '';
    this.thinkingBuffer = '';
    this.isInThinking = false;
  }

  /**
   * Override execute to reset state
   */
  override async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: (event: any) => void
  ): Promise<import('../types').ConnectorResponse> {
    console.log('[ClaudeCode] ========== execute() STARTED ==========');
    console.log('[ClaudeCode] Endpoint:', endpoint);
    console.log('[ClaudeCode] Test case:', request.testCase.name);
    console.log('[ClaudeCode] Config:', this['config']);
    this.resetState();
    console.log('[ClaudeCode] State reset, calling super.execute()...');
    const result = await super.execute(endpoint, request, auth, onProgress, onRawEvent);
    console.log('[ClaudeCode] super.execute() returned with', result.trajectory.length, 'steps');
    console.log('[ClaudeCode] ========== execute() COMPLETED ==========');
    return result;
  }

  /**
   * Health check - verify claude command exists
   */
  override async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    return super.healthCheck(endpoint || 'claude', auth);
  }
}

/**
 * Create a Claude Code connector with specific Bedrock configuration
 */
export function createBedrockClaudeCodeConnector(): ClaudeCodeConnector {
  return new ClaudeCodeConnector({
    env: {
      AWS_PROFILE: process.env.AWS_PROFILE || 'Bedrock',
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: process.env.AWS_REGION || 'us-west-2',
      DISABLE_PROMPT_CACHING: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1',
    },
  });
}

/**
 * Default instance for convenience
 */
export const claudeCodeConnector = new ClaudeCodeConnector();
