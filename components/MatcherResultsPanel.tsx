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
  const hasDetail =
    !!result.errorMessage ||
    !!result.reasoning ||
    !!result.model ||
    !!result.description ||
    result.actual !== undefined ||
    result.expected !== undefined;
  const [open, setOpen] = useState(!result.pass && hasDetail);
  const meta = METHOD_META[result.method] ?? METHOD_META['code-assertion'];

  return (
    <div className="px-3 py-2">
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
        <div className="mt-2 pl-6 space-y-1 text-xs">
          {result.description && (
            <div>
              <span className="font-semibold">description:</span>{' '}
              <span className="text-muted-foreground whitespace-pre-wrap break-words">
                {result.description}
              </span>
            </div>
          )}
          {result.errorMessage && (
            <div className="text-red-600 dark:text-red-400">
              <span className="font-semibold">error:</span> {result.errorMessage}
            </div>
          )}
          {result.reasoning && (
            <div className="text-muted-foreground whitespace-pre-wrap">
              <span className="font-semibold text-foreground">reasoning:</span> {result.reasoning}
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
          {result.model && (
            <div className="text-muted-foreground">
              <span className="font-semibold text-foreground">model:</span>{' '}
              <code className="bg-muted px-1 py-0.5 rounded">{result.model}</code>
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
