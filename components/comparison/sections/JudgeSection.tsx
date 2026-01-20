/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { EvaluationReport, BenchmarkRun, ImprovementStrategy } from '@/types';
import { cn } from '@/lib/utils';

interface JudgeSectionProps {
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  useCaseId: string;
}

const priorityColors: Record<string, string> = {
  high: 'bg-red-500/10 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  low: 'bg-opensearch-blue/10 text-opensearch-blue border-opensearch-blue/30',
};

const ImprovementItem: React.FC<{ strategy: ImprovementStrategy }> = ({ strategy }) => {
  return (
    <div className="p-2 rounded border border-border bg-muted/20">
      <div className="flex items-start gap-2">
        <Badge
          variant="outline"
          className={cn('text-xs flex-shrink-0', priorityColors[strategy.priority])}
        >
          {strategy.priority}
        </Badge>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground">{strategy.issue}</p>
          <p className="text-xs text-muted-foreground mt-1">{strategy.recommendation}</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Category: {strategy.category}</p>
        </div>
      </div>
    </div>
  );
};

const RunJudgeCard: React.FC<{
  run: BenchmarkRun;
  report: EvaluationReport | null;
}> = ({ run, report }) => {
  const [reasoningOpen, setReasoningOpen] = useState(false);

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

  const isPassed = report.passFailStatus === 'passed';
  const improvements = report.improvementStrategies || [];

  // Sort improvements by priority
  const sortedImprovements = [...improvements].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  return (
    <Card className="bg-card/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{run.name}</CardTitle>
          <Badge
            variant="outline"
            className={cn(
              'text-xs',
              isPassed
                ? 'bg-opensearch-blue/10 text-opensearch-blue border-opensearch-blue/30'
                : 'bg-red-500/10 text-red-400 border-red-500/30'
            )}
          >
            <span className="flex items-center gap-1">
              {isPassed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
              {isPassed ? 'PASSED' : 'FAILED'}
            </span>
          </Badge>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">
            Accuracy: {report.metrics.accuracy}%
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Reasoning */}
        <Collapsible open={reasoningOpen} onOpenChange={setReasoningOpen}>
          <CollapsibleTrigger className="w-full">
            <div className="flex items-center gap-2 py-1 rounded hover:bg-muted/50 transition-colors">
              {reasoningOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="text-xs font-medium">LLM Judge Reasoning</span>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="text-xs text-muted-foreground bg-muted/30 p-2 rounded leading-relaxed whitespace-pre-wrap break-words">
              {report.llmJudgeReasoning}
            </p>
          </CollapsibleContent>
        </Collapsible>

        {/* Improvements */}
        {sortedImprovements.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={14} className="text-amber-400" />
              <span className="text-xs font-medium">Improvement Strategies</span>
              <Badge variant="outline" className="text-xs">
                {sortedImprovements.length}
              </Badge>
            </div>
            <ScrollArea className="h-[150px]">
              <div className="space-y-2 pr-2">
                {sortedImprovements.map((strategy, index) => (
                  <ImprovementItem key={index} strategy={strategy} />
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {sortedImprovements.length === 0 && (
          <div className="flex items-center justify-center py-4 text-muted-foreground">
            <CheckCircle2 size={16} className="mr-2 text-opensearch-blue" />
            <span className="text-xs">No improvements needed</span>
          </div>
        )}

        {/* Token usage summary */}
        {report.llmJudgeResponse && (
          <div className="pt-2 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Judge tokens: {report.llmJudgeResponse.promptTokens?.toLocaleString()} prompt +{' '}
              {report.llmJudgeResponse.completionTokens?.toLocaleString()} completion
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export const JudgeSection: React.FC<JudgeSectionProps> = ({
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
          <RunJudgeCard key={run.id} run={run} report={report} />
        );
      })}
    </div>
  );
};
