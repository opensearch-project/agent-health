/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ComparisonDeepDive — the top-level "what's actually different" panel for a
 * 2-run comparison.
 *
 * Calls POST /api/comparison/deep-dive, which runs an in-process pi agent with
 * read-only trace tools over BOTH runs and returns a concise markdown deep-dive
 * citing specific spans as `[label](span:<runId>:<spanId>)`. We render the
 * markdown and turn those span citations into clickable pills that deep-link
 * into the Traces tab of the relevant run on the same page (via onSpanLink).
 *
 * The agent run is ~30-60s and costs tokens, so results are cached in-memory by
 * report-id pair; the panel auto-runs once per pair and offers a regenerate.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Loader2, RefreshCw, ArrowUpRight, AlertTriangle, Lightbulb, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BenchmarkRun, EvaluationReport, TestCaseComparisonRow } from '@/types';
import { sanitizeMarkdownUrl } from './sanitizeMarkdownUrl';
import { DeepDiveHeaderMetrics } from './DeepDiveHeaderMetrics';

export interface DeepDiveRunMeta {
  key: string;
  reportId: string;
  runId?: string;
  serviceName?: string;
  startedAt: number;
  endedAt: number;
}
/** One A-vs-B numeric dimension the deep-dive agent found worth charting. */
interface DeepDiveChartSeriesPoint {
  label: string;
  a: number;
  b: number;
  unit?: string;
}
interface DeepDiveChartSpec {
  title: string;
  series: DeepDiveChartSeriesPoint[];
}
/** One concrete follow-up experiment idea grounded in this comparison. */
interface ExperimentSuggestion {
  title: string;
  rationale: string;
}
interface DeepDiveResponse {
  markdown: string;
  modelId: string;
  durationMs: number;
  runs: DeepDiveRunMeta[];
  chart?: DeepDiveChartSpec;
  experiments?: ExperimentSuggestion[];
}

interface CacheEntry { markdown: string; meta: DeepDiveResponse; }

// The agentic deep-dive is expensive (runs an in-process agent over both runs'
// spans/logs), so we cache the result. Reports are immutable, so the key (the
// two report ids) is stable forever — the cache is backed by localStorage so a
// page reload / re-navigation shows the prior result INSTANTLY instead of
// re-running the agent and showing the loading spinner every single time.
//
// Prompt/instruction changes (e.g. the judge-score labeling fix below) only
// take effect for NEWLY generated deep-dives — an already-cached markdown
// blob is served as-is until the user clicks "Regenerate" (or the cache key
// changes, which never happens for a stable report-id pair).
const DEEPDIVE_CACHE_PREFIX = 'agent-health:deepdive:';
const deepDiveMemCache = new Map<string, CacheEntry>();

// Change 4 — editable deep-dive system prompt (browser-cache ONLY, per owner
// request: no server-side persistence). A custom prompt is stored under this
// single, global (not per-pair) localStorage key — it applies to whichever
// pair the user next regenerates.
const SYSTEM_PROMPT_CACHE_KEY = 'agent-health:deepdive:system-prompt';

const deepDiveCache = {
  has(key: string): boolean {
    if (deepDiveMemCache.has(key)) return true;
    try { return localStorage.getItem(DEEPDIVE_CACHE_PREFIX + key) !== null; } catch { return false; }
  },
  get(key: string): CacheEntry | undefined {
    const mem = deepDiveMemCache.get(key);
    if (mem) return mem;
    try {
      const raw = localStorage.getItem(DEEPDIVE_CACHE_PREFIX + key);
      if (!raw) return undefined;
      const entry = JSON.parse(raw) as CacheEntry;
      deepDiveMemCache.set(key, entry);
      return entry;
    } catch { return undefined; }
  },
  set(key: string, entry: CacheEntry): void {
    deepDiveMemCache.set(key, entry);
    try { localStorage.setItem(DEEPDIVE_CACHE_PREFIX + key, JSON.stringify(entry)); } catch { /* quota/unavailable: mem cache still serves this session */ }
  },
};

interface ComparisonDeepDiveProps {
  runs: BenchmarkRun[];
  rows: TestCaseComparisonRow[];
  reports: Record<string, EvaluationReport>;
  getAgentName: (key: string) => string;
  /** Click a span citation → deep-link into the Traces tab of that run. */
  onSpanLink: (testCaseId: string, runId: string, spanId: string) => void;
  /** Resolved window-agent hints (serviceName + window) so the Traces tab can render spans. */
  onWindowAgents: (meta: DeepDiveRunMeta[]) => void;
}

