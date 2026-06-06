/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { TrajectoryStep, ToolCallStatus } from '@/types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { truncate } from '@/lib/utils';

interface TrajectoryViewProps {
  steps: TrajectoryStep[];
  loading?: boolean;
}

const PREVIEW_LENGTH = 80;

// Color classes for each step type
const typeColors: Record<string, string> = {
  thinking: 'text-amber-400',
  assistant: 'text-purple-400',
  action: 'text-blue-400',
  tool_result: 'text-opensearch-blue',
  response: 'text-slate-400',
};

const typeBgColors: Record<string, string> = {
  thinking: 'bg-amber-500/5 border-amber-500/20',
  assistant: 'bg-purple-500/5 border-purple-500/20',
  action: 'bg-blue-500/5 border-blue-500/20',
  tool_result: 'bg-opensearch-blue/5 border-opensearch-blue/20',
  response: 'bg-slate-500/5 border-slate-500/20',
};

export const TrajectoryView: React.FC<TrajectoryViewProps> = ({ steps, loading }) => {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const toggleStep = (stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  const isCollapsible = (step: TrajectoryStep): boolean => {
    return step.type === 'thinking' ||
           (step.type === 'tool_result' && step.content.length > 100) ||
           step.content.length > 200;
  };

  const formatLabel = (step: TrajectoryStep): string => {
    if (step.type === 'action' && step.toolName) {
      return `action · ${step.toolName}`;
    }
    if (step.type === 'tool_result') {
      return 'result';
    }
    return step.type;
  };

  const formatLatency = (ms?: number): string => {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="space-y-3">
      {steps.length === 0 && loading && (
        <div className="text-muted-foreground animate-pulse py-8 text-center">
          Initializing agent...
        </div>
      )}

      {steps.length === 0 && !loading && (
        <div className="text-muted-foreground py-8 text-center space-y-2">
          <div className="text-sm">No test case output available</div>
          <div className="text-xs opacity-70">
            The agent did not produce any trajectory steps. Check the Summary tab for error details.
          </div>
        </div>
      )}

      {steps.map((step) => {
        const isExpanded = expandedSteps.has(step.id);
        const collapsible = isCollapsible(step);
        const latency = formatLatency(step.latencyMs);
        const failed = step.status === ToolCallStatus.FAILURE;
        const typeColor = failed ? 'text-red-400' : (typeColors[step.type] || 'text-muted-foreground');
        const bgColor = failed ? 'bg-red-500/5 border-red-500/20' : (typeBgColors[step.type] || 'bg-muted/30 border-border/50');

        return (
          <div key={step.id} className={`rounded-md border p-3 ${bgColor}`}>
            {/* Header line */}
            <div className="flex items-center gap-2 text-xs mb-2">
              <span className={`font-semibold ${typeColor}`}>
                {formatLabel(step)}
              </span>
              {latency && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-mono text-muted-foreground">{latency}</span>
                </>
              )}
            </div>

            {/* Content */}
            {collapsible ? (
              <div>
                <button
                  onClick={() => toggleStep(step.id)}
                  className="flex items-start gap-1.5 text-sm text-left w-full hover:text-foreground transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown size={14} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight size={14} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-muted-foreground">
                    {truncate(step.content, PREVIEW_LENGTH)}
                    <span className="text-xs ml-2 text-muted-foreground/60">
                      ({step.content.length} chars)
                    </span>
                  </span>
                </button>
                {isExpanded && (
                  <div className="mt-3 pl-5 text-sm whitespace-pre-wrap text-foreground/90 border-l-2 border-border/50 ml-1">
                    <div className="pl-3">
                      {step.type === 'tool_result' ? (
                        <pre className="font-mono text-xs overflow-x-auto">{step.content}</pre>
                      ) : (
                        step.content
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : step.type === 'action' && step.toolArgs ? (
              <pre className="text-xs font-mono text-muted-foreground overflow-x-auto">
                {JSON.stringify(step.toolArgs, null, 2)}
              </pre>
            ) : (
              <div className="text-sm text-foreground/90 prose prose-invert prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {step.content}
                </ReactMarkdown>
              </div>
            )}
          </div>
        );
      })}

      {/* Loading indicator */}
      {loading && steps.length > 0 && (
        <div className="text-sm text-muted-foreground animate-pulse p-3">
          Processing...
        </div>
      )}
    </div>
  );
};
