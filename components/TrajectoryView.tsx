/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useMemo, useState } from 'react';
import { TrajectoryStep, ToolCallStatus } from '@/types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Markdown, hasRealMarkdown } from '@/components/ui/markdown';
import { truncate } from '@/lib/utils';
import { normalizeLegacyUserStep } from '@/lib/trajectoryStepDisplay';
import { compactPreview, normalizeStepContent, NormalizedContent } from '@/lib/trajectory/prettifyContent';
import { PrettyContent } from '@/components/trajectory/PrettyContent';

interface TrajectoryViewProps {
  steps: TrajectoryStep[];
  loading?: boolean;
}

const PREVIEW_LENGTH = 80;
/** Collapsed-state preview of a structured (JSON) payload. */
const STRUCTURED_PREVIEW_LENGTH = 140;

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

/**
 * Size of what the row will actually display. For `action` steps that is the
 * parsed `toolArgs` (which may be far larger than a short `content` echo), so
 * a big argument tree is collapsed by default like any other big payload.
 */
const displayedLength = (step: TrajectoryStep): number => {
  if (step.type === 'action' && step.toolArgs && typeof step.toolArgs === 'object') {
    try {
      return Math.max(step.content.length, JSON.stringify(step.toolArgs).length);
    } catch {
      return step.content.length;
    }
  }
  return step.content.length;
};

const isCollapsible = (step: TrajectoryStep): boolean => {
  const len = displayedLength(step);
  return step.type === 'thinking' ||
         (step.type === 'tool_result' && len > 100) ||
         len > 200;
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
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/**
 * What a step's body is made of, decided once per step (memoised in the row):
 * `action` steps prettify their parsed `toolArgs`; everything else prettifies
 * `content` when it parses as JSON (after envelope unwrapping — the MCP
 * `[{type:'text', text:'<json string>'}]` case) and otherwise stays prose.
 */
function structuredSource(step: TrajectoryStep): { source: unknown; raw: string } | null {
  if (step.type === 'action' && step.toolArgs && typeof step.toolArgs === 'object') {
    return { source: step.toolArgs, raw: step.content };
  }
  return { source: step.content, raw: step.content };
}

interface StepRowProps {
  step: TrajectoryStep;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}

const StepRow: React.FC<StepRowProps> = React.memo(({ step, isExpanded, onToggle }) => {
  const collapsible = useMemo(() => isCollapsible(step), [step]);
  const latency = formatLatency(step.latencyMs);
  const failed = step.status === ToolCallStatus.FAILURE;
  const typeColor = failed ? 'text-red-600 dark:text-red-400' : (typeColors[step.type] || 'text-muted-foreground');
  const bgColor = failed ? 'bg-red-500/5 border-red-500/20' : (typeBgColors[step.type] || 'bg-muted/30 border-border/50');

  // Normalise once per step (not per render) — the preview and the expanded
  // body share it, and a 500-step trajectory must not re-parse every result
  // each time one step is toggled.
  const structured = useMemo(() => structuredSource(step), [step]);
  const normalized: NormalizedContent | null = useMemo(
    () => (structured ? normalizeStepContent(structured.source) : null),
    [structured]
  );
  const isJson = normalized?.kind === 'json';

  const preview = isJson
    ? compactPreview(normalized!.value, STRUCTURED_PREVIEW_LENGTH)
    : truncate(step.content, PREVIEW_LENGTH);

  // Tool args are small and the nested query is the interesting part — open
  // one level deeper than results (which can be arbitrarily large).
  const treeDepth = step.type === 'action' ? 3 : 2;

  const renderBody = () => {
    if (isJson && structured) {
      return <PrettyContent content={structured.source} raw={structured.raw} defaultExpandedDepth={treeDepth} testId={`pretty-${step.id}`} />;
    }
    // tool_result is usually structured (JSON/log) — keep it monospace unless
    // it actually looks like markdown. Everything else (assistant / response /
    // thinking) renders as markdown so headings, bullets, and bold come
    // through as structure, not raw `**`/`#`.
    if (step.type === 'tool_result' && !hasRealMarkdown(step.content)) {
      return <pre className="font-mono text-xs overflow-x-auto whitespace-pre-wrap">{step.content}</pre>;
    }
    return <Markdown>{step.content}</Markdown>;
  };

  return (
    <div className={`rounded-md border p-3 ${bgColor}`} data-testid={`trajectory-step-${step.type}`}>
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
            type="button"
            aria-expanded={isExpanded}
            onClick={() => onToggle(step.id)}
            className="flex items-start gap-1.5 text-sm text-left w-full hover:text-foreground transition-colors"
          >
            {isExpanded ? (
              <ChevronDown size={14} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight size={14} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
            )}
            <span className={isJson ? 'text-muted-foreground font-mono text-xs' : 'text-muted-foreground'}>
              {preview}
              <span className="text-xs ml-2 text-muted-foreground/60 font-sans">
                ({step.content.length} chars)
              </span>
            </span>
          </button>
          {isExpanded && (
            <div className="mt-3 pl-5 text-sm text-foreground/90 border-l-2 border-border/50 ml-1">
              <div className="pl-3">{renderBody()}</div>
            </div>
          )}
        </div>
      ) : isJson && structured ? (
        <PrettyContent content={structured.source} raw={structured.raw} defaultExpandedDepth={treeDepth} testId={`pretty-${step.id}`} />
      ) : step.type === 'action' && step.toolArgs ? (
        <pre className="text-xs font-mono text-muted-foreground overflow-x-auto">
          {JSON.stringify(step.toolArgs, null, 2)}
        </pre>
      ) : (
        <Markdown className="text-sm text-foreground/90">{step.content}</Markdown>
      )}
    </div>
  );
});
StepRow.displayName = 'TrajectoryStepRow';

export const TrajectoryView: React.FC<TrajectoryViewProps> = ({ steps, loading }) => {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  // Hoisted so legacy-shape steps get a stable normalised object per `steps`
  // identity (normalizeLegacyUserStep returns a fresh object for those, which
  // would otherwise defeat StepRow's memo on every toggle).
  const normalizedSteps = useMemo(() => steps.map(normalizeLegacyUserStep), [steps]);

  // Stable identity so React.memo on StepRow holds: toggling one step must
  // not re-render the other 499 (each of which may hold an expanded tree).
  const toggleStep = useCallback((stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  }, []);

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

      {normalizedSteps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          isExpanded={expandedSteps.has(step.id)}
          onToggle={toggleStep}
        />
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
