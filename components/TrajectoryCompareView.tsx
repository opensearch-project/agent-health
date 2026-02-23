/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { X, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EvaluationReport, TrajectoryStep, ToolCallStatus } from '@/types';

interface TrajectoryCompareViewProps {
  leftReport: EvaluationReport;
  rightReport: EvaluationReport;
  leftLabel: string;
  rightLabel: string;
  title: string;
  onClose: () => void;
}

export const TrajectoryCompareView: React.FC<TrajectoryCompareViewProps> = ({
  leftReport,
  rightReport,
  leftLabel,
  rightLabel,
  title,
  onClose,
}) => {
  const leftSteps = leftReport.trajectory;
  const rightSteps = rightReport.trajectory;
  const maxSteps = Math.max(leftSteps.length, rightSteps.length);

  const getStepTypeColor = (type: TrajectoryStep['type']) => {
    switch (type) {
      case 'assistant': return 'text-purple-700 bg-purple-100 dark:text-purple-400 dark:bg-purple-500/10';
      case 'action': return 'text-blue-700 bg-blue-100 dark:text-blue-400 dark:bg-blue-500/10';
      case 'tool_result': return 'text-amber-700 bg-amber-100 dark:text-amber-400 dark:bg-amber-500/10';
      case 'response': return 'text-blue-700 bg-blue-100 dark:text-opensearch-blue dark:bg-opensearch-blue/10';
      default: return 'text-muted-foreground bg-muted';
    }
  };

  const getStatusIcon = (status?: ToolCallStatus) => {
    if (status === ToolCallStatus.SUCCESS) {
      return <CheckCircle2 size={12} className="text-green-700 dark:text-green-400" />;
    } else if (status === ToolCallStatus.FAILURE) {
      return <XCircle size={12} className="text-red-700 dark:text-red-400" />;
    }
    return null;
  };

  const formatContent = (content: string, maxLength: number = 300) => {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  };

  const renderStep = (step: TrajectoryStep | undefined, index: number) => {
    if (!step) {
      return (
        <div className="p-3 bg-muted/20 rounded border border-dashed border-muted-foreground/30 text-center text-muted-foreground text-sm">
          No step at this position
        </div>
      );
    }

    return (
      <div className={`p-3 rounded border ${getStepTypeColor(step.type)}`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              Step {index + 1}
            </Badge>
            <span className="text-xs font-medium uppercase">{step.type}</span>
            {step.toolName && (
              <span className="text-xs text-muted-foreground">
                {step.toolName}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {getStatusIcon(step.status)}
            {step.latencyMs && (
              <span className="text-xs text-muted-foreground">
                {step.latencyMs}ms
              </span>
            )}
          </div>
        </div>

        <div className="text-sm">
          {step.type === 'action' && step.toolArgs ? (
            <pre className="text-xs bg-black/20 p-2 rounded overflow-x-auto">
              {JSON.stringify(step.toolArgs, null, 2)}
            </pre>
          ) : (
            <p className="whitespace-pre-wrap">{formatContent(step.content)}</p>
          )}
        </div>
      </div>
    );
  };

  // Check if steps are different
  const areStepsDifferent = (left: TrajectoryStep | undefined, right: TrajectoryStep | undefined) => {
    if (!left || !right) return true;
    if (left.type !== right.type) return true;
    if (left.toolName !== right.toolName) return true;
    if (left.type === 'action' && JSON.stringify(left.toolArgs) !== JSON.stringify(right.toolArgs)) return true;
    return false;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-6xl max-h-[90vh] flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle>{title}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X size={18} />
          </Button>
        </CardHeader>

        {/* Column Headers */}
        <div className="px-6 pb-4 border-b">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{leftLabel}</h3>
                <div className="flex items-center gap-2 mt-1">
                  {leftReport.passFailStatus === 'passed' ? (
                    <Badge className="bg-green-100 text-green-700 border-green-300 dark:bg-green-500/20 dark:text-green-400 dark:border-green-500/30">PASSED</Badge>
                  ) : (
                    <Badge className="bg-red-100 text-red-700 border-red-300 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30">FAILED</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {leftSteps.length} steps
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{rightLabel}</h3>
                <div className="flex items-center gap-2 mt-1">
                  {rightReport.passFailStatus === 'passed' ? (
                    <Badge className="bg-green-100 text-green-700 border-green-300 dark:bg-green-500/20 dark:text-green-400 dark:border-green-500/30">PASSED</Badge>
                  ) : (
                    <Badge className="bg-red-100 text-red-700 border-red-300 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30">FAILED</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {rightSteps.length} steps
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <CardContent className="flex-1 overflow-hidden p-0">
          <ScrollArea className="h-[60vh]">
            <div className="p-6 space-y-4">
              {Array.from({ length: maxSteps }).map((_, index) => {
                const leftStep = leftSteps[index];
                const rightStep = rightSteps[index];
                const isDifferent = areStepsDifferent(leftStep, rightStep);

                return (
                  <div key={index} className="relative">
                    {isDifferent && (
                      <div className="absolute -left-3 top-1/2 -translate-y-1/2">
                        <AlertTriangle size={14} className="text-amber-400" />
                      </div>
                    )}
                    <div className={`grid grid-cols-2 gap-4 ${isDifferent ? 'ring-1 ring-amber-500/30 rounded p-2 -m-2' : ''}`}>
                      {renderStep(leftStep, index)}
                      {renderStep(rightStep, index)}
                    </div>
                  </div>
                );
              })}

              {/* LLM Judge Reasoning Comparison */}
              <div className="border-t pt-4 mt-6">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase mb-4">
                  LLM Judge Reasoning
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-muted/30 rounded">
                    <p className="text-sm whitespace-pre-wrap">
                      {leftReport.llmJudgeReasoning || 'No reasoning available'}
                    </p>
                  </div>
                  <div className="p-3 bg-muted/30 rounded">
                    <p className="text-sm whitespace-pre-wrap">
                      {rightReport.llmJudgeReasoning || 'No reasoning available'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
};
