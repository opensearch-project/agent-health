/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JudgementHeadline — the first thing on the Judge Evaluation tab: the
 * verdict, what decided it, and (for a failure) which check failed with its
 * measured-vs-limit evidence. Built only from the report's own fields
 * (lib/judgement/checks.ts) — never from a model — so it is always current
 * and always matches the checks listed below it.
 */

import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react';
import type { EvaluationReport } from '@/types';
import { buildJudgementHeadline } from '@/lib/judgement/checks';

interface Props {
  report: Pick<EvaluationReport, 'passFailStatus' | 'metricsStatus' | 'failureStage' | 'matcherResults' | 'llmJudgeReasoning' | 'judgeProvider' | 'error'>;
  className?: string;
}

const TONE = {
  passed: { icon: <CheckCircle2 size={18} className="text-green-600 dark:text-green-400 shrink-0 mt-0.5" />, cls: 'border-green-300 bg-green-50/60 dark:border-green-500/30 dark:bg-green-950/20', title: 'text-green-800 dark:text-green-300' },
  failed: { icon: <XCircle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />, cls: 'border-red-300 bg-red-50/60 dark:border-red-500/30 dark:bg-red-950/20', title: 'text-red-800 dark:text-red-300' },
  errored: { icon: <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />, cls: 'border-amber-300 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-950/20', title: 'text-amber-800 dark:text-amber-300' },
  pending: { icon: <Clock size={18} className="text-muted-foreground shrink-0 mt-0.5" />, cls: 'border-border bg-muted/30', title: 'text-foreground' },
} as const;

export const JudgementHeadline: React.FC<Props> = ({ report, className }) => {
  const h = buildJudgementHeadline(report);
  const tone = TONE[h.tone];
  return (
    <div
      className={`rounded-lg border px-4 py-3 flex items-start gap-3 ${tone.cls} ${className ?? ''}`}
      data-testid="judgement-headline"
      data-tone={h.tone}
    >
      {tone.icon}
      <div className="min-w-0">
        <div className={`text-sm font-semibold break-words ${tone.title}`} data-testid="judgement-headline-title">{h.title}</div>
        <div className="text-xs text-muted-foreground mt-0.5" data-testid="judgement-headline-how">{h.how}</div>
      </div>
    </div>
  );
};

export default JudgementHeadline;
