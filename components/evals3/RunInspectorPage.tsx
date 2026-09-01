/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RunInspectorPage — Eval Run Inspector (handles both benchmark and SDK runs)
 *
 * Layout: Top bar (run metadata) | Left (test case list) | Right (test case detail)
 * Routes (one component, two routes):
 *   • /evaluations/benchmarks/:benchmarkId/runs/:runId/inspect  — benchmark run mode
 *   • /evaluations/runs/:runId/inspect                          — SDK eval run mode (no benchmark)
 *
 * The two surfaces used to live in separate inspect pages, which led to
 * the SDK "Run" link in EvalRunDetailPage / EvalRunsPage navigating to a
 * route that didn't exist (#247 review feedback). They share a component
 * now — same left-list + right-detail UI, same matcher panel, same
 * trace-polling recovery; only the data fetcher differs.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Clock, XCircle, Calendar, GitCompare, AlertTriangle, RotateCcw, RotateCw, Link2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { asyncBenchmarkStorage, asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { getEvaluationRun, updateEvaluationRun } from '@/services/client';
import { Benchmark, BenchmarkRun, EvaluationRun, TestCase, EvaluationReport, isEvaluationRun } from '@/types';
import { resolveCanonicalEvaluationRun } from '@/lib/resolveCanonicalRun';
import { ResultStatus, getResultStatus, StatusIcon, StatusLabel } from './ResultStatus';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate, getModelName } from '@/lib/utils';
import { TestCaseInspectorPanel } from './TestCaseInspectorPanel';
import { InlineRenameField } from './InlineRenameField';
import { Breadcrumbs } from './Breadcrumbs';
import { ensureTracePollingForReport } from '@/services/traces/browserRecovery';
import { RerunConfirmDialog } from './RerunConfirmDialog';
import { RetryJudgementConfirmDialog } from './RetryJudgementConfirmDialog';
import type { RetryJudgementSummary } from '@/services/client';

interface TestCaseResult {
  testCaseId: string;
  testCase: TestCase | null;
  reportId: string | null;
  status: ResultStatus;
  // Populated when the report could be fetched. Used by the inspect-page-wide
  // trace-polling recovery so we don't have to re-fetch in a second effect.
  report?: EvaluationReport | null;
}

/** Rows revealed per infinite-scroll page in the left test-case list. */
const ROWS_PER_PAGE = 100;


