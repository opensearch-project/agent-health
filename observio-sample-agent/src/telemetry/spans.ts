/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel span helpers for the Observio agent.
 *
 * Creates spans following OpenTelemetry Gen AI semantic conventions so that
 * Agent Health's spanCategorization.ts correctly categorizes them as
 * AGENT / LLM / TOOL spans.
 */

import { SpanKind, SpanStatusCode, type Span, type Context } from '@opentelemetry/api';
import { getTracer, trace, context as otelContext } from './provider';

// Gen AI semantic convention attribute names (matching Agent Health's spanCategorization.ts)
const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';
const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
const ATTR_GEN_AI_REQUEST_ID = 'gen_ai.request.id';
const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
const ATTR_GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
const ATTR_GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
const ATTR_GEN_AI_RESPONSE_FINISH_REASON = 'gen_ai.response.finish_reason';

// Operation name values (matching what spanCategorization.ts checks)
const OP_INVOKE_AGENT = 'invoke_agent';
const OP_CHAT = 'chat';
const OP_EXECUTE_TOOL = 'execute_tool';

/**
 * Start the root agent invocation span.
 * Returns the span and a context carrying it for child span creation.
 */
export function startAgentSpan(runId: string): { span: Span; ctx: Context } {
  const tracer = getTracer();
  const span = tracer.startSpan('invoke_agent observio', {
    kind: SpanKind.SERVER,
    attributes: {
      [ATTR_GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
      [ATTR_GEN_AI_SYSTEM]: 'aws.bedrock',
      [ATTR_GEN_AI_AGENT_NAME]: 'observio',
      [ATTR_GEN_AI_REQUEST_ID]: runId,
    },
  });
  const ctx = trace.setSpan(otelContext.active(), span);
  return { span, ctx };
}

/**
 * Start an LLM call span (child of the agent span).
 */
export function startLLMSpan(
  parentCtx: Context,
  opts: {
    modelId: string;
    temperature?: number;
    maxTokens?: number;
    iteration?: number;
    runId?: string;
  }
): { span: Span; ctx: Context } {
  const tracer = getTracer();
  const spanName = opts.iteration !== undefined
    ? `chat aws.bedrock #${opts.iteration}`
    : 'chat aws.bedrock';

  const span = tracer.startSpan(spanName, {
    kind: SpanKind.CLIENT,
    attributes: {
      [ATTR_GEN_AI_OPERATION_NAME]: OP_CHAT,
      [ATTR_GEN_AI_SYSTEM]: 'aws.bedrock',
      [ATTR_GEN_AI_REQUEST_MODEL]: opts.modelId,
      ...(opts.temperature !== undefined && { [ATTR_GEN_AI_REQUEST_TEMPERATURE]: opts.temperature }),
      ...(opts.maxTokens !== undefined && { [ATTR_GEN_AI_REQUEST_MAX_TOKENS]: opts.maxTokens }),
      ...(opts.iteration !== undefined && { 'gen_ai.request.iteration': opts.iteration }),
      ...(opts.runId && { [ATTR_GEN_AI_REQUEST_ID]: opts.runId }),
    },
  }, parentCtx);
  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}

/**
 * Finalize an LLM span with token usage, response info, and content events.
 */
export function endLLMSpan(
  span: Span,
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    stopReason?: string;
    promptMessages?: any[];
    completionText?: string;
    error?: Error;
  }
): void {
  if (opts.inputTokens !== undefined) {
    span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, opts.inputTokens);
  }
  if (opts.outputTokens !== undefined) {
    span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, opts.outputTokens);
  }
  if (opts.stopReason) {
    span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASON, opts.stopReason);
  }

  // Add prompt content as span event (truncated for size)
  if (opts.promptMessages) {
    try {
      const promptStr = JSON.stringify(opts.promptMessages).slice(0, 5000);
      span.addEvent('gen_ai.content.prompt', {
        'gen_ai.prompt': promptStr,
      });
    } catch { /* ignore serialization errors */ }
  }

  // Add completion content as span event
  if (opts.completionText) {
    try {
      span.addEvent('gen_ai.content.completion', {
        'gen_ai.completion': opts.completionText.slice(0, 5000),
      });
    } catch { /* ignore serialization errors */ }
  }

  if (opts.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: opts.error.message });
  }
  span.end();
}

/**
 * Start a tool execution span (child of the agent span).
 */
export function startToolSpan(
  parentCtx: Context,
  toolName: string,
  opts?: {
    toolInput?: any;
    runId?: string;
  }
): { span: Span; ctx: Context } {
  const tracer = getTracer();
  const span = tracer.startSpan(`execute_tool ${toolName}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      [ATTR_GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
      [ATTR_GEN_AI_TOOL_NAME]: toolName,
      ...(opts?.runId && { [ATTR_GEN_AI_REQUEST_ID]: opts.runId }),
    },
  }, parentCtx);

  // Add input as span event
  if (opts?.toolInput) {
    try {
      span.addEvent('gen_ai.tool.input', {
        'gen_ai.tool.input': typeof opts.toolInput === 'string'
          ? opts.toolInput
          : JSON.stringify(opts.toolInput).slice(0, 3000),
      });
    } catch { /* ignore serialization errors */ }
  }

  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}

/**
 * Finalize a tool execution span.
 */
export function endToolSpan(
  span: Span,
  result?: any,
  error?: Error
): void {
  if (result) {
    try {
      span.addEvent('gen_ai.tool.output', {
        'gen_ai.tool.output': typeof result === 'string' ? result.slice(0, 3000) : JSON.stringify(result).slice(0, 3000),
      });
    } catch { /* ignore serialization errors */ }
  }
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
  span.end();
}