export const ComparisonDeepDive: React.FC<ComparisonDeepDiveProps> = ({
  runs,
  rows,
  reports,
  getAgentName,
  onSpanLink,
  onWindowAgents,
}) => {
  // Representative pair: the first test case both runs executed.
  const pair = useMemo(() => {
    if (runs.length !== 2) return null;
    for (const row of rows) {
      const a = row.results[runs[0].id]?.reportId;
      const b = row.results[runs[1].id]?.reportId;
      if (a && b) {
        return {
          testCaseId: row.testCaseId,
          testCaseName: row.testCaseName,
          reportIdA: a,
          reportIdB: b,
          cacheKey: `${a}|${b}`,
        };
      }
    }
    return null;
  }, [runs, rows]);

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [markdown, setMarkdown] = useState<string>('');
  const [meta, setMeta] = useState<DeepDiveResponse | null>(null);
  const [error, setError] = useState<string>('');

  // ── Change 4: editable system prompt (browser-cache-only) ────────────────
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState<string>('');
  const [systemPromptText, setSystemPromptText] = useState<string>('');
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);

  useEffect(() => {
    let cached: string | null = null;
    try { cached = localStorage.getItem(SYSTEM_PROMPT_CACHE_KEY); } catch { /* ignore */ }
    if (cached) setSystemPromptText(cached);

    fetch('/api/comparison/deep-dive/system-prompt')
      .then(res => (res.ok ? res.json() : null))
      .then((data: { systemPrompt?: string } | null) => {
        if (!data?.systemPrompt) return;
        setDefaultSystemPrompt(data.systemPrompt);
        // No cached override yet — prefill with the real default so the
        // textarea never starts blank while the fetch is in flight.
        if (!cached) setSystemPromptText(data.systemPrompt);
      })
      .catch(() => { /* best-effort; textarea stays on the cached/blank value */ });
  }, []);

  const handleSystemPromptChange = useCallback((value: string) => {
    setSystemPromptText(value);
    try { localStorage.setItem(SYSTEM_PROMPT_CACHE_KEY, value); } catch { /* quota/unavailable */ }
  }, []);

  const handleResetSystemPrompt = useCallback(() => {
    try { localStorage.removeItem(SYSTEM_PROMPT_CACHE_KEY); } catch { /* ignore */ }
    setSystemPromptText(defaultSystemPrompt);
  }, [defaultSystemPrompt]);

  const generate = useCallback(
    async (force = false) => {
      if (!pair) return;
      if (!force && deepDiveCache.has(pair.cacheKey)) {
        const c = deepDiveCache.get(pair.cacheKey)!;
        setMarkdown(c.markdown);
        setMeta(c.meta);
        setStatus('done');
        onWindowAgents(c.meta.runs || []);
        return;
      }
      setStatus('loading');
      setError('');
      try {
        // Only send a systemPrompt override when it genuinely differs from the
        // built-in default — an unmodified textarea should hit the server's
        // own default rather than round-tripping an identical copy.
        const customSystemPrompt =
          systemPromptText.trim() && systemPromptText !== defaultSystemPrompt ? systemPromptText : undefined;
        const res = await fetch('/api/comparison/deep-dive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reportIds: [pair.reportIdA, pair.reportIdB],
            ...(customSystemPrompt ? { systemPrompt: customSystemPrompt } : {}),
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error || `HTTP ${res.status}`);
        }
        const data: DeepDiveResponse = await res.json();
        deepDiveCache.set(pair.cacheKey, { markdown: data.markdown, meta: data });
        setMarkdown(data.markdown);
        setMeta(data);
        setStatus('done');
        onWindowAgents(data.runs || []);
      } catch (e: any) {
        setError(e?.message || String(e));
        setStatus('error');
      }
    },
    [pair, onWindowAgents, systemPromptText, defaultSystemPrompt]
  );

  // Auto-run once per report-pair.
  useEffect(() => {
    if (pair) generate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.cacheKey]);

  // Map a cited runId → which agent label (for nicer pill titles).
  const labelByRunId = useMemo(() => {
    const m = new Map<string, string>();
    (meta?.runs || []).forEach((r, i) => {
      if (r.runId) m.set(r.runId, getAgentName(runs[i]?.agentKey) || r.key);
    });
    return m;
  }, [meta, runs, getAgentName]);

  if (!pair) return null;

  const nameA = getAgentName(runs[0].agentKey);
  const nameB = getAgentName(runs[1].agentKey);

  // A = runs[0], B = runs[1] (the URL order). Surface the A/B mapping
  // everywhere — header + span-citation pills — so a `span:subprocess-…`
  // citation is unambiguous about which run it belongs to.
  const abByRunId = new Map<string, 'A' | 'B'>();
  (meta?.runs || []).forEach((r, i) => { if (r.runId) abByRunId.set(r.runId, i === 0 ? 'A' : 'B'); });
  const AbBadge = ({ ab, className = '' }: { ab: 'A' | 'B'; className?: string }) => (
    <span className={`inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded text-[0.7rem] font-bold border ${ab === 'A' ? 'bg-opensearch-blue/15 text-opensearch-blue border-opensearch-blue/40' : 'bg-purple-500/20 text-purple-300 border-purple-400/40'} ${className}`}>{ab}</span>
  );

  // Custom anchor: `span:<runId>:<spanId>` → deep-link pill; others → normal link.
  const SpanAnchor = ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const m = /^span:([^:]+):(.+)$/.exec(href || '');
    if (m) {
      const [, runId, spanId] = m;
      const who = labelByRunId.get(runId);
      return (
        <button
          type="button"
          data-span-id={spanId}
          data-run-id={runId}
          onClick={() => onSpanLink(pair.testCaseId, runId, spanId)}
          title={`Open this span in the Traces tab${who ? ` (${who})` : ''}`}
          className="inline-flex items-center gap-0.5 align-baseline rounded bg-opensearch-blue/10 px-1.5 py-0.5 text-[0.85em] font-medium text-opensearch-blue hover:bg-opensearch-blue/20 transition-colors"
        >
          {abByRunId.get(runId) && <span className="font-bold opacity-80">{abByRunId.get(runId)}·</span>}
          {children}
          <ArrowUpRight size={11} className="flex-shrink-0" />
        </button>
      );
    }
    return (
      // `href` is already sanitized by ReactMarkdown's urlTransform
      // (sanitizeMarkdownUrl): dangerous schemes have been dropped to ''. Guard
      // anyway — render unsafe/empty links as plain text, never a live anchor.
      href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-opensearch-blue hover:underline">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      )
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card/40 p-4" data-testid="comparison-deep-dive">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={16} className="text-opensearch-blue flex-shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">What's actually different</h3>
            <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
              <AbBadge ab="A" /> {nameA} <span className="opacity-60">vs</span> <AbBadge ab="B" /> {nameB} <span className="opacity-60">· grounded in both runs' traces</span>
            </p>
            {/* Owner feedback: bare "100/100" bars misread as case counts in a
                multi-hundred-case comparison, and duplicated numbers visible
                elsewhere. Replaced with one compact labeled line here instead
                of a chart — see DeepDiveHeaderMetrics. Independent of `meta`/
                `status`, so it shows immediately (no need to wait on the LLM). */}
            <DeepDiveHeaderMetrics
              reportA={reports[pair.reportIdA]}
              reportB={reports[pair.reportIdB]}
              testCaseName={pair.testCaseName}
              testCaseId={pair.testCaseId}
            />
          </div>
        </div>
        {status === 'done' && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs flex-shrink-0" onClick={() => generate(true)}>
            <RefreshCw size={12} /> Regenerate
          </Button>
        )}
      </div>

      {/* Change 4 — editable system prompt (browser-cache only, nothing
          persisted server-side). Collapsed by default; edits are saved to
          localStorage as they're typed and threaded into the next
          Regenerate call when they differ from the built-in default. */}
      <div className="mb-2 border border-border/60 rounded-md">
        <button
          type="button"
          onClick={() => setSystemPromptOpen(o => !o)}
          className="flex items-center gap-1.5 w-full text-left px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          data-testid="deep-dive-system-prompt-toggle"
        >
          <ChevronRight size={12} className={systemPromptOpen ? 'rotate-90 transition-transform' : 'transition-transform'} />
          System prompt
        </button>
        {systemPromptOpen && (
          <div className="px-2.5 pb-2.5 space-y-1.5">
            <textarea
              value={systemPromptText}
              onChange={(e) => handleSystemPromptChange(e.target.value)}
              rows={8}
              data-testid="deep-dive-system-prompt-textarea"
              className="w-full text-[11px] font-mono leading-snug rounded border border-border bg-background p-2 resize-y focus:outline-none focus:ring-1 focus:ring-opensearch-blue"
              placeholder="Loading default system prompt…"
            />
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground/70">
                Edits are saved in this browser only — click Regenerate above to re-run with the edited prompt.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 text-[10px] flex-shrink-0"
                onClick={handleResetSystemPrompt}
                disabled={!defaultSystemPrompt || systemPromptText === defaultSystemPrompt}
                data-testid="deep-dive-system-prompt-reset"
              >
                <RotateCcw size={10} /> Reset to default
              </Button>
            </div>
          </div>
        )}
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin" />
          Inspecting both runs' spans &amp; logs…
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-start gap-2 py-3 text-sm text-amber-400">
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p>Couldn't generate the deep-dive: {error}</p>
            <Button variant="outline" size="sm" className="h-7 mt-2 text-xs" onClick={() => generate(true)}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {status === 'done' && (
        <>
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_li]:my-0.5 [&_strong]:text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={sanitizeMarkdownUrl} components={{ a: SpanAnchor }}>
              {markdown}
            </ReactMarkdown>
          </div>
          {meta?.experiments && meta.experiments.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border" data-testid="deep-dive-experiments">
              <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                <Lightbulb size={13} className="text-amber-400 flex-shrink-0" /> Suggested next experiments
              </h4>
              <ul className="space-y-2">
                {meta.experiments.map((s, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-medium text-foreground">{s.title}</span>
                    <div className="text-xs text-muted-foreground mt-0.5 [&_p]:m-0 prose-sm [&_a]:no-underline">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        urlTransform={sanitizeMarkdownUrl}
                        components={{ a: SpanAnchor, p: ({ children }) => <span>{children}</span> }}
                      >
                        {s.rationale}
                      </ReactMarkdown>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {meta && (
            <p className="text-[10px] text-muted-foreground/70 mt-3 pt-2 border-t border-border">
              Generated by {meta.modelId.split('/').pop()} in {(meta.durationMs / 1000).toFixed(0)}s · click a
              highlighted span to open it in the Traces tab below
            </p>
          )}
        </>
      )}
    </div>
  );
};