export const RunInspectorPage: React.FC = () => {
  // Either route shape resolves into one of two modes. `benchmarkId` is
  // optional — absent on the SDK eval-run route at /evaluations/runs/:runId/inspect.
  const { benchmarkId, runId } = useParams<{ benchmarkId?: string; runId: string }>();
  const navigate = useNavigate();
  // The eval-run detail page deep-links into the inspector with
  // `?reportId=<id>` so the user lands directly on the report they
  // clicked. Resolve to a testCaseId once results are loaded.
  const [searchParams] = useSearchParams();
  const targetReportId = searchParams.get('reportId');

  // `mode` is derived from the route. Benchmark mode reads from
  // asyncBenchmarkStorage and PREFERS the run embedded in benchmark.runs[]
  // (cheap, already trimmed); eval-run mode hits
  // /api/storage/evaluation-runs/:id directly. Both modes feed the same
  // `run.results` shape into the rest of the page.
  //
  // benchmark.runs[] is only populated on completion (linkCompletedRunToBenchmark
  // in server/routes/storage/evaluationRuns.ts runs at completion, not at
  // create time) — a still-`running`/`pending` run-first evaluation-run doc
  // has NO entry there yet, even though it already exists as a standalone
  // document and is already shown as a row on the runs list page (which
  // unions benchmark.runs[] with `listEvaluationRuns({ benchmarkId })`, see
  // allMergedRuns in BenchmarkRunsPage.tsx). Before this fix, `loadData`
  // below found no match in `bm.runs` for such a run and silently
  // `navigate()`d straight back to the runs list — from the user's
  // perspective this looked exactly like the row not being a link at all
  // (click → nothing visibly happens). Falling back to the standalone
  // evaluation-run document (same fetch eval-run mode already uses) closes
  // that gap; a genuinely nonexistent run now renders an explicit
  // not-found state instead of bouncing invisibly.
  const mode: 'benchmark' | 'evalRun' = benchmarkId ? 'benchmark' : 'evalRun';

  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [run, setRun] = useState<BenchmarkRun | EvaluationRun | null>(null);
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTcId, setSelectedTcId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<EvaluationReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  // Full TestCase for the selected row, fetched lazily on selection (the
  // bulk load above is summary-only -- no sourceCode). null while loading
  // or for a row whose full fetch hasn't resolved yet; the panel falls
  // back to the summary TestCase from `results` in that case (everything
  // except sourceCode is already correct there).
  const [selectedTestCase, setSelectedTestCase] = useState<TestCase | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Set only when a benchmark-mode run is missing from BOTH benchmark.runs[]
  // AND the standalone evaluation-run store (i.e. genuinely gone, not just
  // not-yet-linked). Rendered as an explicit "not found" state instead of
  // the silent bounce-to-list this replaces — see the `mode` comment above.
  const [notFoundReason, setNotFoundReason] = useState<string | null>(null);
  // Infinite scroll: number of rows revealed in the left list. Statuses for
  // ALL rows arrive in one lightweight batch (so the header tallies are
  // always complete); this only windows the DOM for very large benchmarks.
  const [visibleCount, setVisibleCount] = useState(ROWS_PER_PAGE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const initialSelectionDone = React.useRef(false);
  const [rerunDialogOpen, setRerunDialogOpen] = useState(false);
  const [retryJudgementDialogOpen, setRetryJudgementDialogOpen] = useState(false);
  // Provenance: when this run was itself created via re-run, look up the
  // source run's name for the chip (falls back to a truncated id if the
  // source run was since deleted).
  const [sourceRunName, setSourceRunName] = useState<string | null>(null);
  const [sourceRunMissing, setSourceRunMissing] = useState(false);

  // Load data — fetch reports to get real pass/fail status
  const loadData = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setLoadError(false);
    setNotFoundReason(null);
    try {
      let runData: BenchmarkRun | EvaluationRun;

      if (mode === 'benchmark') {
        if (!benchmarkId) { navigate('/evaluations/benchmarks'); return; }
        const bm = await asyncBenchmarkStorage.getById(benchmarkId);
        if (!bm) { navigate('/evaluations/benchmarks'); return; }
        setBenchmark(bm);

        const bmRun = bm.runs?.find(r => r.id === runId);
        if (bmRun) {
          // Runs created WITH a benchmarkId are dual-written (#399): a
          // first-class EvaluationRun doc AND a legacy-shaped BenchmarkRun
          // projection embedded in benchmark.runs[] above. Prefer the
          // first-class doc when it exists so (a) isEvaluationRun(run) below
          // is meaningful on this route too, not permanently false, and (b)
          // the page shows live results/stats instead of a stale embedded
          // snapshot. See lib/resolveCanonicalRun.ts for the fallback
          // semantics (silent on 404, logged on any other failure).
          runData = await resolveCanonicalEvaluationRun(runId, bmRun, getEvaluationRun);
        } else {
          // Not embedded yet — fall back to the standalone evaluation-run
          // document (run-first docs like CLI/UI-started runs exist here
          // immediately at creation, before completion links them into
          // benchmark.runs[]). Fetched directly (not via the shared
          // `getEvaluationRun` helper) so a real 404 can be told apart from
          // any other failure — a transient 500/network error must NOT be
          // reported as "not found" (codex_review finding): it re-throws and
          // falls into the outer catch's existing loadError/Retry state,
          // same as every other fetch in this function.
          const fallbackRes = await fetch(`/api/storage/evaluation-runs/${runId}`);
          if (fallbackRes.status === 404) {
            setNotFoundReason(
              `This run (${runId}) isn't linked to benchmark "${bm.name}" yet, and no standalone evaluation-run document exists for it. It may still be starting up, or it was deleted.`
            );
            setLoading(false);
            return;
          }
          if (!fallbackRes.ok) {
            throw new Error(`Failed to get evaluation run: ${fallbackRes.statusText}`);
          }
          const fallbackRun: EvaluationRun = await fallbackRes.json();
          // Association check (codex_review finding): a run id that exists
          // standalone but belongs to a DIFFERENT benchmark (or none at all)
          // must not be rendered under THIS benchmark's URL — that would
          // silently show the wrong run's data. Only accept it once we've
          // confirmed it's actually associated with `benchmarkId`.
          const belongsToThisBenchmark =
            fallbackRun.benchmarkId === benchmarkId ||
            (fallbackRun.sources || []).some(
              (s) => s.type === 'benchmark' && s.benchmarkId === benchmarkId
            );
          if (!belongsToThisBenchmark) {
            setNotFoundReason(
              `This run (${runId}) isn't linked to benchmark "${bm.name}" yet, and no standalone evaluation-run document exists for it. It may still be starting up, or it was deleted.`
            );
            setLoading(false);
            return;
          }
          runData = fallbackRun;
        }
      } else {
        // SDK eval-run mode — no benchmark.
        try {
          runData = await getEvaluationRun(runId);
        } catch {
          navigate('/evaluations/runs');
          return;
        }
        setBenchmark(null);
      }
      setRun(runData);

      const tcIds = Object.keys(runData.results || {});
      // Summary fetch (no sourceCode/context/expectedOutcomes) -- every test
      // case in a code-SDK file shares the SAME sourceCode, so fetching the
      // full payload for every row here would duplicate it N times just to
      // paint a list. The selected row's full TestCase (including
      // sourceCode, for CollapsibleTestCaseDefinition's eval-source view)
      // loads lazily below, mirroring the existing report on-demand pattern.
      const testCases = await asyncTestCaseStorage.getByIds(tcIds, { summary: true });
      const tcMap = new Map(testCases.map(tc => [tc.id, tc]));

      // ONE lightweight batch (status fields only, chunked at 100 ids) instead
      // of N full-report round-trips. Full report documents (trajectory +
      // judge output, ~0.3–2 MB each) load on-demand for the selected row
      // only — an 84-case run went from ~68 MB / ~10 s to a few KB here.
      const reportIds = tcIds
        .map(tcId => runData.results[tcId]?.reportId)
        .filter((id): id is string => Boolean(id));
      let summaries: Record<string, EvaluationReport> = {};
      try {
        summaries = await asyncRunStorage.getReportSummariesByIds(reportIds);
      } catch { /* fall back to execution status below */ }

      const resultRows: TestCaseResult[] = tcIds.map((tcId) => {
        const runResult = runData.results[tcId];
        const report = runResult?.reportId ? summaries[runResult.reportId] || null : null;
        const status = getResultStatus(runResult, report);
        return { testCaseId: tcId, testCase: tcMap.get(tcId) || null, reportId: runResult?.reportId || null, status, report };
      });

      setResults(resultRows);
      if (resultRows.length > 0 && !initialSelectionDone.current) {
        // Honor `?reportId=<id>` first — if the user arrived via a deep
        // link (e.g. "View" button on EvalRunDetailPage), select that
        // report's row. Fall back to the first row otherwise.
        const targeted = targetReportId
          ? resultRows.find(r => r.reportId === targetReportId)
          : null;
        setSelectedTcId((targeted ?? resultRows[0]).testCaseId);
        // Make sure a deep-linked row is actually revealed by the windowed list.
        if (targeted) {
          const idx = resultRows.indexOf(targeted);
          if (idx >= ROWS_PER_PAGE) {
            setVisibleCount(Math.ceil((idx + 1) / ROWS_PER_PAGE) * ROWS_PER_PAGE);
          }
        }
        initialSelectionDone.current = true;
      }

      // Fan out trace-polling recovery for *every* pending result.
      // Without this, the user previously had to manually click each pending
      // row to mount RunDetailsContent and trigger its inline recovery — so
      // the second/third pending rows could remain stuck for hours.
      // ensureTracePollingForReport() is idempotent and a no-op for non-pending
      // reports, so this is safe to call unconditionally.
      for (const row of resultRows) {
        if (!row.report || !row.testCase) continue;
        if (row.report.metricsStatus !== 'pending') continue;
        ensureTracePollingForReport(row.report, row.testCase, {
          // Grace period: skip reports that only just went pending — they are
          // likely eager-path placeholders whose agent is still executing, not
          // stuck trace-mode reports. Prevents the fan-out from racing (and
          // historically clobbering) eager judge verdicts.
          minPendingAgeMs: 3 * 60 * 1000,
          onUpdated: (updated) => {
            setResults(prev => prev.map(r => r.testCaseId === row.testCaseId
              ? { ...r, report: updated, status: getResultStatus({ status: 'completed' }, updated) }
              : r
            ));
          },
        });
      }
    } catch (error) {
      console.error('Failed to load:', error);
      // Surface a retry UI instead of an infinite skeleton — a transient API
      // failure (e.g. server restart) used to leave this page stuck forever.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [benchmarkId, runId, mode, navigate, targetReportId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Resolve the source run name for the rerunOf provenance chip (EvaluationRun only).
  useEffect(() => {
    if (!run || !isEvaluationRun(run) || !run.rerunOf) {
      setSourceRunName(null);
      setSourceRunMissing(false);
      return;
    }
    let cancelled = false;
    const sourceRunId = run.rerunOf;
    getEvaluationRun(sourceRunId)
      .then(src => {
        if (!cancelled) {
          setSourceRunName(src.name || src.id);
          setSourceRunMissing(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSourceRunName(null);
          setSourceRunMissing(true);
        }
      });
    return () => { cancelled = true; };
  }, [run, mode]);

  // Reset per-run UI state when navigating between runs. React Router reuses
  // the component instance across param changes, so without this the previous
  // run's selection/window/deep-link handling would leak into the next run.
  const lastRunIdRef = React.useRef(runId);
  useEffect(() => {
    if (lastRunIdRef.current === runId) return;
    lastRunIdRef.current = runId;
    initialSelectionDone.current = false;
    setSelectedTcId(null);
    setVisibleCount(ROWS_PER_PAGE);
  }, [runId]);

  // Infinite scroll: reveal the next page of rows when the sentinel at the
  // bottom of the left list becomes visible.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= results.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        setVisibleCount(c => Math.min(c + ROWS_PER_PAGE, results.length));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, results.length]);

  // Sidebar collapse for run URLs is owned globally by Layout (it collapses on
  // landing on a /runs/<id> URL and persists the preset), so this page no
  // longer manages it locally.

  // Load report when selection changes. Keyed on the selected row's
  // reportId (not the `results` array identity) so background updates to
  // other rows don't re-fetch — and don't remount — the open panel.
  const selectedReportId = results.find(r => r.testCaseId === selectedTcId)?.reportId ?? null;
  useEffect(() => {
    if (!selectedReportId) { setSelectedReport(null); return; }
    setReportLoading(true);
    let cancelled = false;
    asyncRunStorage.getReportById(selectedReportId)
      .then(report => { if (!cancelled) setSelectedReport(report || null); })
      .catch(() => { if (!cancelled) setSelectedReport(null); })
      .finally(() => { if (!cancelled) setReportLoading(false); });
    return () => { cancelled = true; };
  }, [selectedReportId]);

  // Load the FULL test case (including sourceCode) when selection changes.
  // The bulk `results` fetch above is summary-only to avoid re-downloading
  // the same eval-file source once per test case sharing it; only the
  // currently-open row needs the full document (CollapsibleTestCaseDefinition
  // renders EvalSourceCodeView, which needs sourceCode).
  useEffect(() => {
    if (!selectedTcId) { setSelectedTestCase(null); return; }
    let cancelled = false;
    asyncTestCaseStorage.getById(selectedTcId)
      .then(tc => { if (!cancelled) setSelectedTestCase(tc); })
      .catch(() => { if (!cancelled) setSelectedTestCase(null); });
    return () => { cancelled = true; };
  }, [selectedTcId]);

  const passCount = results.filter(r => r.status === 'passed').length;
  const failCount = results.filter(r => r.status === 'failed').length;
  // Issue #242: errored runs are evaluator failures and must be displayed
  // as their own bucket. Excluded from the pass-rate denominator below so a
  // misconfigured evaluator can't drag the score to 0%.
  const erroredCount = results.filter(r => r.status === 'errored').length;
  const totalCount = results.length;
  const judgedCount = passCount + failCount;
  const passRate = judgedCount > 0 ? Math.round((passCount / judgedCount) * 100) : 0;
  const selectedResult = results.find(r => r.testCaseId === selectedTcId) || null;

  // Explicit not-found state (see `mode` comment above for the linking-lag
  // scenario this replaces a silent navigate() for): distinct from loadError
  // below because a retry can't fix a run that truly doesn't exist anywhere
  // — offer a way back to the runs list instead of a Retry button.
  if (!loading && notFoundReason) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-md px-4" data-testid="run-inspector-not-found">
          <AlertTriangle size={32} className="mx-auto text-amber-500" />
          <p className="text-sm font-medium">Run not found</p>
          <p className="text-sm text-muted-foreground">{notFoundReason}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(mode === 'benchmark' && benchmarkId ? `/evaluations/benchmarks/${benchmarkId}/runs` : '/evaluations/runs')}
          >
            Back to runs
          </Button>
        </div>
      </div>
    );
  }

  // Error state takes priority over both the skeleton and any partially
  // populated data: a failure AFTER `run` was set (e.g. the test-cases fetch
  // threw) previously rendered a broken page with empty rows and no way to
  // retry — only pre-`run` failures reached the error UI.
  if (!loading && loadError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3" data-testid="run-inspector-error">
          <AlertTriangle size={32} className="mx-auto text-amber-500" />
          <p className="text-sm text-muted-foreground">Failed to load this run — the server may be restarting.</p>
          <Button variant="outline" size="sm" onClick={() => loadData()}>Retry</Button>
        </div>
      </div>
    );
  }

  // Loading: in benchmark mode we need both `benchmark` and `run`; in
  // eval-run mode we only need `run` (no benchmark to fetch).
  if (loading || !run || (mode === 'benchmark' && !benchmark)) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[calc(100vh-200px)] w-full" />
      </div>
    );
  }

  const agentName = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey;
  const modelName = getModelName(run.modelId);
  // Narrow once for the render below -- avoids repeated isEvaluationRun()
  // calls and unsafe `as EvaluationRun` casts inside nested closures (TS
  // narrowing of `run` doesn't reliably persist into inline arrow-function
  // bodies like onClick handlers).
  const evalRun: EvaluationRun | null = isEvaluationRun(run) ? run : null;

  // Rename only PATCHes the top-level EvaluationRun collection (see
  // server/routes/storage/evaluationRuns.ts) — legacy benchmark-embedded
  // runs have no equivalent endpoint, same gating as the Re-run button above.
  const handleRenameRun = async (newName: string) => {
    if (!evalRun) return;
    const previousName = run.name;
    setRun(r => (r ? { ...r, name: newName } : r));
    try {
      await updateEvaluationRun(run.id, { name: newName });
    } catch (err) {
      setRun(r => (r ? { ...r, name: previousName } : r));
      throw err;
    }
  };

  return (
    <div className="h-full flex flex-col max-md:h-auto max-md:overflow-visible">
      {/* ── Top Bar ──────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b bg-card shrink-0">
        <Breadcrumbs
          items={
            mode === 'benchmark' && benchmark
              ? [
                  { label: 'Evaluations', href: '/evaluations/runs' },
                  { label: benchmark.name, href: `/evaluations/benchmarks/${benchmarkId}/runs` },
                  { label: run.name },
                ]
              : [
                  // SDK eval-run mode: no parent benchmark; root the breadcrumb
                  // at the eval-runs index so users can navigate back to the
                  // list of all runs.
                  { label: 'Evaluation Runs', href: '/evaluations/runs' },
                  { label: run.name },
                ]
          }
        />
        <div className="flex items-center justify-between mt-1">
          <div className="flex-1 min-w-0">
            {evalRun ? (
              <InlineRenameField
                value={run.name}
                onSave={handleRenameRun}
                textClassName="text-lg font-bold"
                testId="run-inspector-rename"
              />
            ) : (
              <h2 className="text-lg font-bold truncate">{run.name}</h2>
            )}
            {/* Provenance chip visibility is a DOC concern (does this run
                object actually carry rerunOf data?), not a route concern --
                isEvaluationRun() narrows `run` so `.rerunOf` is type-safe. */}
            {evalRun?.rerunOf && (
              <div className="mt-1 flex items-center">
                <button
                  data-testid="rerun-provenance-chip"
                  className={sourceRunMissing
                    ? 'inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted/40 text-muted-foreground text-xs px-2 py-0.5 hover:bg-muted/60 transition-colors'
                    : 'inline-flex items-center gap-1 rounded-full border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs px-2 py-0.5 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors'}
                  onClick={() => navigate(`/evaluations/runs/${evalRun.rerunOf}`)}
                  title={sourceRunMissing
                    ? 'This run was created as a re-run, but the source run no longer exists'
                    : 'This run was created as a re-run of the linked source run'}
                >
                  <Link2 size={11} />
                  re-run of {sourceRunName || evalRun.rerunOf?.slice(0, 8)}
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            <span className="flex items-center gap-1"><Calendar size={11} /> {formatDate(run.createdAt)}</span>
            <span>{agentName}</span>
            <span>{modelName}</span>
            <span className="flex items-center gap-1">
              <span className="text-green-500 font-semibold">{passCount}✓</span>
              <span className="text-red-500 font-semibold">{failCount}✗</span>
              {erroredCount > 0 && (
                <span
                  className="flex items-center gap-0.5 text-amber-500 font-semibold ml-1"
                  title="Evaluator could not run (e.g. judge validation error). Excluded from pass-rate aggregation."
                >
                  <AlertTriangle size={11} className="shrink-0" />
                  {erroredCount}
                </span>
              )}
              <span>/ {totalCount}</span>
            </span>
            <span className={`font-semibold ${passRate >= 80 ? 'text-green-500' : passRate >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
              {passRate}%
            </span>
            {/* Re-run capability is a DOC concern: only EvaluationRun docs
                support rerun (BenchmarkRun has no rerun endpoint), and a
                dual-written run reached via the benchmark route can BE an
                EvaluationRun once loadData() above prefers the first-class
                doc -- so this must key on the run's actual docType, not on
                which route/mode loaded the page. */}
            {evalRun ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="inspector-rerun-btn"
                className="h-7 gap-1.5 text-xs"
                onClick={() => setRerunDialogOpen(true)}
              >
                <RotateCcw size={12} />
                Re-run
              </Button>
            ) : (
              <div
                title="Re-run is only available for evaluation runs, not benchmark-embedded runs"
                className="inline-flex"
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  data-testid="inspector-rerun-btn"
                  className="h-7 gap-1.5 text-xs"
                >
                  <RotateCcw size={12} />
                  Re-run
                </Button>
              </div>
            )}
            {/* Retry judgement: evaluation-run docs only (never true
                BenchmarkRun-embedded docs), terminal runs only. Salvages
                judge-failed cases (trace timeouts, judge errors,
                "evaluator could not run") at judge cost only — never
                re-invokes the agent. See services/evaluation/retryJudgement.ts.
                Keyed on `run.docType` rather than route `mode` — same class
                of bug as the Re-run button fix: an evaluation-run doc
                (docType: 'evaluation-run') can be reached via the
                benchmark-scoped inspector route
                (/evaluations/benchmarks/<benchmarkId>/runs/<runId>/inspect)
                whenever it was created with a benchmarkId, so `mode` alone
                (derived purely from the URL's benchmarkId param) is not a
                reliable signal for "is this a first-class evaluation run". */}
            {run && isEvaluationRun(run) && (() => {
              const runTerminal = run.status !== 'running' && run.status !== 'pending';
              const disabled = !runTerminal || erroredCount === 0;
              const title = !runTerminal
                ? 'Retry judgement is only available once the run has finished'
                : erroredCount === 0
                  ? 'No judge-failed cases to retry'
                  : undefined;
              return (
                <div title={title} className="inline-flex">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    data-testid="inspector-retry-judgement-btn"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => setRetryJudgementDialogOpen(true)}
                  >
                    <RotateCw size={12} />
                    Retry judgement ({erroredCount})
                  </Button>
                </div>
              );
            })()}
            {/* Compare is a test-case-level primitive and no longer requires a
                benchmark — benchmark runs deep-link with their benchmark for
                context; ad-hoc SDK/eval runs use the benchmark-free
                `/compare?runs=…` view. */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => navigate(
                mode === 'benchmark' && benchmarkId
                  ? `/compare/${benchmarkId}?runs=${runId}`
                  : `/compare?runs=${runId}`
              )}
            >
              <GitCompare size={12} />
              Compare
            </Button>
          </div>
        </div>
      </div>

      {/* Re-run Confirm Dialog (EvaluationRun only) -- doc concern, see above. */}
      {evalRun && (
        <RerunConfirmDialog
          run={evalRun}
          open={rerunDialogOpen}
          onOpenChange={setRerunDialogOpen}
          onRerun={newRunId => navigate(`/evaluations/runs/${newRunId}`)}
        />
      )}

      {/* Retry Judgement Confirm Dialog (EvaluationRun only) */}
      {run && isEvaluationRun(run) && (
        <RetryJudgementConfirmDialog
          run={run as EvaluationRun | null}
          count={erroredCount}
          open={retryJudgementDialogOpen}
          onOpenChange={setRetryJudgementDialogOpen}
          onComplete={(_summary: RetryJudgementSummary) => loadData()}
        />
      )}

      {/* ── Left + Right Panels ──────────────────────────────────── */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 max-md:!h-auto max-md:!overflow-visible max-md:!flex-col">
        {/* Left: Test Case List */}
        <ResizablePanel defaultSize={30} minSize={20} maxSize={45} className="border-r max-md:!h-auto max-md:!min-h-0 max-md:!overflow-visible max-md:border-r-0 max-md:border-b">
          <ScrollArea className="h-full max-md:h-auto">
            <div className="px-3 py-2 border-b">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Test Cases · {totalCount}
              </span>
            </div>
            <div className="p-1.5 space-y-0.5">
              {results.slice(0, visibleCount).map(r => {
                const isSelected = r.testCaseId === selectedTcId;
                const tc = r.testCase;
                return (
                  <div
                    key={r.testCaseId}
                    data-testid="test-case-row"
                    data-test-case-id={r.testCaseId}
                    data-status={r.status}
                    className={`flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-blue-500/10 border-l-2 border-l-blue-500 text-foreground'
                        : 'hover:bg-muted/50 border-l-2 border-l-transparent'
                    }`}
                    onClick={() => setSelectedTcId(r.testCaseId)}
                  >
                    <StatusIcon status={r.status} size={14} />
                    <span className={`text-xs flex-1 min-w-0 truncate ${isSelected ? 'font-semibold' : 'font-medium'}`}>
                      {tc?.name || r.testCaseId}
                    </span>
                    <StatusLabel status={r.status} />
                  </div>
                );
              })}
              {visibleCount < results.length && (
                <div ref={sentinelRef} data-testid="test-case-list-sentinel" className="flex items-center justify-center py-3">
                  <Loader2 size={14} className="animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle className="max-md:hidden" />

        {/* Right: Test Case Detail */}
        <ResizablePanel defaultSize={70} minSize={50} className="max-md:!h-auto max-md:!min-h-0 max-md:!overflow-visible">
          {selectedResult ? (
            reportLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : selectedReport ? (
              <TestCaseInspectorPanel
                report={selectedReport}
                testCase={selectedTestCase || selectedResult.testCase}
                status={selectedResult.status}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                  {selectedResult.status === 'running' ? (
                    <><Loader2 size={32} className="mx-auto mb-3 text-blue-500 animate-spin" /><p className="text-sm">Running agent...</p></>
                  ) : selectedResult.status === 'pending_traces' ? (
                    <><Loader2 size={32} className="mx-auto mb-3 text-amber-500 animate-spin" /><p className="text-sm">Agent done — waiting for traces...</p></>
                  ) : selectedResult.status === 'pending_judgment' ? (
                    <><Loader2 size={32} className="mx-auto mb-3 text-purple-500 animate-spin" /><p className="text-sm">Running LLM judge...</p></>
                  ) : selectedResult.status === 'pending' ? (
                    <><Clock size={32} className="mx-auto mb-3 text-muted-foreground" /><p className="text-sm">Pending</p></>
                  ) : (
                    <><XCircle size={32} className="mx-auto mb-3 opacity-20" /><p className="text-sm">No report available</p></>
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <p className="text-sm">Select a test case</p>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
