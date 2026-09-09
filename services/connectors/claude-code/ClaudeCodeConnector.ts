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
 * Upper bound on the tool output text persisted per `tool_result` step
 * (`content` + `toolOutput`). Larger outputs are cut here with an explicit
 * truncation marker carrying the original length, so the judge knows it saw
 * a prefix. The full stream stays in `report.rawEvents`. Sized to cover the
 * largest single results observed live (~28 KB) without doubling every
 * report; the judge's own per-step cap (`AH_JUDGE_TOOL_OUTPUT_CAP`, default
 * 100 KB) is the outer bound.
 */
export const CLAUDE_CODE_MAX_TOOL_OUTPUT_CHARS = 32 * 1024;

/**
 * Per-invocation parse state for one Claude Code subprocess. See
 * {@link SubprocessExecutionState} for why none of this may live on the
 * (singleton) connector instance.
 */
interface ClaudeCodeExecutionState extends SubprocessExecutionState {
  /** Partial trailing NDJSON line carried between stdout chunks. */
  outputBuffer: string;
  thinkingBuffer: string;
  textBuffer: string;
  /**
   * Claude Code's `session_id` (present on every stream-json event). Captured
   * for Strategy D trace correlation — it equals the `session.id` attribute
   * Claude Code stamps on its OTel spans. Surfaced to the report via
   * {@link extraResultMetadata} → `report.sessionId`.
   */
  sessionId?: string;
  /**
   * `tool_use` blocks seen so far, keyed by their id, so the matching
   * `tool_result` block (which only carries `tool_use_id`) can be attributed
   * to a tool name. Entries are consumed on pairing.
   */
  pendingToolUses: Map<string, { name: string; input: unknown }>;
}

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
 * Flatten a stream-json `tool_result` block into the text the model saw.
 * Claude Code emits either a plain string or an array of content blocks
 * (`{type:'text', text}` for MCP/Bash/Read results, `tool_reference` for
 * ToolSearch, …). Text blocks are joined verbatim; anything else is
 * JSON-encoded so no evidence is dropped. Falls back to the event-level
 * `tool_use_result` (a structured mirror of the same result) when the block
 * carries no content at all.
 */
function toolResultText(block: any, event: any): string {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part: any) =>
        part && part.type === 'text' && typeof part.text === 'string' ? part.text : JSON.stringify(part)
      )
      .join('\n');
  }
  if (c != null) return JSON.stringify(c);
  const mirror = event?.tool_use_result;
  if (mirror === undefined || mirror === null) return '';
  return typeof mirror === 'string' ? mirror : JSON.stringify(mirror);
}

