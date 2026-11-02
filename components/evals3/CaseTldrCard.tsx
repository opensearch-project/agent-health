/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CaseTldrCard — the 3-sentence TL;DR shown above the Test Case Definition
 * in the run inspector: what the test asked → what the agent did → the
 * judgement and its main reason.
 *
 * Hybrid: ASKED and AGENT are computed here, instantly, from the report and
 * test case (lib/caseSummary.ts). The VERDICT label is computed too; only
 * its REASON is model-written — fetched lazily from
 * `POST /api/storage/runs/:id/summary` (cached on the report, regenerated
 * when the judgement changes). While that request is in flight the verdict
 * row shows the deterministic sentence greyed as "writing…"; the page is
 * never blocked. When the model is unavailable the deterministic verdict
 * stays, with an honest note. Unjudged runs never call the model.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw, AlertTriangle, ListChecks } from 'lucide-react';
import type { EvaluationReport, CaseSummary, TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';
import { fetchCaseSummary } from '@/services/client/caseSummaryApi';
import { buildCaseSummary, hasVerdictToExplain } from '@/lib/caseSummary';
import type { ResultStatus } from './ResultStatus';

interface CaseTldrCardProps {
  report: EvaluationReport;
  testCase: TestCase | null;
  status: ResultStatus;
  className?: string;
}

type CardState =
  | { kind: 'loading'; key: string }
  | { kind: 'ready'; key: string; summary: CaseSummary; cached: boolean }
  | { kind: 'error'; key: string; message: string };

/**
 * Everything on the report that, if it changes, must refetch the summary.
 * The SERVER decides freshness via its inputs hash; this key only makes the
 * client ask again when the judgement visibly changed (Retry judgement
 * reloads the report with a new `judgementRetriedAt`) and tags each state
 * with the report it belongs to, so a report switch never shows the previous
 * report's text for a frame.
 */
function judgementKey(report: EvaluationReport): string {
  return [
    report.id,
    report.judgementRetriedAt ?? '',
    report.judgementRetryCount ?? '',
    report.passFailStatus ?? '',
    report.metricsStatus ?? '',
    report.failureStage ?? '',
    report.score ?? '',
    (report.llmJudgeReasoning ?? '').length,
    report.matcherResults?.length ?? '',
    report.trajectory?.length ?? '',
  ].join('|');
}

/** Client-side ceiling for the reason request (server deadline is 20 s + 10 s grace). */
const CLIENT_TIMEOUT_MS = 45_000;

function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  // "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5"
  const m = model.match(/claude-[a-z]+-\d+(?:-\d+)?/i) || model.match(/[^./:]+(?=[-:]\d{8})/);
  return m ? m[0] : model.split('/').pop();
}

