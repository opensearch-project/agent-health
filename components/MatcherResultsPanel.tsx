/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MatcherResultsPanel — collapsible per-matcher breakdown for runs that
 * captured matcher verdicts (code-assertion / llm-judge / traces).
 *
 * Each row shows:
 *   ✓ description                         [method badge]   meta
 *   ✗ description                         [method badge]
 *      → expected … actual …  | reasoning | errorMessage
 *
 * Renders nothing when matcherResults is empty / undefined.
 */

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckCircle2, XCircle, ChevronDown, ChevronRight, Brain, Code2, Activity, Wrench } from 'lucide-react';
import type { MatcherResult, MatcherMethod } from '@/lib/matchers/types';
import { Badge } from '@/components/ui/badge';

interface Props {
  results: MatcherResult[];
}

const METHOD_META: Record<MatcherMethod, { label: string; icon: React.ReactNode; cls: string }> = {
  'code-assertion': {
    label: 'code',
    icon: <Code2 size={11} className="text-muted-foreground" />,
    cls: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-700/40 dark:text-slate-300 dark:border-slate-600',
  },
  'llm-judge': {
    label: 'judge',
    icon: <Brain size={11} className="text-purple-500" />,
    cls: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30',
  },
  traces: {
    label: 'traces',
    icon: <Activity size={11} className="text-blue-500" />,
    cls: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
  },
  evaluator: {
    label: 'evaluator',
    icon: <Wrench size={11} className="text-amber-500" />,
    cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  },
};

export const MatcherResultsPanel: React.FC<Props> = ({ results }) => {
  if (!results || results.length === 0) return null;

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
        Matchers
        <span className="text-xs font-normal text-muted-foreground">
          ({passed}/{results.length} passed{failed > 0 ? `, ${failed} failed` : ''})
        </span>
      </h3>
      <div className="border rounded-lg divide-y bg-card">
        {results.map((r, idx) => (
          <MatcherRow key={`${idx}-${r.description}`} result={r} />
        ))}
      </div>
    </div>
  );
};

interface RowProps {
  result: MatcherResult;
}

