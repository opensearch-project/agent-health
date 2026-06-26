/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * TestCaseDetailPage — Evals 3: Test Case drill-down
 *
 * Split-panel layout matching RunInspectorPage:
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ← Back to Test Cases   Test Case Name        Edit | Run Test   │
 *   │ [TEST CASE] · labels · Created date · X runs · pass rate       │
 *   ├──────────────────┬──────────────────────────────────────────────┤
 *   │ Left Panel       │ Right Panel                                  │
 *   │ ▸ DEFINITION     │ TestCaseInspectorPanel for selected run      │
 *   │   5 expected     │                                              │
 *   │   3 context      │                                              │
 *   │ ─────────────    │                                              │
 *   │ RUNS (timeline)  │                                              │
 *   │ ✓ PASSED  88%    │                                              │
 *   │ ✗ FAILED  33%    │                                              │
 *   └──────────────────┴──────────────────────────────────────────────┘
 *
 * Route: /evaluations/test-cases/:testCaseId
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play, Calendar, CheckCircle2, XCircle, Pencil, AlertTriangle,
  FileText, Target, Loader2, X,
  Link as LinkIcon, Check as CheckIcon,
  GitBranch, Activity, Scale, MessageSquare, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useSidebarCollapse } from '@/components/Layout';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JudgeModelSelect } from '@/components/JudgeModelSelect';
import { asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { TestCase, EvaluationReport, TrajectoryStep, Evaluator, RunConfigInput } from '@/types';
import { getLabelColor, formatDate, formatRelativeTime, getModelName, getRunDisplayName } from '@/lib/utils';
import { RunScore } from '@/components/RunScore';
import { TestCaseEditor } from '@/components/TestCaseEditor';
import { TrajectoryView } from '@/components/TrajectoryView';
import { Breadcrumbs } from '@/components/evals3/Breadcrumbs';
import { TestCaseInspectorPanel } from '@/components/evals3/TestCaseInspectorPanel';
import { runServerEvaluation } from '@/services/client/evaluationApi';
import { DEFAULT_CONFIG, getPreferredDefaultAgentKey } from '@/lib/constants';
import { PREFS_KEYS } from '@/lib/preferences';
import { ENV_CONFIG } from '@/lib/config';

type TimeRange = '1h' | '6h' | '1d' | '7d' | '30d' | 'all';
const TIME_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
  { value: 'all', label: 'All time' },
];
function getTimeThreshold(range: TimeRange): Date | null {
  if (range === 'all') return null;
  const ms: Record<string, number> = { '1h': 3600000, '6h': 21600000, '1d': 86400000, '7d': 604800000, '30d': 2592000000 };
  return new Date(Date.now() - ms[range]);
}

type ResultStatus = 'passed' | 'failed' | 'errored' | 'running' | 'pending';
function getStatus(r: EvaluationReport): ResultStatus {
  // Issue #242: evaluator-error reports are bucketed as 'errored', not
  // 'failed'. metricsStatus wins over passFailStatus because the storage
  // layer may still carry a stale verdict on transient runs.
  if (r.metricsStatus === 'error') return 'errored';
  if (r.passFailStatus === 'passed') return 'passed';
  if (r.passFailStatus === 'failed') return 'failed';
  if (r.status === 'running') return 'running';
  return 'pending';
}

