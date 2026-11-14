/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Popover — the entry point: select text → "Ask" chip → composer → the answer
 * streams in a card anchored to the selection; follow-ups stay in the same
 * card; "Open in panel" continues the same pi session in the docked panel.
 */

import React, { useEffect, useRef, useState } from 'react';
import { X, PanelRightOpen } from 'lucide-react';
import type { PendingSelection, AskThread } from './askState';
import { AskComposer, SelectionQuote, TurnView, suggestionsFor } from './AskShared';

export interface AskPopoverProps {
  anchor: PendingSelection['rect'];
  thread: AskThread;
  onAsk: (question: string) => void;
  onCancel: () => void;
  onClose: () => void;
  onOpenInPanel: () => void;
}

const WIDTH = 440;

export const AskPopover: React.FC<AskPopoverProps> = ({ anchor, thread, onAsk, onCancel, onClose, onOpenInPanel }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => place(anchor));
  useEffect(() => { setPos(place(anchor)); }, [anchor]);
  // Keep the card inside the viewport as the answer streams in and grows.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const clamp = () => {
      const h = el.getBoundingClientRect().height;
      setPos((p) => (p.top + h > window.innerHeight - 8 ? { ...p, top: Math.max(8, window.innerHeight - h - 8) } : p));
    };
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    clamp();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const busy = thread.turns.some((t) => t.status === 'streaming');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [thread.turns]);

  return (
    <div
      ref={ref}
      data-ask-ui
      data-testid="ask-popover"
      role="dialog"
      aria-label="Ask about selection"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: WIDTH, zIndex: 60 }}
      className="rounded-xl border bg-background shadow-2xl flex flex-col max-h-[70vh] animate-in fade-in zoom-in-95 duration-150"
    >
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-xs font-semibold flex items-center gap-1 min-w-0"><span aria-hidden="true">✨</span> Ask <span className="font-normal text-muted-foreground truncate max-w-[220px]">· Agent Health assistant</span></span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onOpenInPanel} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent" title="Continue this question in the assistant panel" data-testid="ask-open-in-panel">
            <PanelRightOpen size={12} /> Open in panel
          </button>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-accent" data-testid="ask-popover-close"><X size={14} /></button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {thread.selections.map((s) => <SelectionQuote key={s.text} selection={s} compact />)}
        {thread.loaded?.length ? <div className="text-[10px] text-muted-foreground" data-testid="ask-loaded">Context{thread.prepared && !thread.turns.length ? ' ready' : ''}: {thread.loaded.join(' · ')}</div> : thread.preparing ? <div className="text-[10px] text-muted-foreground" data-testid="ask-preparing">Reading the page data…</div> : null}
        {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} thread={thread} />)}
      </div>
      <div className="border-t px-3 py-2">
        <AskComposer
          autoFocus
          busy={busy}
          onSubmit={onAsk}
          onCancel={onCancel}
          placeholder={thread.turns.length ? 'Follow up…' : 'Ask about the highlighted text…'}
          suggestions={thread.turns.length ? undefined : suggestionsFor(thread.route, true)}
        />
      </div>
    </div>
  );
};

function place(anchor: PendingSelection['rect']) {
  // Prefer the free space to the RIGHT of the selection (keeps the quoted
  // text readable); otherwise below it; otherwise above.
  if (anchor.right + 12 + WIDTH < window.innerWidth) {
    return { top: Math.max(8, Math.min(anchor.top, window.innerHeight - 320)), left: anchor.right + 12 };
  }
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - WIDTH - 8);
  const below = anchor.bottom + 8;
  const top = below + 240 < window.innerHeight ? below : Math.max(8, anchor.top - 8 - 240);
  return { top, left };
}
