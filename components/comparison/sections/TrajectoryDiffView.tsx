/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  ArrowRightLeft,
  Equal,
  Wrench,
  Brain,
  MessageSquare,
  CheckCircle2,
} from 'lucide-react';
import { EvaluationReport, BenchmarkRun, TrajectoryStep } from '@/types';
import {
  alignTrajectories,
  calculateDiffStats,
  compareJsonObjects,
  AlignedStep,
  DiffStats,
} from '@/services/trajectoryDiffService';
import { cn } from '@/lib/utils';

interface TrajectoryDiffViewProps {
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  useCaseId: string;
}

const StepIcon: React.FC<{ type?: TrajectoryStep['type'] }> = ({ type }) => {
  switch (type) {
    case 'assistant':
      return <Brain size={14} className="text-purple-400" />;
    case 'action':
      return <Wrench size={14} className="text-blue-400" />;
    case 'tool_result':
      return <CheckCircle2 size={14} className="text-opensearch-blue" />;
    case 'response':
      return <MessageSquare size={14} className="text-amber-400" />;
    default:
      return <Wrench size={14} className="text-muted-foreground" />;
  }
};

const DiffTypeIcon: React.FC<{ type: AlignedStep['type'] }> = ({ type }) => {
  switch (type) {
    case 'added':
      return <Plus size={14} className="text-opensearch-blue" />;
    case 'removed':
      return <Minus size={14} className="text-red-400" />;
    case 'modified':
      return <ArrowRightLeft size={14} className="text-amber-400" />;
    case 'matched':
      return <Equal size={14} className="text-muted-foreground" />;
    default:
      return null;
  }
};

const diffTypeStyles: Record<AlignedStep['type'], string> = {
  added: 'bg-opensearch-blue/10 border-l-4 border-l-opensearch-blue',
  removed: 'bg-red-500/10 border-l-4 border-l-red-500',
  modified: 'bg-amber-500/10 border-l-4 border-l-amber-500',
  matched: 'bg-background',
};

const diffTypeBadgeStyles: Record<AlignedStep['type'], string> = {
  added: 'bg-opensearch-blue/20 text-opensearch-blue border-opensearch-blue/30',
  removed: 'bg-red-500/20 text-red-400 border-red-500/30',
  modified: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  matched: 'bg-muted text-muted-foreground',
};

