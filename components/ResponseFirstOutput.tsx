/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ResponseFirstOutput — the Test Case Output tab, Agent Response first.
 *
 * Owner feedback: "show the response first, and a collapsible for all other
 * messages later; all the text should be Markdown." So:
 *
 *   1. AGENT RESPONSE — the final `response` (else last `assistant`) step,
 *      always expanded, rendered as Markdown (code/JSON fences become real
 *      blocks) with a Rendered / Raw toggle that shows the exact string.
 *   2. STEPS — every trajectory step (tool calls, results, thinking, the
 *      answer itself in sequence) inside one collapsible, closed by default,
 *      rendered by the existing TrajectoryView (which renders step text as
 *      Markdown).
 *
 * No answer (agent error, empty trajectory) → an explicit "no answer" line;
 * the stage-aware failure card above this component says why.
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquareText } from 'lucide-react';
import type { TrajectoryStep } from '@/types';
import { Markdown } from '@/components/ui/markdown';
import { TrajectoryView } from '@/components/TrajectoryView';

interface Props {
  steps: TrajectoryStep[];
  /** Start with the steps list open (tests / deep links). Default closed. */
  defaultStepsOpen?: boolean;
}

/** The agent's final answer step: last `response`, else last `assistant` with text. */
export function findFinalAnswerStep(steps: TrajectoryStep[] | undefined): TrajectoryStep | undefined {
  const list = Array.isArray(steps) ? steps : [];
  for (const wanted of ['response', 'assistant'] as const) {
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s?.type === wanted && typeof s.content === 'string' && s.content.trim()) return s;
    }
  }
  return undefined;
}

/** Answers above this size start in Raw (a huge Markdown tree is slow to lay out); the toggle still works. */
export const RENDER_MARKDOWN_MAX_CHARS = 60_000;

export const ResponseFirstOutput: React.FC<Props> = ({ steps, defaultStepsOpen = false }) => {
  const answer = useMemo(() => findFinalAnswerStep(steps), [steps]);
  const [raw, setRaw] = useState(() => (answer?.content.length ?? 0) > RENDER_MARKDOWN_MAX_CHARS);
  const [stepsOpen, setStepsOpen] = useState(defaultStepsOpen);
  const total = Array.isArray(steps) ? steps.length : 0;

  return (
    <div className="space-y-4" data-testid="response-first-output">
      <section data-testid="final-answer" data-has-answer={answer ? 'true' : 'false'}>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <MessageSquareText size={14} className="text-muted-foreground" /> Agent Response
            {answer && (
              <span className="text-xs font-normal text-muted-foreground">
                {answer.content.length.toLocaleString()} chars · final {answer.type} step
              </span>
            )}
          </h4>
          {answer && (
            <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5" role="group" aria-label="Agent Response view">
              <button
                type="button"
                onClick={() => setRaw(false)}
                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${!raw ? 'bg-opensearch-blue text-white' : 'text-muted-foreground hover:text-foreground'}`}
                data-testid="answer-view-rendered"
                aria-pressed={!raw}
              >
                Rendered
              </button>
              <button
                type="button"
                onClick={() => setRaw(true)}
                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${raw ? 'bg-opensearch-blue text-white' : 'text-muted-foreground hover:text-foreground'}`}
                data-testid="answer-view-raw"
                aria-pressed={raw}
              >
                Raw
              </button>
            </div>
          )}
        </div>
        {answer ? (
          <div className="rounded-md border bg-card p-4" data-testid="final-answer-body" data-view={raw ? 'raw' : 'rendered'}>
            {raw ? (
              <pre className="text-xs font-mono whitespace-pre-wrap break-words">{answer.content}</pre>
            ) : (
              <Markdown className="text-sm">{answer.content}</Markdown>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="final-answer-none">
            No agent response — the agent produced no response step{total ? ` (${total} other step${total === 1 ? '' : 's'} below)` : ''}.
          </div>
        )}
      </section>

      <section>
        <button
          type="button"
          onClick={() => setStepsOpen(o => !o)}
          className="w-full flex items-center gap-2 text-left text-sm font-semibold py-1.5 hover:text-foreground"
          aria-expanded={stepsOpen}
          data-testid="steps-toggle"
        >
          {stepsOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
          Steps
          <span className="text-xs font-normal text-muted-foreground">
            {total} step{total === 1 ? '' : 's'} — tool calls, results, thinking and the response, in order
          </span>
        </button>
        {stepsOpen && (
          <div className="mt-2" data-testid="steps-body">
            <TrajectoryView steps={steps} loading={false} />
          </div>
        )}
      </section>
    </div>
  );
};

export default ResponseFirstOutput;
