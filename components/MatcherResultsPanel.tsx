/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MatcherResultsPanel — collapsible per-matcher breakdown for runs that
 * captured matcher verdicts (code-assertion / llm-judge / traces).
 *
 * Code-assertion / traces rows are compact one-liners:
 *   ✓ description                         [method badge]   meta
 *   ✗ description                         [method badge]   expected … actual …
 *
 * LLM-judge rows answer the only two questions that matter, immediately:
 *   WHY did it fail — ranked causes distilled from the verdict (structured
 *     `judgeExtraFields` when the judge emitted them, else a conservative
 *     parse of the reasoning prose), plus a per-required-fact checklist.
 *   HOW to fix it — the judge's own `improvementStrategies`, promoted from
 *     the bottom of the row to a first-class panel.
 *
 * The verbatim reasoning stays available — once — under a collapsible
 * "Full judge reasoning" (it used to render twice: the write path mirrored
 * `reasoning` into `errorMessage` and both were shown).
 *
 * `notReached` entries (a synthetic runner-appended marker for matcher
 * calls that never executed because an earlier assertion threw — see
 * appendNotReachedMarker in services/evaluation/index.ts) render as a
 * distinct muted row and are excluded from both the passed and failed
 * header counts; they get their own "N not reached" tally instead.
 */

import React, { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, ChevronDown, ChevronRight, Brain, Code2, Activity, Wrench, ArrowRight, MinusCircle } from 'lucide-react';
import { Markdown, hasRealMarkdown } from '@/components/ui/markdown';
import type { MatcherResult, MatcherMethod } from '@/lib/matchers/types';
import {
  parseFactVerdicts,
  parseSourceMismatch,
  shortId,
  type ParsedFactVerdict,
  type FactVerdictKind,
} from '@/lib/matchers/judgeReasoningParse';
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

  // `notReached` entries are a synthetic runner-appended marker (see
  // appendNotReachedMarker in services/evaluation/index.ts) for matcher
  // calls that never executed because an earlier assertion threw —
  // distinct from both "passed" and "failed", so they're excluded from
  // both counts and get their own tally in the header.
  const reached = results.filter(r => !r.notReached);
  const notReachedCount = results.length - reached.length;
  const passed = reached.filter(r => r.pass).length;
  const failed = reached.length - passed;

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
        Matchers
        <span className="text-xs font-normal text-muted-foreground">
          ({passed}/{reached.length} passed{failed > 0 ? `, ${failed} failed` : ''}{notReachedCount > 0 ? `, ${notReachedCount} not reached` : ''})
        </span>
      </h3>
      <div className="border rounded-lg divide-y bg-card">
        {results.map((r, idx) =>
          r.method === 'llm-judge' && !r.notReached ? (
            <JudgeRow key={`${idx}-${r.description}`} result={r} />
          ) : (
            <MatcherRow key={`${idx}-${r.description}`} result={r} />
          )
        )}
      </div>
    </div>
  );
};

// ─── shared row chrome ──────────────────────────────────────────────────────

interface RowProps {
  result: MatcherResult;
}

const PassIcon: React.FC<{ pass: boolean; notReached?: boolean }> = ({ pass, notReached }) =>
  notReached ? (
    <MinusCircle size={14} className="text-muted-foreground" />
  ) : pass ? (
    <CheckCircle2 size={14} className="text-green-600" />
  ) : (
    <XCircle size={14} className="text-red-600" />
  );

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

// ─── code-assertion / traces / evaluator rows (unchanged behaviour) ────────