const DiffStepRow: React.FC<{
  aligned: AlignedStep;
  baselineRunName: string;
  comparisonRunName: string;
}> = ({ aligned, baselineRunName, comparisonRunName }) => {
  const [isOpen, setIsOpen] = useState(false);
  const step = aligned.baselineStep || aligned.comparisonStep;

  const latencyDelta = useMemo(() => {
    if (aligned.baselineStep?.latencyMs && aligned.comparisonStep?.latencyMs) {
      return aligned.comparisonStep.latencyMs - aligned.baselineStep.latencyMs;
    }
    return null;
  }, [aligned]);

  const argsDiff = useMemo(() => {
    if (aligned.type === 'modified' && aligned.baselineStep?.toolArgs && aligned.comparisonStep?.toolArgs) {
      return compareJsonObjects(
        aligned.baselineStep.toolArgs as Record<string, unknown>,
        aligned.comparisonStep.toolArgs as Record<string, unknown>
      );
    }
    return null;
  }, [aligned]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="w-full">
        <div
          className={cn(
            'flex items-center gap-3 p-3 rounded transition-colors hover:bg-muted/30',
            diffTypeStyles[aligned.type]
          )}
        >
          <div className="flex-shrink-0">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
          <DiffTypeIcon type={aligned.type} />
          <StepIcon type={step?.type} />
          <div className="flex-1 min-w-0 text-left">
            <span className="text-sm font-medium truncate block">
              {step?.toolName || step?.type || 'Unknown'}
            </span>
          </div>
          <Badge variant="outline" className={cn('text-xs', diffTypeBadgeStyles[aligned.type])}>
            {aligned.type}
          </Badge>
          {latencyDelta !== null && (
            <span className={cn(
              'text-xs',
              latencyDelta < 0 ? 'text-opensearch-blue' : latencyDelta > 0 ? 'text-red-400' : 'text-muted-foreground'
            )}>
              {latencyDelta > 0 ? '+' : ''}{latencyDelta}ms
            </span>
          )}
          {step?.latencyMs && !latencyDelta && (
            <span className="text-xs text-muted-foreground">{step.latencyMs}ms</span>
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn('ml-8 p-3 space-y-3 border-l', diffTypeStyles[aligned.type])}>
          {/* Show diff details for modified steps */}
          {aligned.type === 'modified' && argsDiff && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Arguments Diff:</p>
              <div className="text-xs space-y-1 bg-muted/20 p-2 rounded font-mono">
                {argsDiff.removed.map((key) => (
                  <div key={`rem-${key}`} className="text-red-400">
                    - {key}: {JSON.stringify((aligned.baselineStep?.toolArgs as Record<string, unknown>)?.[key])}
                  </div>
                ))}
                {argsDiff.added.map((key) => (
                  <div key={`add-${key}`} className="text-opensearch-blue">
                    + {key}: {JSON.stringify((aligned.comparisonStep?.toolArgs as Record<string, unknown>)?.[key])}
                  </div>
                ))}
                {argsDiff.modified.map((mod) => (
                  <div key={`mod-${mod.key}`}>
                    <div className="text-red-400">- {mod.key}: {JSON.stringify(mod.oldValue)}</div>
                    <div className="text-opensearch-blue">+ {mod.key}: {JSON.stringify(mod.newValue)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Side-by-side comparison for matched/modified */}
          {(aligned.type === 'matched' || aligned.type === 'modified') && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">{baselineRunName}</p>
                {aligned.baselineStep?.toolArgs && (
                  <pre className="text-xs bg-muted/30 p-2 rounded overflow-x-auto">
                    {JSON.stringify(aligned.baselineStep.toolArgs, null, 2)}
                  </pre>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">{comparisonRunName}</p>
                {aligned.comparisonStep?.toolArgs && (
                  <pre className="text-xs bg-muted/30 p-2 rounded overflow-x-auto">
                    {JSON.stringify(aligned.comparisonStep.toolArgs, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* Show single step details for added/removed */}
          {(aligned.type === 'added' || aligned.type === 'removed') && step && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {aligned.type === 'added' ? comparisonRunName : baselineRunName}
              </p>
              {step.content && (
                <p className="text-xs bg-muted/30 p-2 rounded mb-2">{step.content}</p>
              )}
              {step.toolArgs && (
                <pre className="text-xs bg-muted/30 p-2 rounded overflow-x-auto">
                  {JSON.stringify(step.toolArgs, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const DiffStatsCard: React.FC<{ stats: DiffStats }> = ({ stats }) => {
  const latencyDelta = stats.comparisonLatencyMs - stats.baselineLatencyMs;

  return (
    <Card className="bg-card/50 mb-4">
      <CardContent className="p-3">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-4">
            <span className="text-muted-foreground">
              {stats.baselineSteps} → {stats.comparisonSteps} steps
            </span>
            <Badge variant="outline" className="bg-muted/50">
              <Equal size={10} className="mr-1" />
              {stats.matchedCount} matched
            </Badge>
            {stats.addedCount > 0 && (
              <Badge variant="outline" className="bg-opensearch-blue/20 text-opensearch-blue border-opensearch-blue/30">
                <Plus size={10} className="mr-1" />
                {stats.addedCount} added
              </Badge>
            )}
            {stats.removedCount > 0 && (
              <Badge variant="outline" className="bg-red-500/20 text-red-400 border-red-500/30">
                <Minus size={10} className="mr-1" />
                {stats.removedCount} removed
              </Badge>
            )}
            {stats.modifiedCount > 0 && (
              <Badge variant="outline" className="bg-amber-500/20 text-amber-400 border-amber-500/30">
                <ArrowRightLeft size={10} className="mr-1" />
                {stats.modifiedCount} modified
              </Badge>
            )}
          </div>
          <span className={cn(
            'text-xs',
            latencyDelta < 0 ? 'text-opensearch-blue' : latencyDelta > 0 ? 'text-red-400' : 'text-muted-foreground'
          )}>
            {latencyDelta > 0 ? '+' : ''}{(latencyDelta / 1000).toFixed(2)}s total
          </span>
        </div>
      </CardContent>
    </Card>
  );
};

export const TrajectoryDiffView: React.FC<TrajectoryDiffViewProps> = ({
  runs,
  reports,
  useCaseId,
}) => {
  // Only compare first two runs (baseline vs comparison)
  const baselineRun = runs[0];
  const comparisonRun = runs[1];

  const baselineReport = baselineRun?.results[useCaseId]?.reportId
    ? reports[baselineRun.results[useCaseId].reportId]
    : null;
  const comparisonReport = comparisonRun?.results[useCaseId]?.reportId
    ? reports[comparisonRun.results[useCaseId].reportId]
    : null;

  const baselineTrajectory = baselineReport?.trajectory || [];
  const comparisonTrajectory = comparisonReport?.trajectory || [];

  const alignedSteps = useMemo(() => {
    return alignTrajectories(baselineTrajectory, comparisonTrajectory);
  }, [baselineTrajectory, comparisonTrajectory]);

  const stats = useMemo(() => {
    return calculateDiffStats(alignedSteps, baselineTrajectory, comparisonTrajectory);
  }, [alignedSteps, baselineTrajectory, comparisonTrajectory]);

  if (!baselineRun || !comparisonRun) {
    return (
      <Card className="bg-card/50">
        <CardContent className="py-8 text-center text-muted-foreground">
          Select at least 2 runs to see diff view
        </CardContent>
      </Card>
    );
  }

  if (!baselineReport && !comparisonReport) {
    return (
      <Card className="bg-card/50">
        <CardContent className="py-8 text-center text-muted-foreground">
          No trajectory data available for comparison
        </CardContent>
      </Card>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm">
          <span className="text-muted-foreground">Comparing: </span>
          <span className="font-medium">{baselineRun.name}</span>
          <span className="text-muted-foreground"> (baseline) vs </span>
          <span className="font-medium">{comparisonRun.name}</span>
        </div>
      </div>

      <DiffStatsCard stats={stats} />

      <ScrollArea className="h-[400px]">
        <div className="space-y-1">
          {alignedSteps.map((aligned, index) => (
            <DiffStepRow
              key={index}
              aligned={aligned}
              baselineRunName={baselineRun.name}
              comparisonRunName={comparisonRun.name}
            />
          ))}
        </div>
      </ScrollArea>

      {runs.length > 2 && (
        <p className="text-xs text-muted-foreground mt-3">
          Note: Diff view compares first two runs only. Select fewer runs for diff comparison.
        </p>
      )}
    </div>
  );
};
