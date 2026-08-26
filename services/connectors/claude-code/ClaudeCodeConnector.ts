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
 * MCP server definition for Claude Code --mcp-config flag
 */
export interface ClaudeCodeMCPServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Configuration options for Claude Code connector
 * Passed via agent.connectorConfig in agent-health.config.ts
 */
export interface ClaudeCodeConnectorConfig {
  env?: Record<string, string>;
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  systemPrompt?: string;
  /** Path to a standard MCP config JSON file (passed to --mcp-config) */
  mcpConfigPath?: string;
  /** Inline MCP server definitions (used when mcpConfigPath is not set) */
  mcpServers?: Record<string, ClaudeCodeMCPServer>;
  strictMcpConfig?: boolean;
  usePromptArg?: boolean;
  workingDir?: string;
  timeout?: number;
  additionalArgs?: string[];
}

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

  override traceContext = { propagateEnv: true, serviceName: 'claude-code-agent' };

  private outputBuffer = '';
  private thinkingBuffer = '';
  private textBuffer = '';
  private isInThinking = false;
  /**
   * Claude Code's `session_id` (present on every stream-json event). Captured
   * for Strategy D trace correlation — it equals the `session.id` attribute
   * Claude Code stamps on its OTel spans. Surfaced to the report via
   * {@link extraResultMetadata}.
   */
  private sessionId?: string;

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

    // Capture the session id (present on system/init, assistant, user, result
    // events). Used for Strategy D trace correlation (attributes.session.id).
    if (typeof event.session_id === 'string' && event.session_id) {
      this.sessionId = event.session_id;
    }

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
    } else if (event.type === 'user' && event.message?.content) {
      // Claude Code emits tool results as user-role messages with tool_result
      // content blocks (referenced back to the assistant's tool_use_id).
      // Without this branch, tool outputs are silently dropped — the trajectory
      // shows the tool calls but not their results.
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const content =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
          steps.push(
            this.createStep('tool_result', content, {
              status: block.is_error ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS,
            })
          );
        } else if (block.type === 'text' && block.text) {
          // Rare: plain text in a user message (e.g., tool-orchestrator follow-ups)
          steps.push(this.createStep('assistant', block.text));
        }
      }
    } else if (event.type === 'content_block_delta') {
      // Streaming delta updates — accumulate into buffers
      if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
        this.thinkingBuffer += event.delta.thinking;
      } else if (event.delta?.type === 'text_delta' && event.delta.text) {
        // Accumulate text deltas; the 'result' event will emit the final response
        this.textBuffer += event.delta.text;
      }
    } else if (event.type === 'content_block_stop') {
      // Flush thinking buffer when block ends
      if (this.thinkingBuffer) {
        steps.push(this.createStep('thinking', this.thinkingBuffer));
        this.thinkingBuffer = '';
      }
      // Flush text buffer when block ends (consolidated assistant step)
      if (this.textBuffer) {
        steps.push(this.createStep('assistant', this.textBuffer));
        this.textBuffer = '';
      }
    } else if (event.type === 'result' && event.result) {
      // Final result message
      steps.push(this.createStep('response',
        typeof event.result === 'string' ? event.result : JSON.stringify(event.result)
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
    this.textBuffer = '';
    this.isInThinking = false;
  }

  /**
   * Flush remaining buffers when the subprocess stream ends.
   */
  protected override onBeforeStreamEnd(
    trajectory: TrajectoryStep[],
    onProgress?: ConnectorProgressCallback
  ): void {
    // Flush outputBuffer (incomplete NDJSON line)
    if (this.outputBuffer.trim()) {
      try {
        const event = JSON.parse(this.outputBuffer.trim());
        const steps = this.parseJsonEvent(event);
        for (const step of steps) {
          trajectory.push(step);
          onProgress?.(step);
        }
      } catch {
        const step = this.createStep('assistant', this.outputBuffer.trim());
        trajectory.push(step);
        onProgress?.(step);
      }
      this.outputBuffer = '';
    }

    // Flush thinkingBuffer
    if (this.thinkingBuffer) {
      const step = this.createStep('thinking', this.thinkingBuffer);
      trajectory.push(step);
      onProgress?.(step);
      this.thinkingBuffer = '';
    }

    // Flush textBuffer (text deltas received without a result event)
    if (this.textBuffer) {
      const step = this.createStep('response', this.textBuffer);
      trajectory.push(step);
      onProgress?.(step);
      this.textBuffer = '';
    }
  }

  /**
   * Build CLI args from ClaudeCodeConnectorConfig
   */
  private buildConfigArgs(config: ClaudeCodeConnectorConfig): string[] {
    const args: string[] = [];

    if (config.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (config.systemPrompt) {
      args.push('--system-prompt', config.systemPrompt);
    } else if (config.appendSystemPrompt) {
      args.push('--append-system-prompt', config.appendSystemPrompt);
    }

    if (config.allowedTools?.length) {
      args.push('--allowed-tools', ...config.allowedTools);
    }

    if (config.disallowedTools?.length) {
      args.push('--disallowed-tools', ...config.disallowedTools);
    }

    if (config.mcpConfigPath) {
      args.push('--mcp-config', config.mcpConfigPath);
    } else if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: config.mcpServers }));
    }

    if (config.strictMcpConfig) {
      args.push('--strict-mcp-config');
    }

    if (config.additionalArgs) {
      args.push(...config.additionalArgs);
    }

    return args;
  }

  /**
   * Override execute to reset state and apply connectorConfig
   */
  override async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: (event: any) => void
  ): Promise<import('../types').ConnectorResponse> {
    this.debug('========== execute() STARTED ==========');
    this.debug('Endpoint:', endpoint);
    this.debug('Test case:', request.testCase.name);
    this.debug('Config:', this['config']);
    this.resetState();

    // Save original config for restoration after execution.
    // Uses structured clone for env to prevent leaking nested mutations
    // between consecutive executions in a benchmark run.
    const originalEnv = this.config.env ? structuredClone(this.config.env) : {};
    const originalArgs = this.config.args ? [...this.config.args] : [];
    const originalInputMode = this.config.inputMode;
    const originalTimeout = this.config.timeout;
    const originalWorkingDir = this.config.workingDir;

    // Apply connectorConfig if provided
    const ccConfig = request.connectorConfig as ClaudeCodeConnectorConfig | undefined;
    if (ccConfig) {
      this.debug('Applying connectorConfig:', Object.keys(ccConfig));

      // Merge environment variables
      if (ccConfig.env) {
        this.config.env = { ...this.config.env, ...ccConfig.env };
      }

      // Switch input mode if requested
      if (ccConfig.usePromptArg) {
        this.config.inputMode = 'arg';
      }

      // Override timeout if specified
      if (ccConfig.timeout !== undefined) {
        this.config.timeout = ccConfig.timeout;
      }

      // Override working directory if specified
      if (ccConfig.workingDir) {
        this.config.workingDir = ccConfig.workingDir;
      }
    }

    // When using Bedrock, clear any Anthropic API key to prevent
    // login-managed key from taking precedence and triggering a credit
    // balance check instead of routing through Bedrock.
    if (this.config.env?.CLAUDE_CODE_USE_BEDROCK === '1') {
      this.config.env = { ...this.config.env, ANTHROPIC_API_KEY: '' };
      this.debug('Bedrock mode: cleared ANTHROPIC_API_KEY to bypass credit check');
    }

    // The agent's model is owned by its agent-health.config.ts connector
    // config (env.ANTHROPIC_MODEL, or a `--model` flag in connectorConfig.args)
    // — there is no run-level / user-selected agent model. We intentionally do
    // NOT inject a model from the run here.

    // Append config-driven args
    if (ccConfig) {
      const configArgs = this.buildConfigArgs(ccConfig);
      if (configArgs.length > 0) {
        this.config.args = [...(this.config.args || []), ...configArgs];
        this.debug('Config args added:', configArgs);
      }
    }

    try {
      this.debug('State reset, calling super.execute()...');
      this.sessionId = undefined;
      const result = await super.execute(endpoint, request, auth, onProgress, onRawEvent);
      this.debug('super.execute() returned with', result.trajectory.length, 'steps');
      this.debug('========== execute() COMPLETED ==========');
      return result;
    } finally {
      // Restore config to pre-execution state. Uses deep copies to prevent
      // config pollution between consecutive executions in a benchmark run.
      this.config.env = originalEnv;
      this.config.args = originalArgs;
      this.config.inputMode = originalInputMode;
      this.config.timeout = originalTimeout;
      this.config.workingDir = originalWorkingDir;
    }
  }

  /**
   * Health check - verify claude command exists
   */
  override async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    return super.healthCheck(endpoint || 'claude', auth);
  }

  /**
   * Surface the captured Claude Code `session_id` so the runner can persist it
   * as `report.sessionId` for Strategy D trace correlation.
   */
  protected override extraResultMetadata(): Record<string, any> {
    return this.sessionId ? { sessionId: this.sessionId } : {};
  }
}

