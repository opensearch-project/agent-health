/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunInsightsPane — the right-side pane shown on the redesigned legacy
 * run-report page (RunDetailsPage.tsx) when NO test case is selected.
 *
 * Owner feedback on goyamegh/run-report-redesign: "I liked the split view
 * of test cases on one side and the details rendering on the right. If no
 * test case is selected, the right side can show an aggregated view or
 * more important metrics like why did the failing tests have been failing
 * — something that is complete info. We can show older view too, just
 * fold it in the same page."
 *
 * Sections:
 *   1. Verdict overview + per-category pass/fail bars.
 *   2. "Why runs failed" — deterministic (no LLM) judge-reasoning theme
 *      clustering (lib/runInsights#clusterFailureThemes). Clicking a theme
 *      filters the left test-case list to that theme's cases.
 *   3. Slowest 3 / costliest 3 cases — clicking selects that case.
 *   4. A collapsible "Details" section folding in everything the
 *      pre-redesign RunSummaryPanel showed that isn't already covered by
 *      RunSummaryBand above (avg score, trace-based totals, run
 *      performance aggregates) — see git history of RunSummaryPanel.tsx.
 *
 * Reasoning fetch: report summaries (getReportSummariesByIds) don't carry
 * `llmJudgeReasoning` (deliberately - #429 keeps summaries tiny). This pane
 * lazily fetches ONLY the reasoning + testCaseId fields
 * (getReportReasoningsByIds) for the first 100 failing cases (list order),
 * never the full report body. If the run has more than 100 failing cases,
 * a "Based on N of M failing cases" note is shown (formatCappedNote).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Coins, Hash, Loader2, Timer, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { asyncRunStorage } from '@/services/storage';
import { getResultStatus, StatusIcon } from '@/components/evals3/ResultStatus';
import { ExperimentRun, EvaluationReport, TestCase } from '@/types';
import { getRunOverallScore } from '@/lib/utils';
import { runAggregate } from '@/lib/scoring/snapshotScore';
import { formatCost, formatDuration, formatTokens, fetchBatchMetrics } from '@/services/metrics';
import { RunSummaryStats } from '@/components/RunSummaryBand';
import {
  computeCategoryBars,
  clusterFailureThemes,
  formatCappedNote,
  pickTopN,
  FailureTheme,
} from '@/lib/runInsights';

const REASONING_FETCH_CAP = 100;

export interface RunInsightsPaneProps {
  experimentRun: ExperimentRun;
  testCases: TestCase[];
  reportsMap: Record<string, EvaluationReport | null>;
  stats: RunSummaryStats;
  onSelectCase: (testCaseId: string) => void;
  onFilterCases: (testCaseIds: string[]) => void;
  className?: string;
}

interface CaseRow {
  testCaseId: string;
  reportId: string | null;
  category: string;
  status: string;
  durationMs: number | null;
  runId: string | null;
  score: number | null;
}

export const RunInsightsPane: React.FC<RunInsightsPaneProps> = ({
  experimentRun,
  testCases,
  reportsMap,
  stats,
  onSelectCase,
  onFilterCases,
  className = '',
}) => {
  const testCaseMap = useMemo(() => new Map(testCases.map(tc => [tc.id, tc])), [testCases]);

  const caseRows: CaseRow[] = useMemo(() => {
    return Object.keys(experimentRun.results || {}).map(testCaseId => {
      const result = experimentRun.results[testCaseId];
      const report = result?.reportId ? reportsMap[result.reportId] : null;
      const testCase = testCaseMap.get(testCaseId);
      return {
        testCaseId,
        reportId: result?.reportId || null,
        category: testCase?.category || '',
        status: getResultStatus(result, report || null),
        durationMs: result?.performanceMetrics?.durationMs ?? null,
        runId: report?.runId ?? null,
        score: getRunOverallScore(report?.metrics as Record<string, number | undefined> | undefined),
      };
    });
  }, [experimentRun.results, reportsMap, testCaseMap]);

  const categoryBars = useMemo(
    () => computeCategoryBars(caseRows.map(r => ({ category: r.category, status: r.status }))),
    [caseRows]
  );

  const failingRows = useMemo(() => caseRows.filter(r => r.status === 'failed'), [caseRows]);

  // ── Lazy failure-reasoning fetch (capped, reasoning-only fields) ────────
  const [reasoningByTestCase, setReasoningByTestCase] = useState<Record<string, string>>({});
  const [reasoningLoading, setReasoningLoading] = useState(false);
  const failingReportIds = useMemo(
    () => failingRows.slice(0, REASONING_FETCH_CAP).map(r => r.reportId).filter((id): id is string => !!id),
    [failingRows]
  );
  useEffect(() => {
    if (failingReportIds.length === 0) { setReasoningByTestCase({}); return; }
    let cancelled = false;
    setReasoningLoading(true);
    asyncRunStorage.getReportReasoningsByIds(failingReportIds)
      .then(byReportId => {
        if (cancelled) return;
        const byTestCase: Record<string, string> = {};
        for (const row of failingRows.slice(0, REASONING_FETCH_CAP)) {
          if (!row.reportId) continue;
          const reasoning = byReportId[row.reportId]?.llmJudgeReasoning;
          if (reasoning) byTestCase[row.testCaseId] = reasoning;
        }
        setReasoningByTestCase(byTestCase);
      })
      .catch(err => console.error('[RunInsightsPane] Failed to load failure reasonings:', err))
      .finally(() => { if (!cancelled) setReasoningLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failingReportIds.join(',')]);

  const themes: FailureTheme[] = useMemo(() => {
    const items = Object.entries(reasoningByTestCase).map(([testCaseId, reasoning]) => ({ testCaseId, reasoning }));
    return clusterFailureThemes(items);
  }, [reasoningByTestCase]);

  const cappedNote = formatCappedNote(Object.keys(reasoningByTestCase).length || failingReportIds.length, failingRows.length);

  // ── Slowest / costliest ──────────────────────────────────────────────
  const slowest = useMemo(
    () => pickTopN(caseRows.map(r => ({ testCaseId: r.testCaseId, value: r.durationMs })), 3),
    [caseRows]
  );

  const [costByRunId, setCostByRunId] = useState<Record<string, number>>({});
  useEffect(() => {
    const runIds = Array.from(new Set(caseRows.map(r => r.runId).filter((id): id is string => !!id)));
    if (runIds.length === 0) { setCostByRunId({}); return; }
    let cancelled = false;
    fetchBatchMetrics(runIds)
      .then(data => {
        if (cancelled) return;
        const map: Record<string, number> = {};
        for (const m of data.metrics) map[m.runId] = m.costUsd;
        setCostByRunId(map);
      })
      .catch(() => { if (!cancelled) setCostByRunId({}); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseRows.map(r => r.runId).join(',')]);

  const costliest = useMemo(
    () => pickTopN(
      caseRows.map(r => ({ testCaseId: r.testCaseId, value: r.runId ? costByRunId[r.runId] : undefined })),
      3
    ),
    [caseRows, costByRunId]
  );

  // ── "Details" fold-in — everything RunSummaryPanel (pre-redesign) showed
  // that isn't already on RunSummaryBand above this pane. ─────────────────
  const scoredRows = caseRows.filter(r => r.score !== null && (r.status === 'passed' || r.status === 'failed'));
  // Same read model as the compare page (lib/scoring/snapshotScore.ts):
  // snapshot weighted mean when every evaluated report carries one, else the
  // legacy unweighted mean — labelled as such so it is never mistaken for an
  // evaluator-defined score.
  const snapshotAggregate = runAggregate(caseRows.map(r => (r.reportId ? reportsMap[r.reportId] : null)));
  const avgScore = snapshotAggregate.source === 'snapshot'
    ? (snapshotAggregate.score === null ? null : Math.round(snapshotAggregate.score * 100))
    : scoredRows.length > 0
      ? Math.round(scoredRows.reduce((s, r) => s + (r.score ?? 0), 0) / scoredRows.length)
      : null;
  const perf = experimentRun.performanceMetrics;
  const [traceAggregate, setTraceAggregate] = useState<{ totalInputTokens: number; totalOutputTokens: number; avgDurationMs: number } | null>(null);
  useEffect(() => {
    const runIds = Array.from(new Set(caseRows.map(r => r.runId).filter((id): id is string => !!id)));
    if (runIds.length === 0) { setTraceAggregate(null); return; }
    let cancelled = false;
    fetchBatchMetrics(runIds)
      .then(data => { if (!cancelled) setTraceAggregate(data.aggregate); })
      .catch(() => { if (!cancelled) setTraceAggregate(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseRows.map(r => r.runId).join(',')]);

  const getName = (testCaseId: string) => testCaseMap.get(testCaseId)?.name || testCaseId;

  return (
    <div className={`h-full overflow-y-auto p-4 space-y-6 ${className}`} data-testid="run-insights-pane">
      {/* ── Verdict overview + category bars ─────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Overview</h3>
        <div className="flex items-center gap-4 text-sm mb-3" data-testid="run-insights-verdicts">
          <span className="flex items-center gap-1 text-green-700 dark:text-green-400"><CheckCircle2 size={14} /> {stats.passed}</span>
          <span className="flex items-center gap-1 text-red-700 dark:text-red-400"><XCircle size={14} /> {stats.failed}</span>
          {stats.errored > 0 && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500"><AlertTriangle size={14} /> {stats.errored}</span>
          )}
          <span className="text-muted-foreground">/ {stats.total}</span>
        </div>
        {categoryBars.length > 0 && (
          <div className="space-y-1.5" data-testid="run-insights-category-bars">
            {categoryBars.map(bar => (
              <div key={bar.category} className="flex items-center gap-2 text-xs" data-testid="run-insights-category-bar">
                <span className="w-28 shrink-0 truncate text-muted-foreground" title={bar.category}>{bar.category}</span>
                <div className="flex-1 flex h-2 rounded-full overflow-hidden bg-muted">
                  {bar.passed > 0 && (
                    <div className="bg-green-500" style={{ width: `${(bar.passed / bar.total) * 100}%` }} title={`${bar.passed} passed`} />
                  )}
                  {bar.failed > 0 && (
                    <div className="bg-red-500" style={{ width: `${(bar.failed / bar.total) * 100}%` }} title={`${bar.failed} failed`} />
                  )}
                  {bar.errored > 0 && (
                    <div className="bg-amber-500" style={{ width: `${(bar.errored / bar.total) * 100}%` }} title={`${bar.errored} errored`} />
                  )}
                </div>
                <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">{bar.passed}/{bar.total}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Why runs failed ───────────────────────────────────────────── */}
      {stats.failed > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Why runs failed</h3>
          {reasoningLoading && themes.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="run-insights-themes-loading">
              <Loader2 size={12} className="animate-spin" /> Analyzing failure reasons…
            </div>
          ) : themes.length > 0 ? (
            <div className="space-y-1.5" data-testid="run-insights-themes">
              {themes.map(theme => (
                <button
                  key={theme.key}
                  type="button"
                  data-testid="run-insights-theme"
                  className="w-full text-left rounded-md border border-border p-2 hover:bg-muted/40 transition-colors"
                  onClick={() => onFilterCases(theme.testCaseIds)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{theme.count} case{theme.count !== 1 ? 's' : ''}</span>
                    <ChevronRight size={12} className="text-muted-foreground shrink-0" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{theme.sampleSnippet}</p>
                </button>
              ))}
              {cappedNote && (
                <p className="text-[11px] text-muted-foreground italic" data-testid="run-insights-capped-note">{cappedNote}</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No judge reasoning available for failing cases yet.</p>
          )}
        </section>
      )}

      {/* ── Slowest / costliest ───────────────────────────────────────── */}
      {(slowest.length > 0 || costliest.length > 0) && (
        <section className="grid grid-cols-2 gap-4">
          {slowest.length > 0 && (
            <div data-testid="run-insights-slowest">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <Timer size={12} /> Slowest
              </h3>
              <ul className="space-y-1">
                {slowest.map(r => (
                  <li key={r.testCaseId}>
                    <button
                      type="button"
                      className="text-xs text-left w-full truncate hover:text-opensearch-blue hover:underline"
                      onClick={() => onSelectCase(r.testCaseId)}
                      title={getName(r.testCaseId)}
                    >
                      {getName(r.testCaseId)} · {formatDuration(r.value)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {costliest.length > 0 && (
            <div data-testid="run-insights-costliest">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <Coins size={12} /> Costliest
              </h3>
              <ul className="space-y-1">
                {costliest.map(r => (
                  <li key={r.testCaseId}>
                    <button
                      type="button"
                      className="text-xs text-left w-full truncate hover:text-opensearch-blue hover:underline"
                      onClick={() => onSelectCase(r.testCaseId)}
                      title={getName(r.testCaseId)}
                    >
                      {getName(r.testCaseId)} · {formatCost(r.value)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ── Details (folded-in pre-redesign RunSummaryPanel content) ────── */}
      <details className="group" data-testid="run-insights-details">
        <summary className="text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer select-none">
          Details
        </summary>
        <div className="mt-3 space-y-3 text-xs">
          {avgScore !== null && (
            <div
              className="flex items-center justify-between cursor-help"
              data-testid="run-insights-avg-score"
              title={snapshotAggregate.source === 'snapshot'
                ? `Mean of each case's weighted rubric score per its scoring snapshot (${snapshotAggregate.scoredReports} scored cases)`
                : 'Legacy scoring — unweighted mean of every rubric value; these reports carry no scoring snapshot, so this is not an evaluator-defined score.'}
            >
              <span className="text-muted-foreground">{snapshotAggregate.source === 'snapshot' ? 'Avg score' : 'Avg score (legacy mean)'}</span>
              <span className="font-semibold text-opensearch-blue">{avgScore}%</span>
            </div>
          )}
          {perf && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-muted-foreground">Avg / Case</div>
                <div className="font-medium">{formatDuration(perf.avgTestCaseDurationMs)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Fastest / Slowest Case</div>
                <div className="font-medium">{formatDuration(perf.minTestCaseDurationMs)} / {formatDuration(perf.maxTestCaseDurationMs)}</div>
              </div>
            </div>
          )}
          {traceAggregate && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-muted-foreground flex items-center gap-1"><Hash size={11} /> Total Tokens</div>
                <div className="font-medium">{formatTokens(traceAggregate.totalInputTokens + traceAggregate.totalOutputTokens)}</div>
              </div>
              <div>
                <div className="text-muted-foreground flex items-center gap-1"><Timer size={11} /> Avg Duration (traces)</div>
                <div className="font-medium">{formatDuration(traceAggregate.avgDurationMs)}</div>
              </div>
            </div>
          )}
          {!perf && !traceAggregate && avgScore === null && (
            <p className="text-muted-foreground">No additional run details available.</p>
          )}
        </div>
      </details>
    </div>
  );
};
