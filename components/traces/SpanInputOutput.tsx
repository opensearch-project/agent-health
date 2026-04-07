/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SpanInputOutput - Display input/output for spans based on OTEL conventions
 *
 * Extracts and displays input/output data from OTEL semantic conventions:
 * - gen_ai.prompt / gen_ai.completion for LLM spans
 * - gen_ai.tool.input / gen_ai.tool.output for tool spans
 * - Various other OTEL conventions for agent spans
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */

import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ArrowLeft,
  Bot,
  Cpu,
  Wrench,
  MessageSquare,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Span } from '@/types';
import { formatDuration } from '@/services/traces/utils';

interface SpanInputOutputProps {
  spans: Span[];
}

interface SpanIOData {
  span: Span;
  category: 'agent' | 'llm' | 'tool' | 'other';
  input: string | null;
  output: string | null;
  toolName?: string;
  modelId?: string;
}

/**
 * Extract content from a span event by name.
 * OTel GenAI semantic conventions store input/output as span events
 * with attributes like { content: "..." } or { body: "..." }.
 */
function getEventContent(span: Span, eventName: string): string | null {
  if (!span.events) return null;
  const event = span.events.find(e => e.name === eventName);
  if (!event?.attributes) return null;
  const value = event.attributes['content'] ||
                event.attributes['body'] ||
                event.attributes['gen_ai.content'] ||
                event.attributes['message'];
  if (!value) return null;
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

/**
 * Extract input/output from span attributes based on OTEL GenAI conventions.
 *
 * Checks both span attributes and span events, supporting:
 * - Standard OTel GenAI: gen_ai.content.prompt / gen_ai.content.completion (events)
 * - gen_ai.input.messages / gen_ai.output.messages (attributes)
 * - Legacy: gen_ai.prompt / gen_ai.completion (attributes)
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */
function extractSpanIO(span: Span): SpanIOData {
  const attrs = span.attributes || {};
  const name = span.name.toLowerCase();

  // Determine category
  let category: SpanIOData['category'] = 'other';
  if (name.includes('agent') || attrs['gen_ai.agent.name']) {
    category = 'agent';
  } else if (name.includes('llm') || name.includes('bedrock') || name.includes('converse') || attrs['gen_ai.system']) {
    category = 'llm';
  } else if (name.includes('tool') || attrs['gen_ai.tool.name']) {
    category = 'tool';
  }

  // Extract input based on category and OTEL conventions
  let input: string | null = null;
  let output: string | null = null;

  // LLM spans - check span events first (standard OTel), then attributes
  if (category === 'llm') {
    input = getEventContent(span, 'gen_ai.content.prompt') ||
            attrs['gen_ai.input.messages'] ||
            attrs['gen_ai.prompt'] ||
            attrs['gen_ai.prompt.0.content'] ||
            attrs['llm.prompts'] ||
            attrs['llm.input_messages'] ||
            attrs['input.value'] ||
            null;

    output = getEventContent(span, 'gen_ai.content.completion') ||
             attrs['gen_ai.output.messages'] ||
             attrs['gen_ai.completion'] ||
             attrs['gen_ai.completion.0.content'] ||
             attrs['llm.completions'] ||
             attrs['llm.output_messages'] ||
             attrs['output.value'] ||
             null;
  }

  // Tool spans - OTel standard: gen_ai.tool.call.arguments / gen_ai.tool.call.result
  if (category === 'tool') {
    input = attrs['gen_ai.tool.call.arguments'] ||
            getEventContent(span, 'gen_ai.tool.input') ||
            attrs['gen_ai.tool.input'] ||
            attrs['tool.input'] ||
            attrs['input.value'] ||
            attrs['tool.parameters'] ||
            null;

    output = attrs['gen_ai.tool.call.result'] ||
             getEventContent(span, 'gen_ai.tool.output') ||
             attrs['gen_ai.tool.output'] ||
             attrs['tool.output'] ||
             attrs['output.value'] ||
             attrs['tool.result'] ||
             null;
  }

  // Agent spans - check events then attributes
  if (category === 'agent') {
    input = getEventContent(span, 'gen_ai.content.prompt') ||
            attrs['gen_ai.input.messages'] ||
            attrs['gen_ai.agent.input'] ||
            attrs['agent.input'] ||
            attrs['input.value'] ||
            attrs['user.message'] ||
            null;

    output = getEventContent(span, 'gen_ai.content.completion') ||
             attrs['gen_ai.output.messages'] ||
             attrs['gen_ai.agent.output'] ||
             attrs['agent.output'] ||
             attrs['output.value'] ||
             attrs['assistant.message'] ||
             null;
  }

  // Generic fallback for any category
  if (!input) {
    input = attrs['input'] || attrs['request'] || attrs['message'] || null;
  }
  if (!output) {
    output = attrs['output'] || attrs['response'] || attrs['result'] || null;
  }

  // Convert objects to JSON string for display
  if (input && typeof input === 'object') {
    input = JSON.stringify(input, null, 2);
  }
  if (output && typeof output === 'object') {
    output = JSON.stringify(output, null, 2);
  }

  return {
    span,
    category,
    input: input as string | null,
    output: output as string | null,
    toolName: attrs['gen_ai.tool.name'] || attrs['tool.name'],
    modelId: attrs['gen_ai.request.model'] || attrs['llm.model_name'] || attrs['gen_ai.system'],
  };
}

// ==================== Sub-Components ====================

interface SpanIOCardProps {
  data: SpanIOData;
}

const SpanIOCard: React.FC<SpanIOCardProps> = ({ data }) => {
  const [expanded, setExpanded] = useState(false);
  const [copiedInput, setCopiedInput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const { span, category, input, output, toolName, modelId } = data;

  const getCategoryIcon = () => {
    switch (category) {
      case 'agent':
        return <Bot size={14} className="text-blue-400" />;
      case 'llm':
        return <Cpu size={14} className="text-purple-400" />;
      case 'tool':
        return <Wrench size={14} className="text-amber-400" />;
      default:
        return <MessageSquare size={14} className="text-gray-400" />;
    }
  };

  const getCategoryColor = () => {
    switch (category) {
      case 'agent':
        return 'border-l-blue-400';
      case 'llm':
        return 'border-l-purple-400';
      case 'tool':
        return 'border-l-amber-400';
      default:
        return 'border-l-gray-400';
    }
  };

  const handleCopy = async (text: string, type: 'input' | 'output') => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === 'input') {
        setCopiedInput(true);
        setTimeout(() => setCopiedInput(false), 2000);
      } else {
        setCopiedOutput(true);
        setTimeout(() => setCopiedOutput(false), 2000);
      }
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Skip spans with no input or output
  if (!input && !output) {
    return null;
  }

  return (
    <Card className={`border-l-4 ${getCategoryColor()}`}>
      <CardHeader className="py-3 px-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {getCategoryIcon()}
            <div>
              <div className="text-sm font-medium">{span.name}</div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {toolName && (
                  <Badge variant="outline" className="text-xs bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30">
                    {toolName}
                  </Badge>
                )}
                {modelId && (
                  <Badge variant="outline" className="text-xs bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/30">
                    {modelId}
                  </Badge>
                )}
                <span>{formatDuration(span.duration || 0)}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {span.status === 'ERROR' ? (
              <XCircle size={16} className="text-red-400" />
            ) : (
              <CheckCircle2 size={16} className="text-green-400" />
            )}
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="px-4 pb-4 pt-0 space-y-4">
          {/* Input */}
          {input && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <ArrowRight size={12} className="text-green-400" />
                  INPUT
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => handleCopy(input, 'input')}
                >
                  {copiedInput ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                </Button>
              </div>
              <pre className="text-xs bg-muted/50 p-3 rounded-md overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                {input}
              </pre>
            </div>
          )}

          {/* Output */}
          {output && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <ArrowLeft size={12} className="text-blue-400" />
                  OUTPUT
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => handleCopy(output, 'output')}
                >
                  {copiedOutput ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                </Button>
              </div>
              <pre className="text-xs bg-muted/50 p-3 rounded-md overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                {output}
              </pre>
            </div>
          )}

          {/* Span Attributes (collapsed by default) */}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              View all attributes ({Object.keys(span.attributes || {}).length})
            </summary>
            <pre className="mt-2 bg-muted/30 p-2 rounded-md overflow-x-auto max-h-48 overflow-y-auto">
              {JSON.stringify(span.attributes, null, 2)}
            </pre>
          </details>
        </CardContent>
      )}
    </Card>
  );
};

