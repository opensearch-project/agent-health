/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verdict summary for the run-report Judge tab.
 *
 * Renders what the canonical verdict engine decided for this report and how:
 *
 *   Verdict: passed (policy: score ≥ 0.7) · LLM said: failed ⚠ conflict
 *   Score 72% · scored 3 / 4 rubrics · fact_precision: not evaluable
 *
 * Reads ONLY the report (its `scoringSnapshot`, `passFailStatus`,
 * `llmVerdict`, `verdictConflict`, `metrics`) — never today's evaluator.
 * A report the judge errored on renders the "no metrics" state instead of
 * zeros; a pre-snapshot report renders nothing (legacy scoring is labelled
 * elsewhere).
 */

import React from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { EvaluationReport } from '@/types';
import { passPolicyLabel } from '@/lib/comparison/scoringDisplay';
import { hasUsableSnapshot, scoreFromSnapshot } from '@/lib/scoring/snapshotScore';
import { Badge } from '@/components/ui/badge';

interface VerdictSummaryProps {
  report: Pick<EvaluationReport, 'scoringSnapshot' | 'passFailStatus' | 'llmVerdict' | 'verdictConflict' | 'metrics' | 'metricsStatus' | 'score'>;
  className?: string;
}

const humanize = (name: string) => name.replace(/_/g, ' ');

export const VerdictSummary: React.FC<VerdictSummaryProps> = ({ report, className }) => {
  if (report.metricsStatus === 'error') {
    return (
      <div
        data-testid="verdict-summary"
        data-verdict-state="no-metrics"
        className={`rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground ${className ?? ''}`}
      >
        <span className="font-medium text-foreground">No verdict</span> — the judge did not complete, so no
        metrics were recorded for this report (it counts as <span className="font-medium">errored</span>, not failed,
        and is excluded from the pass rate).
      </div>
    );
  }
  if (!hasUsableSnapshot(report) || !report.passFailStatus) return null;

  const snapshot = report.scoringSnapshot;
  const scored = scoreFromSnapshot(report);
  const policy = passPolicyLabel(snapshot.passPolicy);
  const passed = report.passFailStatus === 'passed';
  const llmVerdict = report.llmVerdict;
  const conflict = report.verdictConflict === true;
  const unevaluable = scored.source === 'snapshot' ? scored.unevaluable : [];
  const scoreValue = scored.source === 'snapshot' ? scored.score : null;

  return (
    <div
      data-testid="verdict-summary"
      data-verdict-state={conflict ? 'conflict' : 'agree'}
      className={`rounded-md border px-3 py-2 text-sm space-y-1 ${
        conflict ? 'border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/20' : ''
      } ${className ?? ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {passed ? (
          <CheckCircle2 size={16} className="text-green-600 dark:text-green-400 shrink-0" />
        ) : (
          <XCircle size={16} className="text-red-600 dark:text-red-400 shrink-0" />
        )}
        <span data-testid="verdict-line">
          <span className="font-semibold">Verdict:</span>{' '}
          <span className={passed ? 'text-green-700 dark:text-green-400 font-medium' : 'text-red-700 dark:text-red-400 font-medium'}>
            {report.passFailStatus}
          </span>{' '}
          <span className="text-muted-foreground">(policy: {policy})</span>
          {llmVerdict && snapshot.passPolicy.kind !== 'llm-verdict' && (
            <>
              <span className="text-muted-foreground"> · LLM said: </span>
              <span className="font-medium">{llmVerdict}</span>
            </>
          )}
        </span>
        {conflict && (
          <Badge
            variant="outline"
            data-testid="verdict-conflict"
            className="gap-1 border-amber-400 text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle size={12} /> conflict
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-testid="verdict-score">
          Avg score:{' '}
          <span className="font-medium text-foreground">
            {scoreValue === null ? '—' : `${Math.round(scoreValue * 100)}%`}
          </span>
        </span>
        {scored.source === 'snapshot' && (
          <span>
            scored {scored.scored} / {scored.total} rubrics
          </span>
        )}
        {snapshot.evaluatorName && (
          <span>
            evaluator {snapshot.evaluatorName} v{snapshot.evaluatorVersion}
          </span>
        )}
        {unevaluable.map(name => (
          <span key={name} data-testid="verdict-unevaluable" className="italic">
            {humanize(name)}: not evaluable
          </span>
        ))}
      </div>
    </div>
  );
};

export default VerdictSummary;
