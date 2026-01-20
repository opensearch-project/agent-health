/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight, Wrench, Brain, MessageSquare, CheckCircle2, XCircle } from 'lucide-react';
import { EvaluationReport, BenchmarkRun, TrajectoryStep, ToolCallStatus } from '@/types';
import { calculateTotalLatency } from '@/data/mockComparisonData';
import { cn } from '@/lib/utils';

interface TrajectorySectionProps {
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  useCaseId: string;
}

const StepIcon: React.FC<{ type: TrajectoryStep['type'] }> = ({ type }) => {
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
      return null;
  }
};

const TrajectoryStepItem: React.FC<{ step: TrajectoryStep }> = ({ step }) => {
  const [isOpen, setIsOpen] = useState(false);
  const isFailed = step.status === ToolCallStatus.FAILURE;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="w-full">
        <div
          className={cn(
            'flex items-center gap-2 p-2 rounded hover:bg-muted/50 transition-colors text-left',
            isFailed && 'bg-red-500/10'
          )}
        >
          <div className="flex-shrink-0">
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </div>
          <StepIcon type={step.type} />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium truncate block">
              {step.toolName || step.type}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isFailed && <XCircle size={12} className="text-red-400" />}
            <span className="text-xs text-muted-foreground">
              {step.latencyMs}ms
            </span>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 pl-4 border-l border-border py-2 space-y-2">
          {step.content && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Content:</p>
              <p className="text-xs bg-muted/30 p-2 rounded">{step.content}</p>
            </div>
          )}
          {step.toolArgs && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Arguments:</p>
              <pre className="text-xs bg-muted/30 p-2 rounded overflow-x-auto">
                {JSON.stringify(step.toolArgs, null, 2)}
              </pre>
            </div>
          )}
          {step.toolOutput && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Output:</p>
              <pre className="text-xs bg-muted/30 p-2 rounded overflow-x-auto">
                {typeof step.toolOutput === 'string'
                  ? step.toolOutput
                  : JSON.stringify(step.toolOutput, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const RunTrajectory: React.FC<{
  run: BenchmarkRun;
  report: EvaluationReport | null;
}> = ({ run, report }) => {
  const trajectory = report?.trajectory || [];
  const totalLatency = calculateTotalLatency(trajectory);

  if (!report) {
    return (
      <Card className="bg-card/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{run.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">Not run</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{run.name}</CardTitle>
          <Badge variant="outline" className="text-xs">
            {trajectory.length} steps
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Total: {(totalLatency / 1000).toFixed(2)}s
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[300px]">
          <div className="p-3 space-y-1">
            {trajectory.map((step, index) => (
              <TrajectoryStepItem key={step.id || index} step={step} />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

export const TrajectorySection: React.FC<TrajectorySectionProps> = ({
  runs,
  reports,
  useCaseId,
}) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {runs.map((run) => {
        const result = run.results[useCaseId];
        const report = result?.reportId ? reports[result.reportId] : null;

        return (
          <RunTrajectory key={run.id} run={run} report={report} />
        );
      })}
    </div>
  );
};
