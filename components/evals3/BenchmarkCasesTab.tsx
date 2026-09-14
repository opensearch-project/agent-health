/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, BarChart3, ChevronLeft, ChevronRight,
  History, Search, ShieldCheck, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { BenchmarkCaseDefinition } from '@/components/evals3/BenchmarkCaseDefinition';
import { DescribeGroupFilter, UNGROUPED, type DescribeGroupSelection } from '@/components/evals3/DescribeGroupFilter';
import { DescribePathChain } from '@/components/evals3/DescribePathChain';
import { groupCasesByDescribe } from '@/lib/describeGroups';
import {
  buildCaseReviewRows,
  computePagerDrag,
  deriveCaseVerdict,
  filterAndSortCaseRows,
  getCasePagerPosition,
  getCasePassRate,
  hasHistoricalVersionMismatch,
  resolveSwipeDirection,
  type CaseReviewFilter,
  type CaseVerdict,
} from '@/lib/benchmarkCaseReview';
import { getDifficultyFromLabels } from '@/lib/testCaseLabels';
import { formatDate } from '@/lib/utils';
import type { BenchmarkRun, EvaluationReport, TestCase } from '@/types';

interface BenchmarkCasesTabProps {
  benchmarkId: string;
  testCases: TestCase[];
  recentRuns: BenchmarkRun[];
  allRuns: BenchmarkRun[];
  totalRuns: number;
  reportsById: Record<string, EvaluationReport>;
  selectedCaseId?: string;
  onSelectCase: (testCaseId: string) => void;
  onClearCase: () => void;
  onOpenRuns: () => void;
}

const VERDICT_STYLE: Record<CaseVerdict, { label: string; short: string; className: string }> = {
  passed: {
    label: 'Passed', short: '✓',
    className: 'bg-green-500 border-green-600 text-white dark:bg-green-600',
  },
  failed: {
    label: 'Failed', short: '✕',
    className: 'bg-red-500 border-red-600 text-white dark:bg-red-600',
  },
  errored: {
    label: 'Errored', short: '!',
    className: 'bg-amber-300 border-amber-500 text-amber-950 dark:bg-amber-500 dark:text-black',
  },
  'not-run': {
    label: 'Not run', short: '–',
    className: 'bg-muted border-border text-muted-foreground',
  },
};

const FILTER_LABEL: Record<CaseReviewFilter, string> = {
  all: 'All cases',
  'needs-attention': 'Needs attention',
  flaky: 'Flaky',
  stable: 'Stable',
};

/**
 * Cases render incrementally (infinite scroll) rather than all at once so a
 * 400+ case benchmark stays smooth to scroll through — see PR #447 review
 * question about scrolling on large benchmarks.
 */
const CASE_LIST_PAGE_SIZE = 60;

/**
 * Exact predicate behind each rollup filter, shown as a tooltip on the filter
 * chip. Mirrors `classifyCaseVerdicts` in lib/benchmarkCaseReview.ts — keep
 * these in sync if that priority logic changes. Answers PR #447's review
 * question: "how you are filtering Needs attention use-cases".
 */
const FILTER_TOOLTIP: Record<CaseReviewFilter, string> = {
  all: 'Every test case in this benchmark, regardless of recent verdict.',
  'needs-attention': 'Failed or errored in ≥ 1 of the last 3 completed runs — or has run history with no passes at all (a stale failure/error outside that 3-run window).',
  flaky: 'Mixed passed/failed verdicts across the last 5 completed runs, but no failure or error in the last 3.',
  stable: 'Passing, with no failure or error in the last 3 completed runs.',
};

function difficultyFor(testCase: TestCase): string {
  return getDifficultyFromLabels(testCase.labels) || testCase.difficulty || 'Unspecified';
}

function Sparkline({ verdicts }: { verdicts: CaseVerdict[] }) {
  if (verdicts.length === 0) {
    return <span className="text-[10px] text-muted-foreground">No runs</span>;
  }
  return (
    <span className="flex items-center gap-0.5" aria-label={verdicts.map(v => VERDICT_STYLE[v].label).join(', ')}>
      {verdicts.map((verdict, index) => (
        <span
          key={index}
          title={VERDICT_STYLE[verdict].label}
          className={`h-2.5 flex-1 min-w-[5px] max-w-4 rounded-[2px] border ${VERDICT_STYLE[verdict].className}`}
        />
      ))}
    </span>
  );
}

