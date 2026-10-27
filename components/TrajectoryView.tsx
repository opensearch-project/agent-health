/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { TrajectoryStep, ToolCallStatus } from '@/types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Markdown, hasRealMarkdown } from '@/components/ui/markdown';
import { truncate } from '@/lib/utils';
import { normalizeLegacyUserStep, stepContentText, NO_STEP_TEXT_PLACEHOLDER } from '@/lib/trajectoryStepDisplay';
import { RenderErrorBoundary } from '@/components/ui/render-error-boundary';

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
  user: 'text-cyan-400',
};

const typeBgColors: Record<string, string> = {
  thinking: 'bg-amber-500/5 border-amber-500/20',
  assistant: 'bg-purple-500/5 border-purple-500/20',
  action: 'bg-blue-500/5 border-blue-500/20',
  tool_result: 'bg-opensearch-blue/5 border-opensearch-blue/20',
  response: 'bg-slate-500/5 border-slate-500/20',
  user: 'bg-cyan-500/5 border-cyan-500/20',
};

const isCollapsible = (step: TrajectoryStep, text: string): boolean => {
  return step.type === 'thinking' ||
         (step.type === 'tool_result' && text.length > 100) ||
         text.length > 200;
};

const formatLabel = (step: TrajectoryStep): string => {
  if (step.type === 'action' && step.toolName) {
    return `action · ${step.toolName}`;
  }
  if (step.type === 'tool_result') {
    return 'result';
  }
  if (step.type === 'user') {
    return 'user prompt';
  }
  return step.type;
};

const formatLatency = (ms?: number): string => {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

interface StepCardProps {
  step: TrajectoryStep;
  isExpanded: boolean;
  onToggle: (stepId: string) => void;
}

/**
 * One trajectory step. A separate component (not inline JSX in the list
 * `.map`) on purpose: React evaluates a parent's JSX expressions in the
 * PARENT's render, so an error boundary around inline markup would not catch
 * anything computed there. Giving each step its own component moves all of
 * its render work inside the per-step `RenderErrorBoundary` in
 * {@link TrajectoryView}.
 */
const StepCard: React.FC<StepCardProps> = ({ step: rawStep, isExpanded, onToggle }) => {
  const step = normalizeLegacyUserStep(rawStep);
  // Never read `step.content` directly below this line — persisted reports
  // may carry a missing / null / object `content` (see stepContentText).
  const text = stepContentText(step);
  const collapsible = isCollapsible(step, text);
  const latency = formatLatency(step.latencyMs);
  const failed = step.status === ToolCallStatus.FAILURE;
  const typeColor = failed ? 'text-red-600 dark:text-red-400' : (typeColors[step.type] || 'text-muted-foreground');
  const bgColor = failed ? 'bg-red-500/5 border-red-500/20' : (typeBgColors[step.type] || 'bg-muted/30 border-border/50');

  return (
    <div className={`rounded-md border p-3 ${bgColor}`} data-testid="trajectory-step" data-step-type={step.type}>
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
            onClick={() => onToggle(step.id)}
            className="flex items-start gap-1.5 text-sm text-left w-full hover:text-foreground transition-colors"
          >
            {isExpanded ? (
              <ChevronDown size={14} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight size={14} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
            )}
            <span className="text-muted-foreground">
              {truncate(text, PREVIEW_LENGTH)}
              <span className="text-xs ml-2 text-muted-foreground/60">
                ({text.length} chars)
              </span>
            </span>
          </button>
          {isExpanded && (
            <div className="mt-3 pl-5 text-sm text-foreground/90 border-l-2 border-border/50 ml-1">
              <div className="pl-3">
                {/* tool_result is usually structured (JSON/log) — keep it
                    monospace unless it actually looks like markdown.
                    Everything else (assistant / response / thinking)
                    renders as markdown so headings, bullets, and bold
                    come through as structure, not raw `**`/`#`. */}
                {step.type === 'tool_result' && !hasRealMarkdown(text) ? (
                  <pre className="font-mono text-xs overflow-x-auto whitespace-pre-wrap">{text}</pre>
                ) : (
                  <Markdown>{text}</Markdown>
                )}
              </div>
            </div>
          )}
        </div>
      ) : step.type === 'action' && step.toolArgs ? (
        <pre className="text-xs font-mono text-muted-foreground overflow-x-auto">
          {JSON.stringify(step.toolArgs, null, 2)}
        </pre>
      ) : text.length === 0 ? (
        /* No body at all (e.g. a tool call persisted without `content` and
           without `toolArgs`). Say so instead of rendering an empty card
           that looks like a layout bug. */
        <span className="text-sm italic text-muted-foreground/70" data-testid="trajectory-step-no-text">
          {NO_STEP_TEXT_PLACEHOLDER}
        </span>
      ) : (
        <Markdown className="text-sm text-foreground/90">{text}</Markdown>
      )}
    </div>
  );
};

/**
 * Renders a trajectory as a vertical list of step cards.
 *
 * Each step renders inside its own `RenderErrorBoundary` (and the list inside
 * one more): persisted reports come from many producers, and a step with
 * `content` missing or non-string used to throw mid-render and — with no
 * boundary anywhere above — blank the whole Run inspector. Now the worst a
 * bad step can do is render its own compact error card while every sibling
 * step stays visible.
 */
export const TrajectoryView: React.FC<TrajectoryViewProps> = (props) => (
  <RenderErrorBoundary label="the trajectory">
    <TrajectoryViewInner {...props} />
  </RenderErrorBoundary>
);

const TrajectoryViewInner: React.FC<TrajectoryViewProps> = ({ steps, loading }) => {
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

      {steps.map((step, index) => (
        <RenderErrorBoundary key={step.id ?? index} label={`trajectory step ${index + 1}`}>
          <StepCard step={step} isExpanded={expandedSteps.has(step.id)} onToggle={toggleStep} />
        </RenderErrorBoundary>
      ))}

      {/* Loading indicator */}
      {loading && steps.length > 0 && (
        <div className="text-sm text-muted-foreground animate-pulse p-3">
          Processing...
        </div>
      )}
    </div>
  );
};
