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
import { RunScore } from '@/components/RunScore';
import { getJudgeMatcherResults } from '@/lib/matchers/judgeAccessor';
import { Markdown } from '@/components/ui/markdown';
import { getJudgeVerdict } from '@/lib/reportVerdict';

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
  const [reasoningOpen, setReasoningOpen] = useState(true);

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

  const verdict = getJudgeVerdict(report);
  const isPassed = verdict?.status === 'passed';
  const improvements = report.improvementStrategies || [];
  // Canonical per-checkpoint judge verdicts (llm-judge matcherResults), with a
  // fallback to the legacy llmJudgeReasoning blob for older RCA-Default reports.
  const judgeMatchers = getJudgeMatcherResults(report as Parameters<typeof getJudgeMatcherResults>[0]);

  // Sort improvements by priority
  const sortedImprovements = [...improvements].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  return (
    <Card className="bg-card/50 min-w-0">
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
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            {/* Generic "Score: X%" with hover-tooltip listing each metric.
                Replaces the hardcoded `Accuracy: X%` which was misleading
                for runs scored by non-RCA-Default evaluators. */}
            <RunScore report={report} />
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Judge verdicts — per-checkpoint matcherResults (canonical surface),
            each with its reasoning. Falls back to the legacy single blob. */}
        <Collapsible open={reasoningOpen} onOpenChange={setReasoningOpen}>
          <CollapsibleTrigger className="w-full">
            <div className="flex items-center gap-2 py-1 rounded hover:bg-muted/50 transition-colors">
              {reasoningOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="text-xs font-medium">Judge Evaluation</span>
              {judgeMatchers.length > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {judgeMatchers.filter((m) => m.pass).length}/{judgeMatchers.length} checks passed
                </Badge>
              )}
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {judgeMatchers.length > 0 ? (
              <div className="space-y-2">
                {judgeMatchers.map((m, i) => (
                  <div key={i} className="bg-muted/30 p-2 rounded">
                    <div className="flex items-start gap-2 text-xs font-medium">
                      {m.pass ? (
                        <CheckCircle2 size={12} className="text-opensearch-blue flex-shrink-0 mt-0.5" />
                      ) : (
                        <XCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
                      )}
                      <span className="flex-1 break-words">{m.description.replace(/^judge:\s*/i, '')}</span>
                      {typeof m.score === 'number' && (
                        <Badge variant="outline" className="text-[10px] flex-shrink-0">{Math.round(m.score * 100)}%</Badge>
                      )}
                    </div>
                    {m.reasoning && (
                      <Markdown className="text-xs text-muted-foreground mt-1.5 leading-relaxed break-words">
                        {m.reasoning}
                      </Markdown>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Markdown className="text-xs text-muted-foreground bg-muted/30 p-2 rounded leading-relaxed break-words">
                {report.llmJudgeReasoning || 'No judge reasoning available.'}
              </Markdown>
            )}
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
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="judge-comparison-grid">
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