/**
 * Create a Claude Code connector with specific Bedrock configuration
 */
export function createBedrockClaudeCodeConnector(): ClaudeCodeConnector {
  const env: Record<string, string> = {
    AWS_PROFILE: process.env.AWS_PROFILE || 'Bedrock',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: '', // Prevent login-managed key from overriding Bedrock
    AWS_REGION: process.env.AWS_REGION || 'us-west-2',
    DISABLE_PROMPT_CACHING: '1',
    DISABLE_ERROR_REPORTING: '1',
  };

  const telemetryEnabled = process.env.CLAUDE_CODE_TELEMETRY_ENABLED === 'true';
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (telemetryEnabled && otelEndpoint) {
    env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    env.OTEL_EXPORTER_OTLP_ENDPOINT = otelEndpoint;
    env.OTEL_TRACES_EXPORTER = 'otlp';
    env.OTEL_METRICS_EXPORTER = 'otlp';
    env.OTEL_LOGS_EXPORTER = 'otlp';
    // Log the user prompt as a log record attribute so the run's prompt is
    // visible in the Traces view. Opt-out via OTEL_LOG_USER_PROMPTS=0.
    env.OTEL_LOG_USER_PROMPTS = process.env.OTEL_LOG_USER_PROMPTS ?? '1';
    if (process.env.OTEL_SERVICE_NAME) env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME;
    if (process.env.OTEL_EXPORTER_OTLP_PROTOCOL) env.OTEL_EXPORTER_OTLP_PROTOCOL = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    if (process.env.OTEL_EXPORTER_OTLP_HEADERS) env.OTEL_EXPORTER_OTLP_HEADERS = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  } else {
    env.DISABLE_TELEMETRY = '1';
  }

  return new ClaudeCodeConnector({ env });
}

/**
 * Default instance for convenience
 */
export const claudeCodeConnector = new ClaudeCodeConnector();
