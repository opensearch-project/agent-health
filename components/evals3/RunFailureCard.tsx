/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunFailureCard — the prominent "what actually went wrong" card at the top
 * of the run-detail Test Case Output tab for a report whose run FAILED at a
 * stage (agent request / judge / trace) rather than producing a verdict.
 *
 * Owner incident: 5 of 62 cases showed an EMPTY Test Case Output tab and an
 * amber "evaluator could not run" — the truth was that the agent's HTTP
 * request had timed out after 5 minutes and there was nothing to judge.
 * This card names the stage, shows the unwrapped cause, the endpoint, how
 * long we waited and the timeout that was in force (agent stage), or the
 * judge's raw reply + attempt count (judge stage), and tells the user what
 * the remedy is (re-run the case vs. retry judgement).
 *
 * Works for reports persisted BEFORE `failureStage` existed via the
 * `traceError` / legacy-reasoning fallbacks in lib/reportFailure.ts.
 */

import React, { useState } from 'react';
import { AlertCircle, PlugZap, Scale, Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { EvaluationReport } from '@/types';
import {
  getFailureStage,
  getFailureCause,
  agentProducedNoOutput,
  describeAgentErrorKind,
  formatMs,
} from '@/lib/reportFailure';

export interface RunFailureCardProps {
  report: EvaluationReport;
  className?: string;
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground shrink-0 w-24">{label}</span>
      <span className={`break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export const RunFailureCard: React.FC<RunFailureCardProps> = ({ report, className }) => {
  const stage = getFailureStage(report);
  const [rawOpen, setRawOpen] = useState(false);
  if (!stage) return null;

  const cause = getFailureCause(report);

  if (stage === 'agent') {
    const ae = report.agentError;
    const noOutput = agentProducedNoOutput(report);
    return (
      <Card
        className={`bg-orange-50 dark:bg-orange-500/10 border-orange-300 dark:border-orange-500/40 ${className ?? ''}`}
        data-testid="run-failure-card"
        data-stage="agent"
      >
        <CardContent className="p-4 flex items-start gap-3">
          <PlugZap className="text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" size={20} />
          <div className="flex-1 min-w-0 space-y-2">
            <div>
              <div className="text-sm font-semibold text-orange-700 dark:text-orange-300">
                Agent request failed — {describeAgentErrorKind(ae?.kind).toLowerCase().replace(/^agent request failed$/, 'no response')}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {noOutput
                  ? 'The agent produced no output, so this case was not judged. Re-run the case to retry the agent.'
                  : 'The agent request failed part-way; partial output is shown below but no verdict was produced.'}
              </div>
            </div>
            <div className="text-xs font-mono whitespace-pre-wrap break-words bg-background/60 rounded border border-orange-200 dark:border-orange-500/30 p-2" data-testid="run-failure-cause">
              {cause || 'agent request produced no output (cause not recorded)'}
            </div>
            <div className="space-y-1">
              <Field label="Endpoint" value={ae?.endpoint ?? report.agentEndpoint} mono />
              <Field label="Waited" value={formatMs(ae?.elapsedMs ?? report.performanceMetrics?.agentDurationMs)} />
              <Field
                label="Timeout"
                value={ae?.timeoutMs !== undefined
                  ? `${formatMs(ae.timeoutMs)} (connectorConfig.timeoutMs)`
                  : (ae?.kind === 'timeout' ? 'default 5 min (set connectorConfig.timeoutMs to change)' : undefined)}
              />
              {ae?.httpStatus !== undefined && <Field label="HTTP status" value={String(ae.httpStatus)} mono />}
              <Field label="Connector" value={report.connectorProtocol} mono />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (stage === 'judge') {
    const je = report.judgeError;
    const raw = je?.rawResponse ?? report.llmJudgeResponse?.rawResponse;
    const rawIsEmpty = raw !== undefined && raw.trim().length === 0;
    return (
      <Card
        className={`bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/40 ${className ?? ''}`}
        data-testid="run-failure-card"
        data-stage="judge"
      >
        <CardContent className="p-4 flex items-start gap-3">
          <Scale className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" size={20} />
          <div className="flex-1 min-w-0 space-y-2">
            <div>
              <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">Judge could not produce a verdict</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                The agent completed{Array.isArray(report.trajectory) && report.trajectory.length > 0 ? ` (${report.trajectory.length} steps below)` : ''}, but the evaluator failed to score it.
                Use <span className="font-medium">Retry judgement</span> on the run to re-score it without re-running the agent.
              </div>
            </div>
            <div className="text-xs font-mono whitespace-pre-wrap break-words bg-background/60 rounded border border-amber-200 dark:border-amber-500/30 p-2" data-testid="run-failure-cause">
              {cause || 'judge failed (cause not recorded)'}
            </div>
            <div className="space-y-1">
              {je?.attempts !== undefined && <Field label="Attempts" value={String(je.attempts)} />}
              <Field label="Judge model" value={report.judgeModelId} mono />
              <Field label="Evaluator" value={report.evaluatorId} mono />
            </div>
            {raw !== undefined && (
              <div>
                <button
                  type="button"
                  className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-1 hover:underline"
                  onClick={() => setRawOpen(o => !o)}
                  data-testid="run-failure-raw-toggle"
                >
                  {rawOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {rawIsEmpty ? 'Judge raw response: model returned an empty response' : 'Show judge raw response'}
                </button>
                {rawOpen && !rawIsEmpty && (
                  <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-words bg-background/60 rounded border border-amber-200 dark:border-amber-500/30 p-2 max-h-64 overflow-auto" data-testid="run-failure-raw">
                    {raw}
                  </pre>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // trace
  return (
    <Card
      className={`bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/40 ${className ?? ''}`}
      data-testid="run-failure-card"
      data-stage="trace"
    >
      <CardContent className="p-4 flex items-start gap-3">
        <Activity className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" size={20} />
        <div className="flex-1 min-w-0 space-y-2">
          <div>
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">Trace pipeline failed</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              The agent ran, but its traces never arrived or could not be assembled, so the trace-based judge did not run.
              <span className="font-medium"> Retry judgement</span> re-fetches traces and re-scores without re-running the agent.
            </div>
          </div>
          <div className="text-xs font-mono whitespace-pre-wrap break-words bg-background/60 rounded border border-amber-200 dark:border-amber-500/30 p-2" data-testid="run-failure-cause">
            {cause || (report.traceError ?? 'trace error (cause not recorded)')}
          </div>
          <div className="space-y-1">
            {report.traceFetchAttempts !== undefined && <Field label="Poll attempts" value={String(report.traceFetchAttempts)} />}
            <Field label="Run ID" value={report.runId} mono />
            <Field label="Trace ID" value={report.traceId} mono />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

/** Small inline icon for headers. */
export const RunFailureIcon: React.FC<{ report: EvaluationReport; size?: number }> = ({ report, size = 14 }) => {
  const stage = getFailureStage(report);
  if (!stage) return null;
  return stage === 'agent'
    ? <PlugZap size={size} className="text-orange-500" />
    : <AlertCircle size={size} className="text-amber-500" />;
};
