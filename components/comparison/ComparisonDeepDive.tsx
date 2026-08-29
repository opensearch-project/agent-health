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
import { Sparkles, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BenchmarkRun, EvaluationReport, TestCaseComparisonRow } from '@/types';
import { sanitizeMarkdownUrl } from './sanitizeMarkdownUrl';
import { CitationLink } from '@/components/CitationLink';

export interface DeepDiveRunMeta {
  key: string;
  reportId: string;
  runId?: string;
  serviceName?: string;
  startedAt: number;
  endedAt: number;
}
interface DeepDiveResponse {
  markdown: string;
  modelId: string;
  durationMs: number;
  runs: DeepDiveRunMeta[];
}

interface CacheEntry { markdown: string; meta: DeepDiveResponse; }

// The agentic deep-dive is expensive (runs an in-process agent over both runs'
// spans/logs), so we cache the result. Reports are immutable, so the key (the
// two report ids) is stable forever — the cache is backed by localStorage so a
// page reload / re-navigation shows the prior result INSTANTLY instead of
// re-running the agent and showing the loading spinner every single time.
const DEEPDIVE_CACHE_PREFIX = 'agent-health:deepdive:';
const deepDiveMemCache = new Map<string, CacheEntry>();

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
        const res = await fetch('/api/comparison/deep-dive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reportIds: [pair.reportIdA, pair.reportIdB] }),
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
    [pair, onWindowAgents]
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

  // Shared custom-citation renderer: `span:<runId>:<spanId>` becomes a
  // deep-link pill; ordinary sanitized URLs remain normal links.
  const SpanAnchor = ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <CitationLink
      href={href}
      onSpanClick={(runId, spanId) => onSpanLink(pair.testCaseId, runId, spanId)}
      spanPrefix={(runId) => abByRunId.get(runId)
        ? <span className="font-bold opacity-80">{abByRunId.get(runId)}·</span>
        : null}
      spanTitle={(runId) => {
        const who = labelByRunId.get(runId);
        return `Open this span in the Traces tab${who ? ` (${who})` : ''}`;
      }}
    >
      {children}
    </CitationLink>
  );

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
          </div>
        </div>
        {status === 'done' && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs flex-shrink-0" onClick={() => generate(true)}>
            <RefreshCw size={12} /> Regenerate
          </Button>
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