export function CaseHeatStrip({
  benchmarkId,
  run,
  testCases,
  reportsById,
  onSelectCase,
}: {
  benchmarkId: string;
  run: BenchmarkRun;
  testCases: TestCase[];
  reportsById: Record<string, EvaluationReport>;
  onSelectCase: (testCaseId: string) => void;
}) {
  if (testCases.length === 0) return null;
  return (
    <div
      className="flex w-full gap-px rounded-sm overflow-hidden bg-border/50 p-px"
      aria-label={`${run.name} case verdicts`}
      onClick={event => event.stopPropagation()}
    >
      {testCases.map(testCase => {
        const verdict = deriveCaseVerdict(run, testCase.id, reportsById);
        const style = VERDICT_STYLE[verdict];
        return (
          <button
            type="button"
            key={testCase.id}
            className={`h-3 flex-1 min-w-0 border-0 opacity-90 hover:opacity-100 hover:ring-1 hover:ring-foreground/60 focus-visible:ring-2 focus-visible:ring-ring ${style.className}`}
            title={`${testCase.name}: ${style.label}`}
            aria-label={`${testCase.name}: ${style.label}`}
            onClick={() => onSelectCase(testCase.id)}
            data-case-path={`/evaluations/benchmarks/${benchmarkId}/cases/${testCase.id}`}
          />
        );
      })}
    </div>
  );
}

