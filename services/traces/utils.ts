/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trace Utility Functions
 */

import { Span } from '@/types';
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
} from '@opentelemetry/semantic-conventions/incubating';

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || isNaN(ms)) return '0ms';
  if (ms >= 60000) {
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(1);
    return `${mins}m ${secs}s`;
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Extract key attributes based on span type
 */
export function getKeyAttributes(span: Span): Record<string, string | number | null> {
  const attrs = span.attributes || {};
  const name = span.name || '';

  // Bedrock/LLM spans
  if (name.startsWith('bedrock.') || name.includes('llm') || name.includes('converse')) {
    return {
      'Model': attrs[ATTR_GEN_AI_REQUEST_MODEL]?.split('.').pop() || attrs[ATTR_GEN_AI_REQUEST_MODEL],
      'Input Tokens': attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS]?.toLocaleString(),
      'Output Tokens': attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]?.toLocaleString(),
      'Temperature': attrs[ATTR_GEN_AI_REQUEST_TEMPERATURE],
    };
  }

  // Tool spans
  if (name.includes('tool')) {
    return {
      'Tool': attrs[ATTR_GEN_AI_TOOL_NAME] || name,
      'Tool Call ID': attrs[ATTR_GEN_AI_TOOL_CALL_ID],
      'MCP Server': attrs['tool.mcp_server'],
    };
  }

  // Default attributes
  return {
    'Service': attrs['service.name'] || attrs['serviceName'],
    'Kind': attrs['spanKind'],
  };
}

/**
 * Estimate token count from text (rough approximation)
 */
export function estimateTokens(text: string | object | null | undefined): number {
  if (!text) return 0;
  const charCount = typeof text === 'string' ? text.length : JSON.stringify(text).length;
  return Math.ceil(charCount / 4);
}

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

/**
 * Parse JSON safely
 */
export function safeParseJSON(str: string): object | string {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