// ==================== Main Component ====================

export const SpanInputOutput: React.FC<SpanInputOutputProps> = ({ spans }) => {
  // Extract IO data for all spans and filter to those with input/output
  const spanIOData = spans
    .map(extractSpanIO)
    .filter(data => data.input || data.output);

  // Sort by start time
  spanIOData.sort((a, b) =>
    new Date(a.span.startTime).getTime() - new Date(b.span.startTime).getTime()
  );

  // Group by category for summary
  const categoryCounts = spanIOData.reduce(
    (acc, data) => {
      acc[data.category]++;
      return acc;
    },
    { agent: 0, llm: 0, tool: 0, other: 0 } as Record<string, number>
  );

  if (spanIOData.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <AlertCircle size={48} className="mb-4 opacity-20" />
        <p>No input/output data found in span attributes</p>
        <p className="text-xs mt-2">
          Spans may not include OTEL GenAI semantic convention attributes
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 text-xs">
        <span className="text-muted-foreground">
          {spanIOData.length} spans with I/O data
        </span>
        {categoryCounts.agent > 0 && (
          <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/30">
            <Bot size={10} className="mr-1" />
            Agent: {categoryCounts.agent}
          </Badge>
        )}
        {categoryCounts.llm > 0 && (
          <Badge variant="outline" className="bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/30">
            <Cpu size={10} className="mr-1" />
            LLM: {categoryCounts.llm}
          </Badge>
        )}
        {categoryCounts.tool > 0 && (
          <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30">
            <Wrench size={10} className="mr-1" />
            Tool: {categoryCounts.tool}
          </Badge>
        )}
      </div>

      {/* Span Cards */}
      {spanIOData.map((data, index) => (
        <SpanIOCard key={`${data.span.spanId}-${index}`} data={data} />
      ))}
    </div>
  );
};

export default SpanInputOutput;