const MatcherRow: React.FC<RowProps> = ({ result }) => {
  const judgeStrategies = (result as any).improvementStrategies as Array<{
    category: string;
    issue: string;
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
  }> | undefined;
  const judgeMetrics = (result as any).judgeMetrics as Record<string, number | undefined> | undefined;
  const hasDetail =
    !!result.errorMessage ||
    !!result.reasoning ||
    result.actual !== undefined ||
    result.expected !== undefined ||
    (judgeStrategies && judgeStrategies.length > 0) ||
    (judgeMetrics && Object.keys(judgeMetrics).filter(k => k !== 'accuracy').length > 0);
  const [open, setOpen] = useState((result.method === 'llm-judge' || !result.pass) && hasDetail);
  const meta = METHOD_META[result.method] ?? METHOD_META['code-assertion'];
  // Visual accent: judge rows get a subtle left border in the brand purple
  // so they stand out from the chai code-assertion noise.
  const accent =
    result.method === 'llm-judge'
      ? 'border-l-2 border-l-purple-400/50 dark:border-l-purple-500/40'
      : '';

  return (
    <div className={`px-3 py-2 ${accent}`}>
      <div
        role={hasDetail ? 'button' : undefined}
        tabIndex={hasDetail ? 0 : -1}
        onClick={hasDetail ? () => setOpen(o => !o) : undefined}
        onKeyDown={
          hasDetail
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen(o => !o);
                }
              }
            : undefined
        }
        className={`flex items-start gap-2 ${hasDetail ? 'cursor-pointer' : ''}`}
      >
        <div className="pt-0.5 shrink-0">
          {result.pass ? (
            <CheckCircle2 size={14} className="text-green-600" />
          ) : (
            <XCircle size={14} className="text-red-600" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm ${result.pass ? '' : 'text-red-600 dark:text-red-400 font-medium'}`}>
              {result.description || '(matcher)'}
            </span>
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 inline-flex items-center gap-1 ${meta.cls}`}>
              {meta.icon}
              {meta.label}
            </Badge>
            {typeof result.score === 'number' && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                score {(result.score * 100).toFixed(0)}%
              </span>
            )}
            {typeof result.durationMs === 'number' && result.durationMs > 0 && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {result.durationMs}ms
              </span>
            )}
          </div>
        </div>
        {hasDetail && (
          <div className="pt-0.5 shrink-0 text-muted-foreground">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        )}
      </div>

      {open && hasDetail && (
        <div className="mt-2 pl-6 space-y-1.5 text-xs">
          {result.errorMessage && (
            <div className="text-red-600 dark:text-red-400">
              <span className="font-semibold">error:</span> {result.errorMessage}
            </div>
          )}
          {result.reasoning && (
            <div>
              <div className="font-semibold text-foreground mb-1.5">reasoning</div>
              {result.method === 'llm-judge' ? (
                // Render as markdown so headers, bullets, and bold formatting
                // from the Bedrock judge come through as structure rather than
                // literal `**` / `-` characters in plain prose.
                //
                // Spacing notes:
                //   prose-headings:first:mt-0  — first header sits flush with
                //                                 the "reasoning" label so the
                //                                 first row doesn't double-space.
                //   prose-p:first:mt-0          — same for plain-prose responses.
                //   prose-ul/ol pl-5            — lists indent enough to read
                //                                 distinct from surrounding prose.
                //   prose-li:my-0               — list items hug each other so
                //                                 a 6-bullet rationale doesn't
                //                                 tower over the row above.
                <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1 prose-headings:first:mt-0 prose-p:my-1 prose-p:first:mt-0 prose-p:leading-relaxed prose-strong:text-foreground prose-code:text-opensearch-blue prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-ul:my-1 prose-ul:pl-5 prose-ol:my-1 prose-ol:pl-5 prose-li:my-0 prose-li:leading-relaxed text-muted-foreground">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {result.reasoning}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="text-muted-foreground whitespace-pre-wrap">{result.reasoning}</div>
              )}
            </div>
          )}
          {result.expected !== undefined && (
            <div>
              <span className="font-semibold">expected:</span>{' '}
              <code className="bg-muted px-1 py-0.5 rounded">{formatValue(result.expected)}</code>
            </div>
          )}
          {result.actual !== undefined && (
            <div>
              <span className="font-semibold">actual:</span>{' '}
              <code className="bg-muted px-1 py-0.5 rounded">{formatValue(result.actual)}</code>
            </div>
          )}
          {/* llm-judge enriched fields — extra metrics + improvement
              strategies. Rendered inline so SDK `judge()` calls don't lose
              data the legacy auto-judge path used to surface in dedicated
              report-level cards. */}
          {judgeMetrics && Object.entries(judgeMetrics).filter(([k]) => k !== 'accuracy').length > 0 && (
            <div className="pt-2 mt-2 border-t border-muted/40 flex flex-wrap items-baseline gap-1">
              <span className="font-semibold mr-1">metrics:</span>
              {Object.entries(judgeMetrics)
                .filter(([k, v]) => k !== 'accuracy' && typeof v === 'number')
                .map(([k, v]) => (
                  <code key={k} className="bg-muted px-1 py-0.5 rounded">
                    {k}: {String(v)}
                  </code>
                ))}
            </div>
          )}
          {judgeStrategies && judgeStrategies.length > 0 && (
            <div className="pt-2 mt-2 border-t border-muted/40 space-y-1.5">
              <div className="font-semibold text-foreground">
                improvement strategies <span className="text-muted-foreground font-normal">({judgeStrategies.length})</span>
              </div>
              {judgeStrategies.map((s, i) => {
                const tone =
                  s.priority === 'high'
                    ? 'border-red-300 dark:border-red-900 bg-red-50/40 dark:bg-red-950/20'
                    : s.priority === 'medium'
                    ? 'border-yellow-300 dark:border-yellow-900 bg-yellow-50/40 dark:bg-yellow-950/20'
                    : 'border-blue-300 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20';
                return (
                  <div key={i} className={`border rounded p-2 space-y-1 ${tone}`}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs uppercase font-semibold tracking-wide">{s.priority}</span>
                      <span className="text-xs text-muted-foreground">[{s.category}]</span>
                    </div>
                    <div className="text-foreground leading-relaxed">
                      <span className="font-semibold">issue:</span> {s.issue}
                    </div>
                    <div className="text-muted-foreground leading-relaxed">
                      <span className="font-semibold text-foreground">recommendation:</span> {s.recommendation}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') {
    return v.length > 200 ? `"${v.slice(0, 200)}…"` : `"${v}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return String(v);
  }
}