/** Cut `text` at `max` chars with an explicit marker carrying the full length. */
export function boundToolOutput(text: string, max: number = CLAUDE_CODE_MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [tool output truncated: showing ${max} of ${text.length} chars]`;
}

/**
 * Claude Code CLI Connector
 * Invokes Claude Code as a subprocess for agent evaluation
 */
export class ClaudeCodeConnector extends SubprocessConnector<ClaudeCodeExecutionState> {
  readonly type = 'claude-code' as const;
  override readonly name = 'Claude Code CLI';

  override traceContext = { propagateEnv: true, serviceName: 'claude-code-agent' };

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

  protected override createExecutionState(): ClaudeCodeExecutionState {
    return {
      ...super.createExecutionState(),
      outputBuffer: '',
      thinkingBuffer: '',
      textBuffer: '',
      pendingToolUses: new Map(),
    };
  }

  /**
   * Parse Claude Code streaming output (stream-json format)
   * Each line is a JSON object with type and content
   */
  protected override parseStreamingOutput(
    chunk: string,
    trajectory: TrajectoryStep[],
    onProgress: ConnectorProgressCallback | undefined,
    state: ClaudeCodeExecutionState
  ): void {
    state.outputBuffer += chunk;

    // Parse complete JSON lines (NDJSON format)
    const lines = state.outputBuffer.split('\n');
    state.outputBuffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const steps = this.parseJsonEvent(event, state);
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
  private parseJsonEvent(event: any, state: ClaudeCodeExecutionState): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    // Capture the session id (present on system/init, assistant, user, result
    // events). Used for Strategy D trace correlation (attributes.session.id).
    if (typeof event.session_id === 'string' && event.session_id) {
      state.sessionId = event.session_id;
    }

    // Handle different event types from Claude Code stream-json
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          steps.push(this.createStep('thinking', block.thinking));
        } else if (block.type === 'text' && block.text) {
          steps.push(this.createStep('assistant', block.text));
        } else if (block.type === 'tool_use') {
          if (typeof block.id === 'string' && block.id) {
            state.pendingToolUses.set(block.id, { name: block.name, input: block.input });
          }
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
      //
      // Each result is paired with its `tool_use` by id so the step carries
      // the tool name, and the (bounded) output text is stored on BOTH
      // `content` and `toolOutput`. `toolOutput` is what the judge and the
      // trajectory-merge policy (services/traces/trajectoryMerge.ts) treat as
      // evidence; without it a span-derived "tool succeeded" stub could
      // replace a 28 KB retrieval result.
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const paired =
            typeof block.tool_use_id === 'string' ? state.pendingToolUses.get(block.tool_use_id) : undefined;
          if (paired && typeof block.tool_use_id === 'string') state.pendingToolUses.delete(block.tool_use_id);
          const output = boundToolOutput(toolResultText(block, event));
          steps.push(
            this.createStep('tool_result', output, {
              status: block.is_error ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS,
              ...(paired?.name ? { toolName: paired.name } : {}),
              ...(output ? { toolOutput: output } : {}),
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
        state.thinkingBuffer += event.delta.thinking;
      } else if (event.delta?.type === 'text_delta' && event.delta.text) {
        // Accumulate text deltas; the 'result' event will emit the final response
        state.textBuffer += event.delta.text;
      }
    } else if (event.type === 'content_block_stop') {
      // Flush thinking buffer when block ends
      if (state.thinkingBuffer) {
        steps.push(this.createStep('thinking', state.thinkingBuffer));
        state.thinkingBuffer = '';
      }
      // Flush text buffer when block ends (consolidated assistant step)
      if (state.textBuffer) {
        steps.push(this.createStep('assistant', state.textBuffer));
        state.textBuffer = '';
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
   * Flush remaining buffers when the subprocess stream ends.
   */
  protected override onBeforeStreamEnd(
    trajectory: TrajectoryStep[],
    onProgress: ConnectorProgressCallback | undefined,
    state: ClaudeCodeExecutionState
  ): void {
    // Flush outputBuffer (incomplete NDJSON line)
    if (state.outputBuffer.trim()) {
      try {
        const event = JSON.parse(state.outputBuffer.trim());
        const steps = this.parseJsonEvent(event, state);
        for (const step of steps) {
          trajectory.push(step);
          onProgress?.(step);
        }
      } catch {
        const step = this.createStep('assistant', state.outputBuffer.trim());
        trajectory.push(step);
        onProgress?.(step);
      }
      state.outputBuffer = '';
    }

    // Flush thinkingBuffer
    if (state.thinkingBuffer) {
      const step = this.createStep('thinking', state.thinkingBuffer);
      trajectory.push(step);
      onProgress?.(step);
      state.thinkingBuffer = '';
    }

    // Flush textBuffer (text deltas received without a result event)
    if (state.textBuffer) {
      const step = this.createStep('response', state.textBuffer);
      trajectory.push(step);
      onProgress?.(step);
      state.textBuffer = '';
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
   * Translate `ClaudeCodeConnectorConfig` (the agent's `connectorConfig`) into
   * the effective per-execution subprocess config. Pure: builds a fresh
   * snapshot from the constructor defaults — `this.config` is never written,
   * so concurrent executions on the shared singleton cannot compound each
   * other's flags (spawns were once observed with --append-system-prompt /
   * --allowed-tools duplicated up to 5× at concurrency 3) or swap env /
   * timeout / cwd.
   */
  protected override resolveExecutionConfig(request: ConnectorRequest) {
    const ccConfig = (request.connectorConfig || {}) as ClaudeCodeConnectorConfig;
    const base = super.resolveExecutionConfig({
      ...request,
      // Only `env` / `timeout` / `workingDir` are base-shaped on the Claude
      // Code config; everything else is translated to CLI flags below.
      connectorConfig: {
        ...(ccConfig.env ? { env: ccConfig.env } : {}),
        ...(ccConfig.timeout !== undefined ? { timeout: ccConfig.timeout } : {}),
        ...(ccConfig.workingDir ? { workingDir: ccConfig.workingDir } : {}),
      },
    });
    const configArgs = this.buildConfigArgs(ccConfig);
    if (configArgs.length > 0) this.debug('Config args added:', configArgs);

    let env = base.env || {};
    // When using Bedrock, clear any Anthropic API key to prevent
    // login-managed key from taking precedence and triggering a credit
    // balance check instead of routing through Bedrock.
    if (env.CLAUDE_CODE_USE_BEDROCK === '1') {
      env = { ...env, ANTHROPIC_API_KEY: '' };
      this.debug('Bedrock mode: cleared ANTHROPIC_API_KEY to bypass credit check');
    }

    // The agent's model is owned by its agent-health.config.ts connector
    // config (env.ANTHROPIC_MODEL, or a `--model` flag in connectorConfig.args)
    // — there is no run-level / user-selected agent model. We intentionally do
    // NOT inject a model from the run here.
    return {
      ...base,
      env,
      args: [...(this.config.args || []), ...configArgs],
      ...(ccConfig.usePromptArg ? { inputMode: 'arg' as const } : {}),
    };
  }

  /**
   * Override execute for debug logging around the base implementation.
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
    if (request.connectorConfig) this.debug('Applying connectorConfig:', Object.keys(request.connectorConfig));
    const result = await super.execute(endpoint, request, auth, onProgress, onRawEvent);
    this.debug('super.execute() returned with', result.trajectory.length, 'steps');
    this.debug('========== execute() COMPLETED ==========');
    return result;
  }

  /**
   * Health check - verify claude command exists
   */
  override async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    return super.healthCheck(endpoint || 'claude', auth);
  }

  /**
   * Surface the captured Claude Code `session_id` so the runner can persist it
   * as `report.sessionId` for Strategy D trace correlation. Read from the
   * per-invocation state — never from the instance — so concurrent runs on
   * the shared singleton can't swap session ids.
   */
  protected override extraResultMetadata(state: ClaudeCodeExecutionState): Record<string, any> {
    return {
      ...super.extraResultMetadata(state),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };
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