export const TestCaseDetailPage: React.FC = () => {
  const { testCaseId } = useParams<{ testCaseId: string }>();
  const navigate = useNavigate();
  const { isCollapsed, setIsCollapsed } = useSidebarCollapse();

  const [testCase, setTestCase] = useState<TestCase | null>(null);
  const [runs, setRuns] = useState<EvaluationReport[]>([]);
  const [totalRuns, setTotalRuns] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // UI state
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Tracks which row's copy-link button just succeeded — used to flip the
  // icon to a checkmark for a brief moment so the user has feedback.
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const initialSelectionDone = React.useRef(false);

  // ── Live run state (replaces blocking QuickRunModal) ─────────────────
  // We run the evaluation inline on this page so the user keeps full access
  // to the test case definition, runs list, and other navigation while the
  // agent works. Mirrors the BenchmarkRunsPage UX (config dialog → pill in
  // header → live progress).
  const [isRunning, setIsRunning] = useState(false);
  const [liveSteps, setLiveSteps] = useState<TrajectoryStep[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [reconnectState, setReconnectState] = useState<
    | null
    | { reportId: string; reason: string; lastStatus?: string }
  >(null);

  // Run config dialog (modeled on BenchmarkRunsPage's "Configure Run" dialog)
  const [isRunConfigOpen, setIsRunConfigOpen] = useState(false);
  const [runConfig, setRunConfig] = useState<RunConfigInput>({
    name: '', description: '', agentKey: '', modelId: '',
  });
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);

  // Synthetic ID for the in-progress run, used so the user can select it in
  // the runs list and watch its trajectory in the right panel. Replaced by
  // the real saved reportId once the server emits the completion event.
  const RUNNING_RUN_ID = '__running__';

  const loadData = useCallback(async () => {
    if (!testCaseId) return;
    setIsLoading(true);
    try {
      const [tc, { reports, total }] = await Promise.all([
        asyncTestCaseStorage.getById(testCaseId),
        asyncRunStorage.getReportsByTestCase(testCaseId),
      ]);
      if (!tc) { navigate('/evaluations/test-cases'); return; }
      setTestCase(tc);
      const sorted = reports.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setRuns(sorted);
      setTotalRuns(total);
      // Auto-select first run, auto-open definition if no runs (only on initial load)
      if (sorted.length > 0 && !initialSelectionDone.current) {
        setSelectedRunId(sorted[0].id);
        initialSelectionDone.current = true;
      }
    } catch (error) {
      console.error('Failed to load test case:', error);
    } finally {
      setIsLoading(false);
    }
  }, [testCaseId, navigate]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-collapse the global app sidebar while inspecting a single test case.
  // Run pages are dense, multi-pane views; the global nav competes with the
  // page's own left list (test runs / test cases). Restore on unmount so
  // navigating back to /evaluations/test-cases / / etc. shows the full nav.
  useEffect(() => {
    const prev = isCollapsed;
    setIsCollapsed(true);
    return () => setIsCollapsed(prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load evaluators once for the run config dialog.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setEvaluators(data.evaluators || []);
      } catch (error) {
        console.error('Failed to load evaluators:', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep the runs list rendered in a stable shape — selection is purely
  // in-page state. Sharing a specific run uses the canonical `/runs/:runId`
  // route (see `handleCopyRunLink` below), which loads the standalone
  // RunDetailsPage so the recipient gets full run context without needing
  // to know which test case it belonged to.

  // Build a quick lookup so the runs list can show evaluator names instead of
  // raw ids without re-rendering the whole evaluator picker.
  const evaluatorNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of evaluators) map[e.id] = e.name;
    return map;
  }, [evaluators]);

  // ── Copy-link handler ────────────────────────────────────────────────
  // Copies the canonical share URL for a run — `<origin>/runs/<id>`
  // — which lands on the standalone RunDetailsPage. We use the existing
  // route rather than a `?run=` query on this page so deep links work the
  // same regardless of how the user originally got to the run.
  //
  // The app uses BrowserRouter (see App.tsx) so the canonical URL has no
  // leading `#`. Using the wrong shape here would silently break shared
  // links — BrowserRouter would 404 on `#/runs/...`, dropping the user on
  // the dashboard instead of the requested run.
  const handleCopyRunLink = useCallback(async (runId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // don't trigger the row's onClick (which selects the run)
    const { origin } = window.location;
    const url = `${origin}/runs/${encodeURIComponent(runId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedRunId(runId);
      setTimeout(() => setCopiedRunId(prev => (prev === runId ? null : prev)), 1500);
    } catch (err) {
      // Clipboard API can fail in insecure contexts — fall back to a prompt
      // so the user can still grab the URL manually.
      console.warn('Clipboard write failed, falling back to prompt:', err);
      window.prompt('Copy run URL:', url);
    }
  }, []);

  const filteredRuns = useMemo(() => {
    const threshold = getTimeThreshold(timeRange);
    if (!threshold) return runs;
    return runs.filter(r => new Date(r.timestamp) >= threshold);
  }, [runs, timeRange]);

  const passCount = filteredRuns.filter(r => r.passFailStatus === 'passed').length;
  const failCount = filteredRuns.filter(r => r.passFailStatus === 'failed').length;
  // Issue #242: evaluator-error runs are bucketed separately and excluded
  // from the pass-rate denominator so a misconfigured judge can't drag
  // the per-test-case pass rate to 0%.
  const erroredCount = filteredRuns.filter(r => r.metricsStatus === 'error').length;
  const evaluable = Math.max(0, filteredRuns.length - erroredCount);
  const passRate = evaluable > 0 ? Math.round((passCount / evaluable) * 100) : 0;

  const selectedRun = filteredRuns.find(r => r.id === selectedRunId) || null;

  // ── Run handlers ──────────────────────────────────────────────────────

  const handleOpenRunConfig = () => {
    if (!testCase || isRunning) return;
    // Seed config from latest run (if any), else from persisted prefs, else defaults.
    const latestRun = runs[0];
    let defaultAgent = DEFAULT_CONFIG.agents[0]?.key || '';
    let defaultModel = Object.keys(DEFAULT_CONFIG.models)[0] || '';
    try {
      const storedAgent = localStorage.getItem('agent-health:' + PREFS_KEYS.agentKey);
      const storedModel = localStorage.getItem('agent-health:' + PREFS_KEYS.modelId);
      if (storedAgent) defaultAgent = JSON.parse(storedAgent);
      if (storedModel) defaultModel = JSON.parse(storedModel);
    } catch { /* fall through to defaults */ }
    if (!defaultAgent) defaultAgent = getPreferredDefaultAgentKey();
    setRunConfig({
      name: `Run ${runs.length + 1}`, description: '',
      agentKey: latestRun?.agentKey || defaultAgent,
      modelId: latestRun?.modelId || defaultModel,
      evaluatorId: latestRun?.evaluatorId,
    });
    setRunError(null);
    setIsRunConfigOpen(true);
  };

  const handleStartRun = async () => {
    // Guard against rapid double-click on the dialog's Run button. Without
    // this the second click would overwrite liveSteps and selectedRunId
    // mid-stream, interleaving steps from both runs under one synthetic
    // 'Running' pill, then the first run's completion handler would
    // attempt to select a stale `result.reportId`. Belt-and-braces with
    // the `disabled={isRunning}` already on the dialog Run button — React
    // state updates are async and there's a small window between
    // setIsRunning(true) and the next render where two clicks can both
    // see isRunning=false. This synchronous check closes that window.
    if (!testCase || isRunning) return;
    setIsRunConfigOpen(false);
    setIsRunning(true);
    setLiveSteps([]);
    setRunError(null);
    setReconnectState(null);
    // Auto-select the synthetic running entry so the live trajectory shows
    // up in the right panel without requiring a click.
    setSelectedRunId(RUNNING_RUN_ID);

    try {
      // Persist the user's agent/model choice so it stays the default next time
      // (matches QuickRunModal/BenchmarkRunsPage behavior).
      try {
        localStorage.setItem('agent-health:' + PREFS_KEYS.agentKey, JSON.stringify(runConfig.agentKey));
        localStorage.setItem('agent-health:' + PREFS_KEYS.modelId, JSON.stringify(runConfig.modelId));
      } catch { /* ignore quota errors */ }

      const result = await runServerEvaluation(
        {
          agentKey: runConfig.agentKey,
          modelId: runConfig.modelId,
          // Forward customer-supplied judge model id alongside agent
          // model. When undefined, the server picks via
          // evaluator.inferenceConfig.modelId → BEDROCK_MODEL_ID env.
          judgeModelId: runConfig.judgeModelId,
          testCaseId: testCase.id,
          evaluatorId: runConfig.evaluatorId,
          // Persist the user-supplied run name (or fall back to the
          // auto-generated default that the dialog seeds) so the runs list
          // shows a recognizable label for every entry.
          runName: runConfig.name?.trim() || undefined,
          runDescription: runConfig.description?.trim() || undefined,
        },
        {
          onStep: (step) => setLiveSteps(prev => [...prev, step]),
          onReconnect: (id, reason) => {
            setReconnectState({ reportId: id, reason });
          },
          onPoll: (r) => setReconnectState(prev => prev ? { ...prev, lastStatus: r.status } : prev),
        }
      );
      // Switch selection from the synthetic running entry to the real saved run.
      setReconnectState(null);
      // Reload runs so the new entry shows up, then select it.
      await loadData();
      setSelectedRunId(result.reportId);
    } catch (error) {
      console.error('Evaluation error:', error);
      setRunError(error instanceof Error ? error.message : 'Evaluation failed');
    } finally {
      setIsRunning(false);
    }
  };

  if (isLoading || !testCase) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[calc(100vh-200px)] w-full" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* ── Top Summary Bar ────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b bg-card shrink-0">
        <Breadcrumbs
          items={[
            { label: 'Evaluations', href: '/evaluations/benchmarks' },
            { label: 'Test Cases', href: '/evaluations/test-cases' },
            { label: testCase.name },
          ]}
          actions={<>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowEditor(true)} disabled={isRunning}>
              <Pencil size={12} className="mr-1" /> Edit
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs bg-opensearch-blue hover:bg-blue-600"
              onClick={handleOpenRunConfig}
              disabled={isRunning}
            >
              {isRunning
                ? <><Loader2 size={12} className="mr-1 animate-spin" /> Running…</>
                : <><Play size={12} className="mr-1" /> Run Test</>}
            </Button>
          </>}
        />
        <div className="mb-2">
          <h2 className="text-xl font-bold truncate">{testCase.name}</h2>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
          <Badge className="text-[10px] px-2 py-0.5 bg-muted text-muted-foreground border-border font-medium uppercase tracking-widest rounded shrink-0">
            Test Case
          </Badge>
          {testCase.labels?.length > 0 && testCase.labels.slice(0, 3).map(l => (
            <Badge key={l} variant="outline" className={`text-[9px] px-1.5 py-0 ${getLabelColor(l)}`}>{l}</Badge>
          ))}
          <span className="flex items-center gap-1"><Calendar size={11} /> {formatDate(testCase.createdAt)}</span>
          <span className="text-muted-foreground/30">·</span>
          <span>{totalRuns} run{totalRuns !== 1 ? 's' : ''}</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="flex items-center gap-1.5">
            <span className="text-green-500 font-medium">{passCount}✓</span>
            <span className="text-red-500 font-medium">{failCount}✗</span>
            {erroredCount > 0 && (
              <span
                className="flex items-center gap-0.5 text-amber-500 font-medium ml-1"
                title="Evaluator could not run (e.g. judge validation error). Excluded from pass-rate aggregation."
              >
                <AlertTriangle size={11} />
                {erroredCount}
              </span>
            )}
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span className={`font-medium ${passRate >= 80 ? 'text-green-500' : passRate >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
            {passRate}% pass rate
          </span>
        </div>
      </div>

      {/* ── Main Content: Left Panel + Right Panel ─────────────────── */}
      {selectedRunId ? (
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* ── Left Panel ──────────────────────────────────────────── */}
        <ResizablePanel defaultSize={30} minSize={20} maxSize={45} className="border-r">
          <ScrollArea className="h-full">
            {/* ── Collapsible Definition ──────────────────────────── */}
            <div className="border-b">
              {/* Definition is always shown above the runs list — the input
                  prompt and expected outcomes are the most useful piece of
                  context when reading any run, so we don't make the user
                  click a toggle every time they land on the page. */}
              <div className="px-3 py-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Definition</span>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  {testCase.expectedOutcomes?.length > 0 && (
                    <span className="flex items-center gap-0.5"><Target size={9} /> {testCase.expectedOutcomes.length} expected</span>
                  )}
                  {testCase.context?.length > 0 && (
                    <span>{testCase.context.length} context</span>
                  )}
                </div>
              </div>
              <div className="px-3 pb-3 space-y-2.5">
                  {/* Input prompt */}
                  <div>
                    <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Input</div>
                    <div className="text-[10px] bg-muted/40 rounded px-2 py-1.5 border border-border max-h-20 overflow-y-auto break-words leading-relaxed">
                      {testCase.initialPrompt || '—'}
                    </div>
                  </div>
                  {/* Expected outcomes */}
                  {testCase.expectedOutcomes?.length > 0 && (
                    <div>
                      <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Expected</div>
                      <ul className="space-y-0.5">
                        {testCase.expectedOutcomes.map((o, i) => (
                          <li key={i} className="text-[10px] text-muted-foreground flex items-start gap-1 leading-snug">
                            <CheckCircle2 size={9} className="text-green-500 mt-0.5 shrink-0" />
                            <span className="break-words min-w-0">{o}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* Context */}
                  {testCase.context?.length > 0 && (
                    <div>
                      <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Context ({testCase.context.length})</div>
                      <div className="space-y-1">
                        {testCase.context.map((ctx, i) => (
                          <div key={i} className="bg-muted/30 rounded px-2 py-1 border border-border overflow-hidden">
                            <p className="text-[9px] font-medium text-muted-foreground truncate">{ctx.description}</p>
                            <pre className="text-[9px] overflow-x-auto max-h-10 overflow-y-auto whitespace-pre-wrap break-all">{ctx.value.slice(0, 100)}{ctx.value.length > 100 ? '…' : ''}</pre>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
            </div>

            {/* ── Runs List ───────────────────────────────────────── */}
            <div className="px-3 pt-2 pb-1 border-b flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Test Case Runs ({filteredRuns.length})</span>
              <select
                value={timeRange}
                onChange={e => setTimeRange(e.target.value as TimeRange)}
                className="text-[10px] px-1.5 py-0.5 bg-background border border-border rounded"
              >
                {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="p-2 space-y-0.5">
              {/* In-progress run pinned to the top of the list. Mirrors
                  BenchmarkRunsPage's "Running" pill so the user can see at
                  a glance that work is happening, and click into it to watch
                  the live trajectory. */}
              {isRunning && (
                <div
                  className={`flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                    selectedRunId === RUNNING_RUN_ID
                      ? 'bg-primary/10 border border-primary/30'
                      : 'hover:bg-muted/50 border border-transparent'
                  }`}
                  onClick={() => setSelectedRunId(RUNNING_RUN_ID)}
                >
                  <Loader2 size={12} className="text-blue-500 animate-spin shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    {/* Match the shape of persisted-run rows: name on top,
                        agent · evaluator · model below. We show RUNNING as a
                        small pill rather than the primary label so the
                        list visually reads as "name + status + meta". */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] font-semibold text-foreground truncate">
                        {runConfig.name?.trim() || 'New run'}
                      </span>
                      <Badge variant="outline" className="text-[7px] px-1 py-0 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/30">
                        Live
                      </Badge>
                      <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 ml-auto shrink-0">
                        {liveSteps.length} step{liveSteps.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="text-[9px] text-muted-foreground mt-0.5 truncate">
                      <span className="text-foreground/80">
                        {(DEFAULT_CONFIG.agents.find(a => a.key === runConfig.agentKey)?.name) || runConfig.agentKey || '—'}
                      </span>
                      <span className="mx-1 opacity-50">·</span>
                      <span>
                        {runConfig.evaluatorId
                          ? (evaluatorNameById[runConfig.evaluatorId] || runConfig.evaluatorId)
                          : 'Default'}
                      </span>
                      <span className="mx-1 opacity-50">·</span>
                      <span>{getModelName(runConfig.modelId)}</span>
                    </div>
                  </div>
                </div>
              )}
              {filteredRuns.length === 0 && !isRunning ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <FileText size={24} className="mb-2 opacity-20" />
                  <p className="text-[10px]">No runs yet</p>
                </div>
              ) : (
                filteredRuns.map((run, index) => {
                  // Issue #242: triage rows by metricsStatus FIRST so an
                  // errored run lights up the amber AlertTriangle and not
                  // the red XCircle (which would conflate it with a real
                  // agent failure).
                  const isErrored = run.metricsStatus === 'error';
                  const isPassed = !isErrored && run.passFailStatus === 'passed';
                  const isSelected = run.id === selectedRunId;
                  const isLatest = index === 0;
                  const runName = getRunDisplayName(run);
                  // Resolve evaluator label — falls back to id for runs whose
                  // evaluator was deleted, or to a generic 'Default' for legacy
                  // runs that pre-date evaluator selection.
                  const evaluatorLabel = run.evaluatorId
                    ? (evaluatorNameById[run.evaluatorId] || run.evaluatorId)
                    : 'Default';
                  const modelLabel = getModelName(run.modelName);
                  const justCopied = copiedRunId === run.id;
                  return (
                    <div
                      key={run.id}
                      className={`flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors group ${
                        isSelected ? 'bg-primary/10 border border-primary/30' : 'hover:bg-muted/50 border border-transparent'
                      }`}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      {/* Pass/fail/errored icon — the only place status is
                          shown. The text label was previously here too, but
                          the run name is more useful and the icon already
                          conveys status at a glance. Issue #242: errored
                          runs render an amber AlertTriangle to distinguish
                          evaluator failures from agent failures. */}
                      <div
                        className="shrink-0 mt-0.5"
                        title={isErrored ? 'Errored (evaluator could not run)' : isPassed ? 'Passed' : 'Failed'}
                      >
                        {isErrored
                          ? <AlertTriangle size={12} className="text-amber-500" />
                          : isPassed
                            ? <CheckCircle2 size={12} className="text-green-500" />
                            : <XCircle size={12} className="text-red-500" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        {/* Row 1: run name + Latest badge + copy-link + accuracy */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className="text-[11px] font-semibold text-foreground truncate"
                            title={runName}
                          >
                            {runName}
                          </span>
                          {isLatest && (
                            <Badge variant="outline" className="text-[7px] px-1 py-0 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/30">
                              Latest
                            </Badge>
                          )}
                          {/* Copy-link icon — copies the canonical /runs/<id>
                              share URL. Hidden by default and revealed on row
                              hover or focus to keep the row compact. */}
                          <button
                            type="button"
                            onClick={(e) => handleCopyRunLink(run.id, e)}
                            className={`shrink-0 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity ${
                              justCopied || isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                            }`}
                            title={justCopied ? 'Copied!' : 'Copy run URL'}
                            aria-label="Copy run URL"
                          >
                            {justCopied
                              ? <CheckIcon size={11} className="text-green-500" />
                              : <LinkIcon size={11} />}
                          </button>
                          <RunScore
                            metrics={run.metrics as Record<string, number | undefined>}
                            showLabel={false}
                            className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 ml-auto shrink-0"
                          />
                        </div>
                        {/* Row 2: agent · evaluator · judge model */}
                        <div
                          className="text-[9px] text-muted-foreground mt-0.5 truncate"
                          title={`Agent: ${run.agentName || '—'} • Evaluator: ${evaluatorLabel} • Judge: ${modelLabel}`}
                        >
                          <span className="text-foreground/80">{run.agentName || '—'}</span>
                          <span className="mx-1 opacity-50">·</span>
                          <span>{evaluatorLabel}</span>
                          <span className="mx-1 opacity-50">·</span>
                          <span>{modelLabel}</span>
                        </div>
                        {/* Row 3: timestamp (separate so it stays visible even
                            when row 2 truncates on narrow panels) */}
                        <div className="text-[9px] text-muted-foreground/70 mt-0.5">
                          {formatRelativeTime(run.timestamp)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* ── Right Panel: Test Case Inspector ────────────────────── */}
        <ResizablePanel defaultSize={70} minSize={50}>
          {isRunning && selectedRunId === RUNNING_RUN_ID ? (
            <LiveRunPanel
              testCase={testCase}
              steps={liveSteps}
              runName={runConfig.name}
              agentKey={runConfig.agentKey}
              modelId={runConfig.modelId}
              error={runError}
              reconnect={reconnectState}
            />
          ) : selectedRun ? (
            <TestCaseInspectorPanel
              report={selectedRun}
              testCase={testCase}
              status={getStatus(selectedRun)}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <FileText size={32} className="mx-auto mb-3 opacity-20" />
                <p className="text-sm">{filteredRuns.length === 0 ? 'No test case runs yet' : 'Select a run to inspect'}</p>
                {filteredRuns.length === 0 && testCase && (
                  <Button size="sm" className="mt-3 bg-opensearch-blue hover:bg-blue-600" onClick={handleOpenRunConfig} disabled={isRunning}>
                    <Play size={12} className="mr-1" /> Run Test
                  </Button>
                )}
              </div>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
      ) : (
        /* Full-width left panel when no run selected */
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            {/* Definition section — always open when no run selected */}
            <div className="border-b px-4 py-3 space-y-2.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Definition</div>
              <div>
                <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Input</div>
                <div className="text-xs bg-muted/40 rounded px-3 py-2 border border-border break-words leading-relaxed">
                  {testCase.initialPrompt || '—'}
                </div>
              </div>
              {testCase.expectedOutcomes?.length > 0 && (
                <div>
                  <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Expected</div>
                  <ul className="space-y-1">
                    {testCase.expectedOutcomes.map((o, i) => (
                      <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                        <CheckCircle2 size={11} className="text-green-500 mt-0.5 shrink-0" />
                        <span>{o}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {/* Runs list */}
            <div className="px-4 pt-3 pb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Test Case Runs ({filteredRuns.length})</span>
            </div>
            <div className="px-4 py-2 space-y-1">
              {filteredRuns.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <FileText size={32} className="mb-3 opacity-20" />
                  <p className="text-sm">No test case runs yet</p>
                  <Button size="sm" className="mt-3 bg-opensearch-blue hover:bg-blue-600" onClick={handleOpenRunConfig} disabled={isRunning}>
                    <Play size={12} className="mr-1" /> Run Test
                  </Button>
                </div>
              ) : (
                filteredRuns.map((run, index) => {
                  const isErrored = run.metricsStatus === 'error';
                  const isPassed = !isErrored && run.passFailStatus === 'passed';
                  const runName = getRunDisplayName(run);
                  const evaluatorLabel = run.evaluatorId
                    ? (evaluatorNameById[run.evaluatorId] || run.evaluatorId)
                    : 'Default';
                  const modelLabel = getModelName(run.modelName);
                  const justCopied = copiedRunId === run.id;
                  return (
                    <div
                      key={run.id}
                      className="group flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors hover:bg-muted/50 border border-transparent"
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      {isErrored
                        ? <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                        : isPassed
                          ? <CheckCircle2 size={14} className="text-green-500 shrink-0" />
                          : <XCircle size={14} className="text-red-500 shrink-0" />}
                      <span className="text-xs font-semibold text-foreground truncate" title={runName}>{runName}</span>
                      {index === 0 && <Badge variant="outline" className="text-[7px] px-1 py-0 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/30">Latest</Badge>}
                      {/* Copy-link icon for the canonical /runs/<id> URL. Hidden
                          until row hover, mirroring the split-panel rows. */}
                      <button
                        type="button"
                        onClick={(e) => handleCopyRunLink(run.id, e)}
                        className={`shrink-0 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity ${
                          justCopied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                        }`}
                        title={justCopied ? 'Copied!' : 'Copy run URL'}
                        aria-label="Copy run URL"
                      >
                        {justCopied
                          ? <CheckIcon size={12} className="text-green-500" />
                          : <LinkIcon size={12} />}
                      </button>
                      <span
                        className="text-[10px] text-muted-foreground flex-1 truncate"
                        title={`Agent: ${run.agentName || '—'} • Evaluator: ${evaluatorLabel} • Judge: ${modelLabel}`}
                      >
                        {run.agentName || '—'} · {evaluatorLabel} · {modelLabel} · {formatRelativeTime(run.timestamp)}
                      </span>
                      <RunScore
                        metrics={run.metrics as Record<string, number | undefined>}
                        showLabel={false}
                        className="text-xs font-semibold text-blue-600 dark:text-blue-400 shrink-0"
                      />
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────── */}
      {/* Run configuration dialog — small, dismissable, closes immediately
          on "Start Run". The actual run is then carried out inline on the
          page so the user keeps full access to navigation and the runs list. */}
      {isRunConfigOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-lg">Configure Run</CardTitle>
              <Button variant="ghost" size="icon" onClick={() => setIsRunConfigOpen(false)}>
                <X size={18} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="tc-run-name">Run Name</Label>
                <Input
                  id="tc-run-name"
                  value={runConfig.name}
                  onChange={e => setRunConfig(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Baseline, With Fix"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tc-run-description">Description (optional)</Label>
                <Textarea
                  id="tc-run-description"
                  value={runConfig.description || ''}
                  onChange={e => setRunConfig(prev => ({ ...prev, description: e.target.value || undefined }))}
                  placeholder="Describe what this run tests or changes…"
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <Label>Agent</Label>
                {/* The agent's LLM is owned by the agent's own config
                    (agent-health.config.ts) — there is no agent-model picker;
                    the agent controls which model it runs on. */}
                <Select value={runConfig.agentKey} onValueChange={val => setRunConfig(prev => ({ ...prev, agentKey: val }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DEFAULT_CONFIG.agents.map(agent => (
                      <SelectItem key={agent.key} value={agent.key}>{agent.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Evaluator</Label>
                  <Select
                    value={runConfig.evaluatorId || '__default__'}
                    onValueChange={val => setRunConfig(prev => ({ ...prev, evaluatorId: val === '__default__' ? undefined : val }))}
                  >
                    <SelectTrigger><SelectValue placeholder="RCA Default" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">RCA Default</SelectItem>
                      {evaluators.map(evaluator => (
                        <SelectItem key={evaluator.id} value={evaluator.id}>
                          {evaluator.name} {evaluator.isSystem ? '(System)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  {/* Judge Model — customer input, distinct from the
                      agent's model. "Use evaluator default" maps to
                      undefined; server resolves from
                      evaluator.inferenceConfig.modelId then BEDROCK_MODEL_ID.
                      Includes ALL providers (pi/agent/agentic/claude-code/
                      bedrock/openai-compatible) since this dropdown
                      controls the judge LLM, not the agent's. */}
                  <Label>Judge Model</Label>
                  <JudgeModelSelect
                    value={runConfig.judgeModelId ?? ''}
                    onValueChange={val => setRunConfig(prev => ({ ...prev, judgeModelId: val || undefined }))}
                    allowDefault={true}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setIsRunConfigOpen(false)}>Cancel</Button>
                <Button
                  onClick={handleStartRun}
                  disabled={isRunning || !runConfig.name.trim() || !runConfig.agentKey || !runConfig.modelId}
                  className="bg-opensearch-blue hover:bg-blue-600"
                >
                  <Play size={16} className="mr-1" /> Start Run
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      {showEditor && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
          <div className="fixed inset-4 z-50 overflow-auto bg-background border rounded-lg shadow-lg">
            <TestCaseEditor testCase={testCase} onSave={async () => { setShowEditor(false); loadData(); }} onCancel={() => setShowEditor(false)} />
          </div>
        </div>
      )}
    </div>
  );
};

// ── Live run right-panel ────────────────────────────────────────────────────────
// Mirrors the *exact* tab layout of the saved-run inspector
// (`TestCaseInspectorPanel` → `RunDetailsContent`) — same compact header,
// same Overview / Test Case Output / Traces / LLM Judge / Annotations
// tabs, same icons and styling — so the right panel doesn't visually shift
// when the run finishes and we swap the synthetic running entry for the
// real saved report.
//
// While the run is in flight:
//   * Test Case Output is the default tab and streams trajectory steps
//     live (TrajectoryView with `loading={true}` + auto-scroll).
//   * Overview shows the test case definition (input prompt + expected
//     outcomes) since metrics aren't computed yet.
//   * Traces / LLM Judge / Annotations show informative placeholders that
//     explain they'll be available once the run completes.
interface LiveRunPanelProps {
  testCase: TestCase;
  steps: TrajectoryStep[];
  runName: string;
  agentKey: string;
  modelId: string;
  error: string | null;
  reconnect: { reportId: string; reason: string; lastStatus?: string } | null;
}
const LiveRunPanel: React.FC<LiveRunPanelProps> = ({
  testCase, steps, runName, agentKey, modelId, error, reconnect,
}) => {
  // Default tab is Test Case Output so the user immediately sees the
  // streaming trajectory — that's the whole point of running inline.
  const [activeTab, setActiveTab] = useState<string>('trajectory');

  // Auto-scroll the trajectory body to the bottom as new steps stream in so
  // the latest tool call is always visible without manual scrolling.
  const trajectoryScrollRef = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeTab !== 'trajectory') return;
    const el = trajectoryScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length, activeTab]);

  const agentLabel = (DEFAULT_CONFIG.agents.find(a => a.key === agentKey)?.name) || agentKey || '—';
  const modelLabel = getModelName(modelId);

  return (
    <div className="h-full flex flex-col">
      {/* Compact header — same chrome as `TestCaseInspectorPanel` */}
      <div className="px-4 py-2.5 border-b bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Loader2 size={16} className="text-blue-500 animate-spin shrink-0" />
          <span className="text-sm font-semibold truncate flex-1">
            {runName?.trim() ? runName : testCase.name}
          </span>
          <Badge className="text-[9px] px-1.5 py-0 shrink-0 bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/30">
            RUNNING
          </Badge>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1 truncate">
          {agentLabel}{' · '}{modelLabel}{' · '}{steps.length} step{steps.length === 1 ? '' : 's'} streamed
        </div>
      </div>

      {/* Banners (reconnect / error) sit above the tab strip so they're always
          visible regardless of which tab the user is on. */}
      {(reconnect || error) && (
        <div className="px-4 pt-3 space-y-2 shrink-0">
          {reconnect && (
            <div className="p-3 text-sm rounded border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <Loader2 size={14} className="mt-0.5 animate-spin shrink-0" />
              <div>
                <div className="font-medium">Stream disconnected — reconnecting via polling…</div>
                <div className="text-xs opacity-80 mt-0.5">
                  The server is still running the evaluation. Waiting for it to finish.
                  {reconnect.lastStatus ? ` (status: ${reconnect.lastStatus})` : ''}
                </div>
              </div>
            </div>
          )}
          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 rounded border border-red-200 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Tabs — same trigger labels, icons, and styling as RunDetailsContent
          so when the run finishes and we hand off to TestCaseInspectorPanel,
          the user sees no visual jump. */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start rounded-none border-b bg-card h-auto p-0">
          <TabsTrigger value="trajectory" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <GitBranch size={14} className="mr-2" /> Test Case Output
            <Badge variant="secondary" className="ml-2">{steps.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="logs" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <Activity size={14} className="mr-2" /> Traces
          </TabsTrigger>
          <TabsTrigger value="judge" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <Scale size={14} className="mr-2" /> Judge Evaluation
          </TabsTrigger>
          <TabsTrigger value="annotations" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <MessageSquare size={14} className="mr-2" /> Annotations
          </TabsTrigger>
        </TabsList>

        {/* Test Case Output — the live, streaming trajectory. This is the
            default (and only meaningful) live tab; everything else needs the
            run to finish before there's anything to show. */}
        <TabsContent value="trajectory" className="flex-1 overflow-hidden mt-0">
          <div ref={trajectoryScrollRef} className="h-full overflow-y-auto p-6">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Input</h3>
              <div className="text-xs bg-muted/40 rounded px-3 py-2 border border-border break-words leading-relaxed whitespace-pre-wrap">
                {testCase.initialPrompt || '—'}
              </div>
            </div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Test Case Output</h3>
            <TrajectoryView steps={steps} loading={true} />
          </div>
        </TabsContent>

        {/* Traces — placeholder. The OpenTelemetry spans are attached to the
            run record at completion time; nothing meaningful to show yet. */}
        <TabsContent value="logs" className="flex-1 overflow-y-auto p-6 mt-0">
          <div className="flex flex-col items-center justify-center text-center text-muted-foreground py-16">
            <Activity size={32} className="mb-3 opacity-30" />
            <p className="text-sm font-medium">Traces will appear here when the run completes</p>
            <p className="text-xs mt-1">
              Span data is collected from the agent and persisted alongside the run record.
            </p>
          </div>
        </TabsContent>

        {/* LLM Judge — placeholder. Judging happens after the agent finishes
            its trajectory, so reasoning isn't available mid-run. */}
        <TabsContent value="judge" className="flex-1 overflow-y-auto p-6 mt-0">
          <div className="flex flex-col items-center justify-center text-center text-muted-foreground py-16">
            <Scale size={32} className="mb-3 opacity-30" />
            <p className="text-sm font-medium">Judge evaluation will appear here once judging completes</p>
            <p className="text-xs mt-1">
              The judge runs after the agent finishes; expect a short delay after the trajectory ends.
            </p>
          </div>
        </TabsContent>

        {/* Annotations — disabled until the run is saved with a real ID. */}
        <TabsContent value="annotations" className="flex-1 overflow-y-auto p-6 mt-0">
          <div className="flex flex-col items-center justify-center text-center text-muted-foreground py-16">
            <MessageSquare size={32} className="mb-3 opacity-30" />
            <p className="text-sm font-medium">Annotations are available after the run is saved</p>
            <p className="text-xs mt-1">
              You'll be able to add notes once the agent finishes and the run is persisted.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};