const MatcherRow: React.FC<RowProps> = ({ result }) => {
  const hasDetail =
    !!result.errorMessage ||
    !!result.reasoning ||
    !!result.model ||
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
          <PassIcon pass={result.pass} notReached={result.notReached} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm ${result.notReached ? 'text-muted-foreground italic' : result.pass ? '' : 'text-red-600 dark:text-red-400 font-medium'}`}>
              {result.description || '(matcher)'}
            </span>
            {result.notReached && (
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground shrink-0">
                not reached
              </span>
            )}
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
          {result.reasoning && result.reasoning !== result.errorMessage && (
            <div className="text-muted-foreground whitespace-pre-wrap">{result.reasoning}</div>
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

// ─── llm-judge rows: WHY / FIX first ────────────────────────────────────────

/** Structured facts from judgeExtraFields (prompt-v2 judges), when present. */
interface StructuredFact {
  fact: string;
  verdict: FactVerdictKind;
  rationale?: string;
}

function structuredFacts(extra: Record<string, unknown> | undefined): StructuredFact[] {
  const raw = extra?.facts;
  if (!Array.isArray(raw)) return [];
  const out: StructuredFact[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const fact = (f as any).fact;
    const verdict = (f as any).verdict;
    if (typeof fact !== 'string' || !fact.trim()) continue;
    const kind: FactVerdictKind =
      verdict === 'stated' || verdict === 'partial' || verdict === 'missing' || verdict === 'contradicted'
        ? verdict
        : 'partial';
    const rationale = typeof (f as any).rationale === 'string' ? (f as any).rationale : undefined;
    out.push({ fact, verdict: kind, ...(rationale ? { rationale } : {}) });
  }
  return out;
}

/** Structured failure causes from judgeExtraFields, when present. */
function structuredCauses(extra: Record<string, unknown> | undefined): Array<{ cause: string; detail?: string }> {
  const raw = extra?.failure_causes;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ cause: string; detail?: string }> = [];
  for (const c of raw) {
    if (typeof c === 'string' && c.trim()) {
      out.push({ cause: c.trim() });
    } else if (c && typeof c === 'object' && typeof (c as any).cause === 'string') {
      out.push({
        cause: (c as any).cause,
        ...(typeof (c as any).detail === 'string' ? { detail: (c as any).detail } : {}),
      });
    }
  }
  return out;
}

const FACT_CHIP: Record<FactVerdictKind, { label: string; cls: string }> = {
  stated: { label: 'STATED', cls: 'bg-green-50 text-green-700 border-green-300 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/40' },
  partial: { label: 'PARTIAL', cls: 'bg-yellow-50 text-yellow-700 border-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/40' },
  missing: { label: 'MISSING', cls: 'bg-red-50 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/40' },
  contradicted: { label: 'CONTRADICTED', cls: 'bg-red-50 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/40' },
};

const PRIORITY_CLS: Record<string, string> = {
  high: 'bg-red-50 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/40',
  medium: 'bg-yellow-50 text-yellow-700 border-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/40',
  low: 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/40',
};

const JudgeRow: React.FC<RowProps> = ({ result }) => {
  const [open, setOpen] = useState(!result.pass);
  const meta = METHOD_META['llm-judge'];

  const strategies = result.improvementStrategies ?? [];
  const dims = useMemo(
    () =>
      Object.entries(result.judgeMetrics ?? {}).filter(
        ([k, v]) => k !== 'accuracy' && typeof v === 'number'
      ) as Array<[string, number]>,
    [result.judgeMetrics]
  );

  // Headline score: hide the fabricated-zero bug signature — a persisted
  // score of exactly 0 alongside NON-ZERO dimension metrics is inconsistent
  // (the weighted overall of non-zero dims can't be 0) and means the write
  // path defaulted a missing `accuracy` to 0 (pre-fix data). A genuine
  // total failure (all dims 0) stays visible as score 0%.
  const showScore =
    typeof result.score === 'number' &&
    !(result.score === 0 && dims.some(([, v]) => v > 0));

  // Structured fields win; prose-parse is the fallback annotation.
  const extra = result.judgeExtraFields;
  const sFacts = useMemo(() => structuredFacts(extra), [extra]);
  const sCauses = useMemo(() => structuredCauses(extra), [extra]);
  const pFacts = useMemo(
    () => (sFacts.length > 0 ? [] : parseFactVerdicts(result.reasoning)),
    [sFacts.length, result.reasoning]
  );
  const facts: Array<{ fact: string; verdict: FactVerdictKind; note?: string }> =
    sFacts.length > 0
      ? sFacts.map(f => ({ fact: f.fact, verdict: f.verdict, note: f.rationale }))
      : pFacts.map((f: ParsedFactVerdict) => ({ fact: f.fact, verdict: f.verdict, note: f.note }));
  const mismatch = useMemo(() => parseSourceMismatch(result.reasoning), [result.reasoning]);

  // WHY bullets: structured causes verbatim, else composed from what we
  // could extract (source mismatch, failing facts). May be empty — then the
  // reasoning collapsible is the only "why" and gets opened by default.
  const whyBullets: Array<{ head: string; sub?: string }> = useMemo(() => {
    if (sCauses.length > 0) return sCauses.map(c => ({ head: c.cause, sub: c.detail }));
    const out: Array<{ head: string; sub?: string }> = [];
    if (mismatch) {
      out.push({
        head: 'Wrong source cited',
        sub: `Answer built from ${shortId(mismatch.cited)} instead of the expected ${shortId(mismatch.expected)}.`,
      });
    }
    const bad = facts.filter(f => f.verdict !== 'stated');
    if (bad.length > 0) {
      const counts = ['partial', 'missing', 'contradicted']
        .map(k => [k, bad.filter(f => f.verdict === k).length] as const)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(' · ');
      out.push({
        head: `Required facts not fully stated (${counts})`,
        sub: 'See the fact-by-fact checklist below.',
      });
    }
    return out;
  }, [sCauses, mismatch, facts]);

  const errorDistinct =
    !!result.errorMessage && result.errorMessage !== result.reasoning;

  const failed = !result.pass;
  const hasReasoning = !!result.reasoning;

  return (
    <div className="px-3 py-2 border-l-2 border-l-purple-400/50 dark:border-l-purple-500/40">
      {/* header — scannable without expanding */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(o => !o);
          }
        }}
        className="flex items-start gap-2 cursor-pointer"
      >
        <div className="pt-0.5 shrink-0">
          <PassIcon pass={result.pass} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm ${result.pass ? '' : 'text-red-600 dark:text-red-400 font-medium'}`}>
              {result.description || '(judge)'}
            </span>
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 inline-flex items-center gap-1 ${meta.cls}`}>
              {meta.icon}
              {meta.label}
            </Badge>
            {result.role === 'observe' && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 text-muted-foreground">
                observe
              </Badge>
            )}
            {showScore && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                score {((result.score as number) * 100).toFixed(0)}%
              </span>
            )}
            {/* per-dimension mini chips — the verdict is scannable from the header */}
            {dims.map(([k, v]) => (
              <code
                key={k}
                className={`text-[10px] px-1.5 py-0 rounded border shrink-0 ${
                  failed && v < 70
                    ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30'
                    : 'bg-muted text-muted-foreground border-transparent'
                }`}
                title={k}
              >
                {k.replace(/_/g, ' ')} {v}
              </code>
            ))}
            {typeof result.durationMs === 'number' && result.durationMs > 0 && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {(result.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        </div>
        <div className="pt-0.5 shrink-0 text-muted-foreground">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>

      {open && (
        <div className="mt-2 pl-6 space-y-2 text-xs">
          {errorDistinct && (
            <div className="text-red-600 dark:text-red-400">
              <span className="font-semibold">error:</span> {result.errorMessage}
            </div>
          )}

          {/* WHY / FIX — the two questions, side by side */}
          {failed && (whyBullets.length > 0 || strategies.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-start">
              {whyBullets.length > 0 && (
                <div className="border border-red-200 dark:border-red-500/30 bg-red-50/40 dark:bg-red-950/20 rounded-md p-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400 mb-1.5">
                    Why it failed
                  </div>
                  <ol className="list-decimal ml-4 space-y-1.5">
                    {whyBullets.map((b, i) => (
                      <li key={i} className="text-foreground">
                        <span className="font-medium">{b.head}</span>
                        {b.sub && <div className="text-muted-foreground">{b.sub}</div>}
                      </li>
                    ))}
                  </ol>
                  {sCauses.length === 0 && whyBullets.length > 0 && (
                    <div className="mt-1.5 text-[10px] text-muted-foreground/70">
                      derived from judge reasoning — see verbatim text below
                    </div>
                  )}
                </div>
              )}
              {strategies.length > 0 && (
                <div className="border border-green-300 dark:border-green-500/30 bg-green-50/40 dark:bg-green-950/20 rounded-md p-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-green-700 dark:text-green-400 mb-1.5">
                    How to fix it
                  </div>
                  <div className="space-y-1.5">
                    {strategies.map((s, i) => (
                      <div key={i} className="flex items-baseline gap-1.5">
                        <Badge variant="outline" className={`text-[9px] px-1 py-0 shrink-0 uppercase ${PRIORITY_CLS[s.priority] ?? PRIORITY_CLS.low}`}>
                          {s.priority}
                        </Badge>
                        <div className="min-w-0">
                          <span className="font-medium text-foreground">{s.issue}</span>
                          <div className="text-muted-foreground flex items-baseline gap-1">
                            <ArrowRight size={10} className="shrink-0 translate-y-0.5" />
                            <span>{s.recommendation}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Required-facts checklist */}
          {facts.length > 0 && (
            <div className="border rounded-md divide-y bg-card/50">
              {facts.map((f, i) => (
                <div key={i} className="flex items-baseline gap-2 px-2 py-1.5">
                  <Badge variant="outline" className={`text-[9px] px-1 py-0 shrink-0 ${FACT_CHIP[f.verdict].cls}`}>
                    {FACT_CHIP[f.verdict].label}
                  </Badge>
                  <div className="min-w-0">
                    <span className="text-foreground">“{f.fact}”</span>
                    {f.note && <span className="text-muted-foreground"> — {f.note}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Passed-judge suggestions (observe/gate) — still useful, kept light */}
          {!failed && strategies.length > 0 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground select-none">
                {strategies.length} suggestion{strategies.length > 1 ? 's' : ''} from the judge
              </summary>
              <div className="mt-1.5 space-y-1.5">
                {strategies.map((s, i) => (
                  <div key={i} className="flex items-baseline gap-1.5">
                    <Badge variant="outline" className={`text-[9px] px-1 py-0 shrink-0 uppercase ${PRIORITY_CLS[s.priority] ?? PRIORITY_CLS.low}`}>
                      {s.priority}
                    </Badge>
                    <div className="min-w-0 text-muted-foreground">
                      <span className="font-medium text-foreground">{s.issue}</span> — {s.recommendation}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Verbatim reasoning — SINGLE copy, collapsed unless it's all we have */}
          {hasReasoning && (
            <details open={failed && whyBullets.length === 0 && facts.length === 0}>
              <summary className="cursor-pointer text-muted-foreground select-none">
                Full judge reasoning
              </summary>
              <div className="mt-1.5">
                {hasRealMarkdown(result.reasoning!) ? (
                  <Markdown className="text-muted-foreground">{result.reasoning!}</Markdown>
                ) : (
                  <div className="text-muted-foreground whitespace-pre-wrap">{result.reasoning}</div>
                )}
              </div>
            </details>
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
