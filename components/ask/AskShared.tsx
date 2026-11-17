/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate } from 'react-router-dom';
import { Loader2, Wrench, Send, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AskSelection } from '@/services/client/askApi';
import type { AskThread, AskTurnState } from './askState';

/** Markdown with PATH links routed through react-router (external links open normally). */
export const AskMarkdown: React.FC<{ children: string; className?: string }> = ({ children, className }) => {
  const navigate = useNavigate();
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-li:my-0 prose-ul:my-1 prose-ol:my-1 prose-headings:text-sm prose-headings:mt-2 prose-headings:mb-1 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-pre:text-xs prose-pre:p-2 prose-a:text-opensearch-blue', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Model output never loads remote resources (tracking pixels via ![](url)).
          img: () => null,
          a: ({ href, children: kids }) => {
            const internal = !!href && href.startsWith('/') && !href.startsWith('//');
            return (
              <a
                href={href}
                target={internal ? undefined : '_blank'}
                rel={internal ? undefined : 'noreferrer'}
                onClick={(e) => { if (internal) { e.preventDefault(); navigate(href!); } }}
              >
                {kids}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
};

export const SelectionQuote: React.FC<{ selection: AskSelection; onRemove?: () => void; compact?: boolean }> = ({ selection, onRemove, compact }) => (
  <div className="group relative rounded border-l-2 border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-1 text-xs text-foreground/90" data-testid="ask-selection-quote">
    <span className={cn('whitespace-pre-wrap break-words', compact ? 'line-clamp-2' : 'line-clamp-6')}>{selection.text}</span>
    {onRemove ? (
      <button type="button" aria-label="Remove selection" onClick={onRemove} className="absolute right-1 top-1 hidden group-hover:inline-flex rounded p-0.5 hover:bg-accent">
        <X size={12} />
      </button>
    ) : null}
  </div>
);

export const ToolActivity: React.FC<{ turn: AskTurnState }> = ({ turn }) => {
  if (!turn.tools.length) return null;
  const names = Array.from(new Set(turn.tools.map((t) => t.name)));
  const running = turn.tools.filter((t) => t.status === 'start').length;
  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="ask-tool-activity">
      <Wrench size={11} />
      <span>{running > 0 && turn.status === 'streaming' ? 'Looking up ' : 'Looked up via '}{names.join(', ')}</span>
    </div>
  );
};

export const TurnMeta: React.FC<{ turn: AskTurnState; thread?: AskThread }> = ({ turn, thread }) => {
  if (turn.status !== 'done') return null;
  const parts: string[] = [];
  if (turn.firstTokenMs !== undefined) parts.push(`first token ${(turn.firstTokenMs / 1000).toFixed(1)}s`);
  if (turn.durationMs !== undefined) parts.push(`total ${(turn.durationMs / 1000).toFixed(1)}s`);
  if (thread?.model) parts.push(thread.model.replace(/^amazon-bedrock\//, ''));
  return <div className="text-[10px] text-muted-foreground/80" data-testid="ask-turn-meta">{parts.join(' · ')}</div>;
};

export const TurnView: React.FC<{ turn: AskTurnState; thread?: AskThread }> = ({ turn, thread }) => (
  <div className="space-y-1" data-testid="ask-turn" data-status={turn.status}>
    <div className="text-xs font-medium text-foreground/90" data-testid="ask-turn-question">{turn.question}</div>
    <ToolActivity turn={turn} />
    {turn.answer ? (
      <div data-testid="ask-turn-answer"><AskMarkdown>{turn.answer}</AskMarkdown></div>
    ) : turn.status === 'streaming' ? (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="ask-turn-waiting">
        <Loader2 size={12} className="animate-spin" /> {thread?.prepared || thread?.sessionId ? 'Thinking…' : 'Reading the page data…'}
      </div>
    ) : null}
    {turn.status === 'error' ? (
      // Shown UNDER whatever streamed before the failure: a partial answer is context, not a success.
      <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-testid="ask-turn-error">{turn.error}</div>
    ) : null}
    {turn.status === 'streaming' && turn.answer ? <Loader2 size={12} className="animate-spin text-muted-foreground" /> : null}
    <TurnMeta turn={turn} thread={thread} />
  </div>
);

export const AskComposer: React.FC<{
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onSubmit: (question: string) => void;
  onCancel?: () => void;
  suggestions?: string[];
  testId?: string;
}> = ({ placeholder = 'Ask about the highlighted text…', autoFocus, disabled, busy, onSubmit, onCancel, suggestions, testId = 'ask-composer' }) => {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const submit = () => {
    const q = value.trim();
    if (!q || disabled || busy) return;
    onSubmit(q);
    setValue('');
  };
  return (
    <div className="space-y-1" data-testid={testId}>
      {suggestions?.length && !value ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <button key={s} type="button" className="rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent" onClick={() => { if (!busy) onSubmit(s); }} data-testid="ask-suggestion">
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-1">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring min-h-[32px] max-h-[96px]"
          data-testid={`${testId}-input`}
        />
        {busy && onCancel ? (
          <button type="button" onClick={onCancel} className="h-8 rounded-md border px-2 text-xs hover:bg-accent" data-testid={`${testId}-cancel`}>Stop</button>
        ) : (
          <button type="button" onClick={submit} disabled={disabled || !value.trim()} className="h-8 w-8 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40" aria-label="Ask" data-testid={`${testId}-send`}>
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Floating chip(s) anchored to the selection rect. "Ask" always starts a new
 * question about the selection; "Add to current question" appears ONLY while
 * a thread is open in the panel and appends the selection to it.
 */
export const AskChip: React.FC<{
  rect: { top: number; left: number; bottom: number; width: number };
  onAsk: () => void;
  onAddToCurrent?: () => void;
}> = ({ rect, onAsk, onAddToCurrent }) => {
  const top = Math.max(8, rect.top - 34);
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - 28), window.innerWidth - (onAddToCurrent ? 260 : 120));
  const base = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs shadow-lg hover:opacity-90';
  return (
    <div data-ask-ui data-testid="ask-chip-group" style={{ position: 'fixed', top, left, zIndex: 60 }} className="flex items-center gap-1 animate-in fade-in zoom-in-95 duration-150">
      <button type="button" data-testid="ask-chip" className={`${base} bg-foreground text-background`} onMouseDown={(e) => e.preventDefault()} onClick={onAsk}>
        <span aria-hidden="true">✨</span> Ask
      </button>
      {onAddToCurrent ? (
        <button type="button" data-testid="ask-chip-add" className={`${base} border bg-background text-foreground`} onMouseDown={(e) => e.preventDefault()} onClick={onAddToCurrent} title="Attach this highlight to the question open in the assistant panel">
          + Add to current question
        </button>
      ) : null}
    </div>
  );
};

export function suggestionsFor(route: string, hasSelection: boolean): string[] {
  if (/\/compare\//.test(route)) return ['Which runs regressed and why?', 'Which cases flipped between these runs?'];
  if (/\/inspect|\/runs\//.test(route)) return hasSelection ? ['Why did this case fail?', 'What does this mean?', 'What should the agent have done?'] : ['Why did this run fail?', 'Summarize this run'];
  if (/agent-traces|trace/.test(route)) return ['What does this span do?', 'Where did the time go?'];
  if (/test-cases/.test(route)) return ['Is this test case well specified?', 'How has this case performed over time?'];
  return hasSelection ? ['Explain this', 'Why?'] : ['What am I looking at?'];
}
