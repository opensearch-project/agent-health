/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CaseTldrCard — the 3-sentence TL;DR shown above the Test Case Definition
 * in the run inspector: what the test asked → what the agent did → the
 * judgement and its main reason.
 *
 * All three sentences are deterministic (lib/caseSummary.ts), computed here
 * from the report and test case: the VERDICT row always carries the report's
 * own label and the judge's first sentence or the failing check's own
 * `errorMessage`. Nothing on this card calls a model when a page is viewed
 * (#618). A model-written summary is a SEPARATE, labelled row the user asks
 * for with the Summarize button (`POST /api/storage/runs/:id/summary`,
 * cached on the report); a summary already persisted on the report is shown
 * from the report itself, with no request. Deterministic-only runs (code
 * checks, no LLM judge) and unjudged runs offer no Summarize at all — their
 * deterministic sentences are the whole answer.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import type { EvaluationReport, CaseSummary, TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';
import { fetchCaseSummary } from '@/services/client/caseSummaryApi';
import { buildCaseSummary, canRequestModelSummary, modelReasonOf, usableCachedSummary } from '@/lib/caseSummary';
import type { ResultStatus } from './ResultStatus';

interface CaseTldrCardProps {
  report: EvaluationReport;
  testCase: TestCase | null;
  status: ResultStatus;
  className?: string;
}

type CardState =
  | { kind: 'idle'; key: string }
  | { kind: 'loading'; key: string }
  | { kind: 'ready'; key: string; summary: CaseSummary; cached: boolean }
  | { kind: 'error'; key: string; message: string };

/**
 * Everything on the report that, if it changes, resets the card's request
 * state: a report switch never shows the previous report's text for a frame,
 * and a changed judgement (Retry judgement reloads the report with a new
 * `judgementRetriedAt`) drops a summary fetched for the old one.
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

/** Client-side ceiling for the summary request (server deadline is 20 s + 10 s grace). */
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
  const summarizable = canRequestModelSummary(report);
  // A summary persisted on the report is shown as-is: no request, no model.
  const persisted = summarizable ? usableCachedSummary(report, det) : undefined;
  const initial = (): CardState => (persisted ? { kind: 'ready', key, summary: persisted, cached: true } : { kind: 'idle', key });
  const [stored, setStored] = useState<CardState>(initial);
  // A state tagged with another report's key is never rendered: a report
  // switch starts again from what THAT report carries.
  const state: CardState = stored.key === key ? stored : initial();
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // The server gives up at its own deadline (~30 s); never leave the row
      // "summarizing…" forever if the request itself stalls.
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

  // Nothing is requested on mount or on report change — only Summarize /
  // Regenerate call `load`. Leaving the card cancels an in-flight request.
  useEffect(() => () => abortRef.current?.abort(), []);

  const verdictTone =
    status === 'passed'
      ? 'text-green-700 dark:text-green-400'
      : status === 'failed'
        ? 'text-red-700 dark:text-red-400'
        : status === 'errored'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-foreground';

  const writing = state.kind === 'loading';
  const modelSummary = state.kind === 'ready' && state.summary.source === 'llm' ? state.summary : undefined;
  const modelUnavailable = (state.kind === 'ready' && state.summary.source === 'fallback') || state.kind === 'error';
  const unavailableReason = state.kind === 'error' ? state.message : state.kind === 'ready' ? state.summary.error : undefined;
  const modelId = modelSummary?.model || 'the summary model';

  return (
    <div
      className={`border-b bg-card/60 shrink-0 px-4 py-2.5 ${className || ''}`}
      data-testid="case-tldr"
      data-state={state.kind}
      data-source={modelSummary ? 'llm' : 'deterministic'}
      data-summarizable={summarizable ? 'true' : 'false'}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">TL;DR</span>
        {modelSummary && (
          <Badge
            variant="secondary"
            className="text-[9px] px-1.5 py-0 gap-1 shrink-0 bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30"
            title={`Model-generated summary by ${modelId} · ${new Date(modelSummary.generatedAt).toLocaleString()} — not the judge's verdict`}
            data-testid="case-tldr-source"
          >
            <Sparkles size={9} /> Model summary{shortModel(modelSummary.model) ? ` · ${shortModel(modelSummary.model)}` : ''}
          </Badge>
        )}
        <div className="flex-1" />
        {summarizable && writing && (
          <span className="inline-flex items-center gap-1 text-[10px] italic text-muted-foreground" role="status" aria-label="Summarizing" data-testid="case-tldr-skeleton">
            <Loader2 size={11} className="animate-spin" /> summarizing…
          </span>
        )}
        {summarizable && !writing && modelSummary && (
          <button
            type="button"
            onClick={() => void load(true)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={`Ask ${modelId} again (one model call)`}
            aria-label="Regenerate summary"
            data-testid="case-tldr-regenerate"
          >
            <RefreshCw size={11} />
          </button>
        )}
        {summarizable && !writing && !modelSummary && (
          <button
            type="button"
            onClick={() => void load(false)}
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Ask the summary model to explain the verdict in one sentence — makes one model call (Bedrock), billed to the server's account. Nothing is sent until you click."
            data-testid="case-tldr-summarize"
          >
            <Sparkles size={10} /> {modelUnavailable ? 'Retry summary' : 'Summarize'}
          </button>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] leading-snug" data-testid="case-tldr-body">
        <dt className="text-muted-foreground font-medium">Asked</dt>
        <dd data-testid="case-tldr-asked">{det.asked}</dd>
        <dt className="text-muted-foreground font-medium">Agent</dt>
        <dd data-testid="case-tldr-agent">{det.agent}</dd>
        <dt className="text-muted-foreground font-medium">Verdict</dt>
        <dd className={`font-medium ${verdictTone}`} data-testid="case-tldr-verdict">
          {det.verdict}
        </dd>
        {modelSummary && (
          <>
            <dt className="text-violet-700 dark:text-violet-300 font-medium inline-flex items-center gap-1" data-testid="case-tldr-model-label">
              <Sparkles size={10} /> AI summary
            </dt>
            <dd className="border-l-2 border-violet-300 dark:border-violet-500/40 pl-2" data-testid="case-tldr-model-summary">
              <span className="italic">{modelReasonOf(modelSummary)}</span>
              <div className="mt-0.5 text-[10px] text-muted-foreground" data-testid="case-tldr-model-attribution">
                Model-generated summary by <code className="font-mono">{modelSummary.model || 'unknown model'}</code>
                {' · '}{new Date(modelSummary.generatedAt).toLocaleString()}
                {state.kind === 'ready' && state.cached ? ' · cached' : ''} — not the judge's verdict.
              </div>
            </dd>
          </>
        )}
        {modelUnavailable && (
          <dd className="col-span-2 text-[10px] text-muted-foreground italic" data-testid="case-tldr-fallback-note">
            Model summary unavailable{unavailableReason ? ` (${unavailableReason})` : ''} — the verdict above is from the report's own fields.
          </dd>
        )}
      </dl>
    </div>
  );
};