function RecentVerdictChips({
  benchmarkId,
  testCase,
  recentRuns,
  reportsById,
}: {
  benchmarkId: string;
  testCase: TestCase;
  recentRuns: BenchmarkRun[];
  reportsById: Record<string, EvaluationReport>;
}) {
  if (recentRuns.length === 0) return <p className="text-xs text-muted-foreground">No completed runs yet.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {recentRuns.map(run => {
        const verdict = deriveCaseVerdict(run, testCase.id, reportsById);
        const style = VERDICT_STYLE[verdict];
        return (
          <Link
            key={run.id}
            to={`/evaluations/benchmarks/${benchmarkId}/runs/${run.id}/inspect`}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-transform hover:-translate-y-0.5 ${style.className}`}
            title={`${run.name}: ${style.label} — open run report`}
          >
            <span aria-hidden="true">{style.short}</span>
            <span className="max-w-40 truncate">{run.name}</span>
          </Link>
        );
      })}
    </div>
  );
}

function SuiteHealth({
  rows,
  recentRuns,
  totalRuns,
  onSelectCase,
  onOpenRuns,
}: {
  rows: ReturnType<typeof buildCaseReviewRows<TestCase & { prompt?: string }>>;
  recentRuns: BenchmarkRun[];
  totalRuns: number;
  onSelectCase: (testCaseId: string) => void;
  onOpenRuns: () => void;
}) {
  const scoredVerdicts = rows.flatMap(row => row.verdicts).filter(v => v === 'passed' || v === 'failed');
  const suiteRate = getCasePassRate(scoredVerdicts);
  const attentionRows = rows.filter(row => row.bucket === 'needs-attention');
  const attention = attentionRows.slice(0, 6);

  const difficultyStats = useMemo(() => {
    const groups = new Map<string, CaseVerdict[]>();
    for (const row of rows) {
      const difficulty = difficultyFor(row.testCase);
      groups.set(difficulty, [...(groups.get(difficulty) || []), ...row.verdicts]);
    }
    const priority = ['Easy', 'Medium', 'Hard', 'Unspecified'];
    return [...groups.entries()]
      .map(([difficulty, verdicts]) => ({ difficulty, rate: getCasePassRate(verdicts) }))
      .sort((a, b) => {
        const ai = priority.indexOf(a.difficulty);
        const bi = priority.indexOf(b.difficulty);
        if (ai === -1 && bi === -1) return a.difficulty.localeCompare(b.difficulty);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
  }, [rows]);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6" data-testid="suite-health">
      <div className="max-w-5xl mx-auto space-y-5">
        <div>
          <h3 className="text-lg font-semibold">Suite health</h3>
          <p className="text-sm text-muted-foreground">A five-run view of coverage, discrimination, and cases that need review.</p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{rows.length}</div><div className="text-xs text-muted-foreground">Test cases</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{totalRuns}</div><div className="text-xs text-muted-foreground">Runs</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{attentionRows.length}</div><div className="text-xs text-muted-foreground">Need attention</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{suiteRate === null ? '—' : `${Math.round(suiteRate * 100)}%`}</div><div className="text-xs text-muted-foreground">Recent pass rate</div></CardContent></Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><BarChart3 size={15} />Pass rate by difficulty</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {difficultyStats.length === 0 ? <p className="text-sm text-muted-foreground">No case data.</p> : difficultyStats.map(item => (
                <div key={item.difficulty}>
                  <div className="flex justify-between text-xs mb-1"><span>{item.difficulty}</span><span className="text-muted-foreground">{item.rate === null ? 'No scored runs' : `${Math.round(item.rate * 100)}%`}</span></div>
                  <Progress value={(item.rate || 0) * 100} className="h-2" />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle size={15} />Needs attention</CardTitle></CardHeader>
            <CardContent className="space-y-1">
              {attention.length === 0 ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2"><ShieldCheck size={15} />No recent failures or evaluator errors.</p>
              ) : attention.map(row => (
                <button key={row.testCase.id} type="button" onClick={() => onSelectCase(row.testCase.id)} className="w-full flex items-center justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-muted">
                  <span className="text-sm truncate">{row.testCase.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{row.verdicts.includes('errored') ? 'Evaluator error' : row.passRate === null ? 'No score' : `${Math.round(row.passRate * 100)}%`}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Recent runs</CardTitle>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onOpenRuns}>View Runs</Button>
          </CardHeader>
          <CardContent>
            {recentRuns.length === 0 ? <p className="text-sm text-muted-foreground">No completed runs yet.</p> : (
              <div className="divide-y">
                {recentRuns.slice(0, 3).map(run => (
                  <button key={run.id} type="button" onClick={onOpenRuns} className="w-full flex justify-between gap-3 py-2 text-left hover:text-primary">
                    <span className="text-sm truncate">{run.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{formatDate(run.createdAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export const BenchmarkCasesTab: React.FC<BenchmarkCasesTabProps> = ({
  benchmarkId,
  testCases,
  recentRuns,
  allRuns,
  totalRuns,
  reportsById,
  selectedCaseId,
  onSelectCase,
  onClearCase,
  onOpenRuns,
}) => {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CaseReviewFilter>('all');
  const [describeGroup, setDescribeGroup] = useState<DescribeGroupSelection>(null);
  const [lastSelectedCaseId, setLastSelectedCaseId] = useState<string | undefined>(selectedCaseId);
  const [visibleCount, setVisibleCount] = useState(CASE_LIST_PAGE_SIZE);
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreObserverRef = useRef<IntersectionObserver | null>(null);
  const pagerContainerRef = useRef<HTMLDivElement>(null);
  const pagerPaneRef = useRef<HTMLDivElement>(null);
  const swipeStartRef = useRef<{
    x: number;
    y: number;
    latched: boolean;
  } | null>(null);
  const pagerNavigationRef = useRef<{
    previousId?: string;
    nextId?: string;
    onSelectCase: (testCaseId: string) => void;
  }>({ onSelectCase });
  const prefersReducedMotionRef = useRef(false);
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationFrameRefs = useRef<number[]>([]);
  const animationTokenRef = useRef(0);

  const stopPagerAnimation = (resetVisual: boolean) => {
    animationTokenRef.current += 1;
    if (animationTimerRef.current !== null) {
      clearTimeout(animationTimerRef.current);
      animationTimerRef.current = null;
    }
    animationFrameRefs.current.forEach(frame => cancelAnimationFrame(frame));
    animationFrameRefs.current = [];
    if (resetVisual && pagerPaneRef.current) {
      pagerPaneRef.current.style.transition = 'none';
      pagerPaneRef.current.style.transform = '';
      pagerPaneRef.current.style.opacity = '';
      pagerPaneRef.current.style.willChange = '';
    }
  };

  useEffect(() => {
    if (selectedCaseId) setLastSelectedCaseId(selectedCaseId);
  }, [selectedCaseId]);

  const reviewCases = useMemo(
    () => testCases.map(testCase => ({ ...testCase, prompt: testCase.initialPrompt })),
    [testCases],
  );
  const rows = useMemo(
    () => buildCaseReviewRows(reviewCases, recentRuns, reportsById),
    [reviewCases, recentRuns, reportsById],
  );
  // Group-by-describe affordance: cases carrying a `describePath` bucket
  // under their outermost describe() title; legacy/JSON cases are ungrouped.
  const describeGrouping = useMemo(() => groupCasesByDescribe(testCases), [testCases]);
  const describeGroupIds = useMemo(() => {
    if (describeGroup === null) return null;
    if (describeGroup === UNGROUPED) return new Set(describeGrouping.ungroupedIds);
    return new Set(describeGrouping.groups.find(group => group.title === describeGroup)?.ids ?? []);
  }, [describeGroup, describeGrouping]);
  const filteredRows = useMemo(
    () => filterAndSortCaseRows(rows, search, filter)
      .filter(row => describeGroupIds === null || describeGroupIds.has(row.testCase.id)),
    [rows, search, filter, describeGroupIds],
  );
  const counts = useMemo(() => ({
    'needs-attention': rows.filter(row => row.bucket === 'needs-attention').length,
    flaky: rows.filter(row => row.bucket === 'flaky').length,
    stable: rows.filter(row => row.bucket === 'stable').length,
    'no-data': rows.filter(row => row.bucket === 'no-data').length,
  }), [rows]);
  const selectedRow = rows.find(row => row.testCase.id === selectedCaseId);
  const showsHistoricalVersionNotice = useMemo(() => {
    if (!selectedRow) return false;
    return hasHistoricalVersionMismatch(
      selectedRow.testCase.currentVersion,
      allRuns,
      selectedRow.testCase.id,
      reportsById,
    );
  }, [selectedRow, allRuns, reportsById]);
  const pager = getCasePagerPosition(filteredRows, selectedCaseId);
  pagerNavigationRef.current = {
    previousId: pager.previousId,
    nextId: pager.nextId,
    onSelectCase,
  };

  // Reset the incremental window whenever the filtered set changes shape
  // (search/filter), so switching views doesn't leave a stale, oversized
  // window mounted or hide rows that a narrower filter would show sooner.
  useEffect(() => {
    setVisibleCount(CASE_LIST_PAGE_SIZE);
  }, [search, filter, describeGroup]);

  // Always keep the selected/last-selected row rendered even if it falls
  // outside the incremental window (e.g. deep link, keyboard nav, or a
  // heat-strip click landing far down an unfiltered 400-case list).
  const visibleRowCount = Math.min(
    filteredRows.length,
    Math.max(visibleCount, pager.index >= 0 ? pager.index + 1 : 0),
  );
  const visibleRows = useMemo(
    () => filteredRows.slice(0, visibleRowCount),
    [filteredRows, visibleRowCount],
  );

  const loadMoreSentinelRef = useCallback((node: HTMLDivElement | null) => {
    loadMoreObserverRef.current?.disconnect();
    loadMoreObserverRef.current = null;
    // Environments without IntersectionObserver (older browsers, some test
    // harnesses) simply keep the fixed CASE_LIST_PAGE_SIZE window — degrades
    // to "click search/filter to narrow down" rather than throwing.
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(count => count + CASE_LIST_PAGE_SIZE);
      }
    }, { root: listRef.current, rootMargin: '200px' });
    observer.observe(node);
    loadMoreObserverRef.current = observer;
  }, []);

  useEffect(() => () => loadMoreObserverRef.current?.disconnect(), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const delta = event.key === 'ArrowDown' || event.key.toLowerCase() === 'j'
        ? 1
        : event.key === 'ArrowUp' || event.key.toLowerCase() === 'k'
          ? -1
          : 0;
      if (!delta || filteredRows.length === 0) return;
      event.preventDefault();
      const current = filteredRows.findIndex(row => row.testCase.id === selectedCaseId);
      const next = current < 0
        ? (delta > 0 ? 0 : filteredRows.length - 1)
        : Math.max(0, Math.min(filteredRows.length - 1, current + delta));
      const nextId = filteredRows[next].testCase.id;
      onSelectCase(nextId);
      requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-case-id="${CSS.escape(nextId)}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredRows, selectedCaseId, onSelectCase]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => {
      prefersReducedMotionRef.current = mediaQuery.matches;
      if (mediaQuery.matches) stopPagerAnimation(true);
    };
    updatePreference();
    mediaQuery.addEventListener?.('change', updatePreference);
    return () => mediaQuery.removeEventListener?.('change', updatePreference);
  }, []);

  const hasSelectedRow = Boolean(selectedRow);
  useEffect(() => {
    const container = pagerContainerRef.current;
    if (!container || !hasSelectedRow) return;

    const snapBack = () => {
      const pane = pagerPaneRef.current;
      if (!pane || prefersReducedMotionRef.current) {
        stopPagerAnimation(true);
        return;
      }

      stopPagerAnimation(false);
      const token = animationTokenRef.current;
      pane.style.transition = 'transform 150ms ease-out, opacity 150ms ease-out';
      pane.style.willChange = 'transform, opacity';
      void pane.offsetWidth;
      pane.style.transform = 'translate3d(0px, 0, 0)';
      pane.style.opacity = '1';
      animationTimerRef.current = setTimeout(() => {
        if (animationTokenRef.current !== token) return;
        pane.style.transition = 'none';
        pane.style.transform = '';
        pane.style.opacity = '';
        pane.style.willChange = '';
        animationTimerRef.current = null;
      }, 170);
    };

    const handleTouchStart = (event: TouchEvent) => {
      swipeStartRef.current = null;
      if (!window.matchMedia('(max-width: 767px)').matches || event.touches.length !== 1) return;
      stopPagerAnimation(true);
      swipeStartRef.current = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        latched: false,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const start = swipeStartRef.current;
      if (!start) return;
      if (event.touches.length !== 1) {
        swipeStartRef.current = null;
        snapBack();
        return;
      }

      const navigation = pagerNavigationRef.current;
      const drag = computePagerDrag({
        dx: event.touches[0].clientX - start.x,
        dy: event.touches[0].clientY - start.y,
        latched: start.latched,
        atStart: !navigation.previousId,
        atEnd: !navigation.nextId,
      });
      start.latched = drag.latched;
      if (!drag.latched || prefersReducedMotionRef.current) return;

      const pane = pagerPaneRef.current;
      if (!pane) return;
      pane.style.transition = 'none';
      pane.style.transform = `translate3d(${drag.offset}px, 0, 0)`;
      pane.style.opacity = '1';
      pane.style.willChange = 'transform, opacity';
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start || event.changedTouches.length !== 1) {
        if (start) snapBack();
        return;
      }

      const touch = event.changedTouches[0];
      const direction = resolveSwipeDirection(
        touch.clientX - start.x,
        touch.clientY - start.y,
        event.changedTouches.length,
      );
      const navigation = pagerNavigationRef.current;
      const targetId = direction === 'next'
        ? navigation.nextId
        : direction === 'prev'
          ? navigation.previousId
          : undefined;
      if (!direction || !targetId) {
        snapBack();
        return;
      }

      if (prefersReducedMotionRef.current) {
        stopPagerAnimation(true);
        navigation.onSelectCase(targetId);
        return;
      }

      const pane = pagerPaneRef.current;
      if (!pane) {
        navigation.onSelectCase(targetId);
        return;
      }

      stopPagerAnimation(false);
      const token = animationTokenRef.current;
      pane.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out';
      pane.style.willChange = 'transform, opacity';
      void pane.offsetWidth;
      pane.style.transform = direction === 'next'
        ? 'translate3d(-100%, 0, 0)'
        : 'translate3d(100%, 0, 0)';
      pane.style.opacity = '0';

      animationTimerRef.current = setTimeout(() => {
        if (animationTokenRef.current !== token) return;
        animationTimerRef.current = null;
        const currentPane = pagerPaneRef.current;
        if (!currentPane) {
          navigation.onSelectCase(targetId);
          return;
        }

        currentPane.style.transition = 'none';
        currentPane.style.transform = direction === 'next'
          ? 'translate3d(40px, 0, 0)'
          : 'translate3d(-40px, 0, 0)';
        currentPane.style.opacity = '0';
        void currentPane.offsetWidth;
        navigation.onSelectCase(targetId);

        const frame = requestAnimationFrame(() => {
          if (animationTokenRef.current !== token || !pagerPaneRef.current) return;
          const enteringPane = pagerPaneRef.current;
          void enteringPane.offsetWidth;
          enteringPane.style.transition = 'transform 180ms ease-out, opacity 180ms ease-out';
          enteringPane.style.transform = 'translate3d(0px, 0, 0)';
          enteringPane.style.opacity = '1';
          animationTimerRef.current = setTimeout(() => {
            if (animationTokenRef.current !== token || !pagerPaneRef.current) return;
            pagerPaneRef.current.style.transition = 'none';
            pagerPaneRef.current.style.transform = '';
            pagerPaneRef.current.style.opacity = '';
            pagerPaneRef.current.style.willChange = '';
            animationTimerRef.current = null;
          }, 200);
        });
        animationFrameRefs.current.push(frame);
      }, 200);
    };

    const handleTouchCancel = () => {
      if (!swipeStartRef.current) return;
      swipeStartRef.current = null;
      snapBack();
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchCancel, { passive: true });
    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchCancel);
      swipeStartRef.current = null;
      stopPagerAnimation(true);
    };
  }, [hasSelectedRow]);

  const filterButtons: Array<{ value: CaseReviewFilter; count: number }> = [
    { value: 'all', count: rows.length },
    { value: 'needs-attention', count: counts['needs-attention'] },
    { value: 'flaky', count: counts.flaky },
    { value: 'stable', count: counts.stable },
  ];

  return (
    <div className="flex-1 min-h-0 flex max-md:block overflow-hidden max-md:overflow-visible" data-testid="benchmark-cases-tab">
      <aside className={`w-[360px] xl:w-[400px] shrink-0 border-r flex flex-col min-h-0 max-md:w-full max-md:border-r-0 ${selectedRow ? 'max-md:hidden' : ''}`}>
        <div className="p-3 border-b space-y-3 shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search name or prompt"
              aria-label="Search cases by name or prompt"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {filterButtons.map(item => (
              <button
                type="button"
                key={item.value}
                onClick={() => setFilter(item.value)}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${filter === item.value ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'}`}
                aria-pressed={filter === item.value}
                title={FILTER_TOOLTIP[item.value]}
                data-testid={`case-filter-${item.value}`}
              >
                {FILTER_LABEL[item.value]} {item.count}
              </button>
            ))}
          </div>
          <DescribeGroupFilter grouping={describeGrouping} selected={describeGroup} onSelect={setDescribeGroup} />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{filteredRows.length} shown{counts['no-data'] > 0 ? ` · ${counts['no-data']} no data` : ''}</span>
            <span>Pass rate ↑ · ↑/↓ or j/k</span>
          </div>
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto max-md:max-h-none max-md:overflow-visible" role="listbox" aria-label="Benchmark cases">
          {filteredRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No cases match this view.</div>
          ) : <>{visibleRows.map(row => {
            const selected = row.testCase.id === (selectedCaseId || lastSelectedCaseId);
            const difficulty = difficultyFor(row.testCase);
            return (
              <button
                type="button"
                key={row.testCase.id}
                data-case-id={row.testCase.id}
                role="option"
                aria-selected={selected}
                onClick={() => onSelectCase(row.testCase.id)}
                className={`w-full text-left p-3 border-b transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected ? 'bg-primary/5 border-l-2 border-l-primary' : 'border-l-2 border-l-transparent'}`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{row.testCase.name}</span>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">{difficulty}</Badge>
                    </div>
                    {row.testCase.initialPrompt && <p className="text-[11px] text-muted-foreground truncate mt-1">{row.testCase.initialPrompt}</p>}
                  </div>
                  <div className="w-20 shrink-0 pt-1">
                    <Sparkline verdicts={row.verdicts} />
                    <div className="text-right text-[9px] text-muted-foreground mt-1">{row.passRate === null ? 'No score' : `${Math.round(row.passRate * 100)}% pass`}</div>
                  </div>
                  <ChevronRight size={14} className="text-muted-foreground shrink-0 mt-1" />
                </div>
              </button>
            );
          })}
          {visibleRows.length < filteredRows.length && (
            <div
              ref={loadMoreSentinelRef}
              key="load-more-sentinel"
              data-testid="case-list-load-more-sentinel"
              className="p-3 text-center text-[10px] text-muted-foreground"
            >
              Loading more cases… ({visibleRows.length} of {filteredRows.length})
            </div>
          )}</>}
        </div>
      </aside>

      <section className={`flex-1 min-w-0 min-h-0 ${selectedRow ? '' : 'max-md:hidden'}`}>
        {selectedRow ? (
          <div
            ref={pagerContainerRef}
            className="h-full min-h-0 overflow-hidden"
            data-mobile-case-pager
            style={{ touchAction: 'pan-y' }}
          >
            <div
              ref={pagerPaneRef}
              className="h-full flex flex-col min-h-0"
              data-testid="case-detail-pane"
              data-mobile-case-pane
            >
              <div className="border-b p-3 shrink-0 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Button variant="ghost" size="sm" className="md:hidden h-7 px-2" onClick={onClearCase}><ArrowLeft size={14} className="mr-1" />Cases</Button>
                  <div className="min-w-0">
                    <h3 className="font-semibold truncate">{selectedRow.testCase.name}</h3>
                    <DescribePathChain testCase={selectedRow.testCase} withLabel={false} className="mt-0.5" />
                    <p className="text-[11px] text-muted-foreground md:hidden">{FILTER_LABEL[filter]} · {pager.position} / {pager.total}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 md:hidden">
                  <Button variant="outline" size="icon" className="h-8 w-8" disabled={!pager.previousId} onClick={() => pager.previousId && onSelectCase(pager.previousId)} aria-label="Previous case"><ChevronLeft size={15} /></Button>
                  <Button variant="outline" size="icon" className="h-8 w-8" disabled={!pager.nextId} onClick={() => pager.nextId && onSelectCase(pager.nextId)} aria-label="Next case"><ChevronRight size={15} /></Button>
                </div>
                <Button variant="ghost" size="sm" className="hidden md:inline-flex h-7 text-xs" onClick={onClearCase}><X size={13} className="mr-1" />Suite health</Button>
              </div>
              {showsHistoricalVersionNotice && (
                <div
                  className="flex items-start gap-1.5 rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  data-testid="historical-version-notice"
                  role="note"
                >
                  <History size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Showing the current case definition (v{selectedRow.testCase.currentVersion}). At least one run below
                    evaluated an earlier version of this case, so its recorded pass/fail may not match the text shown here.
                  </span>
                </div>
              )}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Recent verdicts · newest first</div>
                <RecentVerdictChips benchmarkId={benchmarkId} testCase={selectedRow.testCase} recentRuns={recentRuns} reportsById={reportsById} />
              </div>
            </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
                <div className="max-w-4xl mx-auto">
                  <BenchmarkCaseDefinition
                    testCase={selectedRow.testCase}
                    totalRuns={allRuns.filter(run => !!run.results?.[selectedRow.testCase.id]).length}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <SuiteHealth rows={rows} recentRuns={recentRuns} totalRuns={totalRuns} onSelectCase={onSelectCase} onOpenRuns={onOpenRuns} />
        )}
      </section>

      {!selectedRow && (
        <div className="hidden max-md:block border-t mt-4">
          <SuiteHealth rows={rows} recentRuns={recentRuns} totalRuns={totalRuns} onSelectCase={onSelectCase} onOpenRuns={onOpenRuns} />
        </div>
      )}
    </div>
  );
};