export const CaseTldrCard: React.FC<CaseTldrCardProps> = ({ report, testCase, status, className }) => {
  const key = judgementKey(report);
  // Deterministic sentences — available on first paint, no request needed.
  const det = buildCaseSummary(report, testCase);
  const needsModel = hasVerdictToExplain(report);
  const [stored, setStored] = useState<CardState>({ kind: 'loading', key });
  // A state tagged with another report's key is never rendered — show the
  // skeleton until this report's own request settles.
  const state: CardState = stored.key === key ? stored : { kind: 'loading', key };
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // The server gives up at its own deadline (~30 s); never leave the row
      // "writing…" forever if the request itself stalls.
      const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
      setStored({ kind: 'loading', key });
      try {
        const res = await fetchCaseSummary(report.id, { force, signal: controller.signal });
        if (controller.signal.aborted) return;
        setStored({ kind: 'ready', key, summary: res.summary, cached: res.cached });
      } catch (err: unknown) {
        if (controller.signal.aborted && abortRef.current !== controller) return; // superseded by a newer request / unmount
        const timedOut = controller.signal.aborted;
        const message = timedOut ? `no answer within ${CLIENT_TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message : 'Summary request failed';
        setStored({ kind: 'error', key, message });
      } finally {
        clearTimeout(timer);
      }
    },
    // `key` folds in every judgement field we care about; report.id is part of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  useEffect(() => {
    if (!needsModel) return; // unjudged: the verdict sentence is complete without a model
    void load(false);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, needsModel]);

  const verdictTone =
    status === 'passed'
      ? 'text-green-700 dark:text-green-400'
      : status === 'failed'
        ? 'text-red-700 dark:text-red-400'
        : status === 'errored'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-foreground';

  // What the verdict row shows: the model-written reason once it arrived,
  // else the deterministic sentence (greyed while the model is still writing).
  const verdictText = state.kind === 'ready' ? state.summary.parts.verdict : det.verdict;
  const writing = needsModel && state.kind === 'loading';
  const modelOk = state.kind === 'ready' && state.summary.source === 'llm';
  const modelUnavailable = (state.kind === 'ready' && state.summary.source === 'fallback' && !!state.summary.error) || state.kind === 'error';
  const unavailableReason = state.kind === 'error' ? state.message : state.kind === 'ready' ? state.summary.error : undefined;

  return (
    <div
      className={`border-b bg-card/60 shrink-0 px-4 py-2.5 ${className || ''}`}
      data-testid="case-tldr"
      data-state={needsModel ? state.kind : 'ready'}
      data-source={!needsModel ? 'deterministic' : state.kind === 'ready' ? state.summary.source : undefined}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">TL;DR</span>
        {modelOk && state.kind === 'ready' && (
          <Badge
            variant="secondary"
            className="text-[9px] px-1.5 py-0 gap-1 shrink-0"
            title={`The verdict is computed from the report; its reason was written by ${state.summary.model || 'the summary model'} · ${new Date(state.summary.generatedAt).toLocaleString()}`}
            data-testid="case-tldr-source"
          >
            <Sparkles size={9} /> AI reason{shortModel(state.summary.model) ? ` · ${shortModel(state.summary.model)}` : ''}
          </Badge>
        )}
        {modelUnavailable && (
          <Badge
            variant="secondary"
            className="text-[9px] px-1.5 py-0 gap-1 shrink-0 bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30"
            title={unavailableReason ? `AI reason unavailable: ${unavailableReason}` : 'AI reason unavailable'}
            data-testid="case-tldr-source"
          >
            <ListChecks size={9} /> Field summary
          </Badge>
        )}
        <div className="flex-1" />
        {needsModel && !writing && (
          <button
            type="button"
            onClick={() => void load(true)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Regenerate the verdict reason"
            aria-label="Regenerate summary"
            data-testid="case-tldr-regenerate"
          >
            <RefreshCw size={11} />
          </button>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] leading-snug" data-testid="case-tldr-body">
        <dt className="text-muted-foreground font-medium">Asked</dt>
        <dd data-testid="case-tldr-asked">{det.asked}</dd>
        <dt className="text-muted-foreground font-medium">Agent</dt>
        <dd data-testid="case-tldr-agent">{det.agent}</dd>
        <dt className="text-muted-foreground font-medium">Verdict</dt>
        <dd
          className={`font-medium ${writing ? 'text-muted-foreground' : verdictTone}`}
          data-testid="case-tldr-verdict"
          data-writing={writing ? 'true' : undefined}
        >
          {verdictText}
          {writing && (
            <span className="ml-2 text-[10px] font-normal italic text-muted-foreground" data-testid="case-tldr-skeleton" role="status" aria-label="Writing the verdict reason">
              writing the reason…
            </span>
          )}
        </dd>
        {modelUnavailable && (
          <dd className="col-span-2 text-[10px] text-muted-foreground italic" data-testid="case-tldr-fallback-note">
            AI reason unavailable{unavailableReason ? ` (${unavailableReason})` : ''} — showing the field-based reason.
          </dd>
        )}
      </dl>
    </div>
  );
};
