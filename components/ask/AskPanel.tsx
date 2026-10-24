/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docked assistant panel. Opened from the popover ("Open in panel"), the
 * sidebar "Assistant" entry, the "Want me to explain this run?" nudge or the
 * `/assistant` route. Holds one thread at a time (a pi session), collects
 * several highlights as context chips, and lists earlier threads — "This page"
 * (pi sessions asked from the current route) and "All" — each linking back to
 * its page. Resizable via the drag handle on its left edge; the width persists
 * in localStorage.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Plus, ExternalLink, History } from 'lucide-react';
import { listAskSessions, type AskSessionSummary, type AskStatus } from '@/services/client/askApi';
import { clampPanelWidth, type AskThread } from './askState';
import { AskComposer, SelectionQuote, TurnView, suggestionsFor } from './AskShared';

export interface AskPanelProps {
  route: string;
  status: AskStatus | null;
  width: number;
  onResize: (width: number) => void;
  thread: AskThread | null;
  onAsk: (question: string) => void;
  onCancel: () => void;
  onRemoveSelection: (text: string) => void;
  onNewThread: () => void;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}

type SessionsTab = 'page' | 'all';

export const LOCAL_HISTORY_NOTE = 'Local history only: these threads are pi session files on this Agent Health server (not in the shared storage cluster). Another server or laptop has its own list.';

export const AskPanel: React.FC<AskPanelProps> = ({ route, status, width, onResize, thread, onAsk, onCancel, onRemoveSelection, onNewThread, onOpenSession, onClose }) => {
  const disabled = status?.enabled === false;
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AskSessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(true);
  const [tab, setTab] = useState<SessionsTab>('page');
  const doneCount = thread?.turns.filter((t) => t.status !== 'streaming').length ?? 0;

  useEffect(() => {
    let cancelled = false;
    listAskSessions({ limit: 200 }).then((s) => { if (!cancelled) setSessions(s); }).catch(() => { /* list stays as-is */ });
    return () => { cancelled = true; };
  }, [doneCount, thread?.sessionId, route]);

  const busy = thread?.turns.some((t) => t.status === 'streaming') ?? false;
  const visible = useMemo(() => (tab === 'page' ? sessions.filter((s) => s.page.route === route) : sessions), [sessions, tab, route]);
  const grouped = useMemo(() => {
    const byRoute = new Map<string, AskSessionSummary[]>();
    for (const s of visible) {
      const list = byRoute.get(s.page.route) ?? [];
      list.push(s);
      byRoute.set(s.page.route, list);
    }
    return Array.from(byRoute.entries());
  }, [visible]);

  // --- drag-to-resize (left edge) -------------------------------------------
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = { startX: e.clientX, startWidth: width };
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    onResize(clampPanelWidth(dragging.current.startWidth + (dragging.current.startX - e.clientX)));
  }, [onResize]);
  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = null;
    (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);
  const onHandleKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onResize(width + 24);
    else if (e.key === 'ArrowRight') onResize(width - 24);
  }, [onResize, width]);

  return (
    <aside
      data-ask-ui
      data-testid="ask-panel"
      style={{ width }}
      className="fixed right-0 top-0 bottom-0 z-40 border-l bg-background flex flex-col"
      aria-label="Assistant panel"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant panel"
        aria-valuenow={width}
        tabIndex={0}
        data-testid="ask-panel-resize-handle"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onHandleKey}
        className="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize hover:bg-primary/40 focus:bg-primary/40 outline-none"
        title="Drag to resize"
      />
      <div className="flex items-center justify-between border-b px-3 py-2 gap-2">
        <span className="text-xs font-semibold flex items-center gap-1 shrink-0"><span aria-hidden="true">✨</span> Assistant</span>
        <span className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground" title={thread?.model ?? 'Built into Agent Health: pi agent loop with read-only tools over this server\'s API'}>{thread?.model ? thread.model.replace(/^amazon-bedrock\//, '') : 'Agent Health assistant · read-only'}</span>
        <button type="button" onClick={onNewThread} className="inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[11px] hover:bg-accent shrink-0" data-testid="ask-panel-new"><Plus size={12} /> New</button>
        <button type="button" onClick={() => setShowHistory((v) => !v)} className={`rounded p-1 hover:bg-accent ${showHistory ? 'bg-accent' : ''}`} aria-label="Toggle history" data-testid="ask-panel-history-toggle"><History size={14} /></button>
        <button type="button" onClick={onClose} aria-label="Close panel" className="rounded p-1 hover:bg-accent" data-testid="ask-panel-close"><X size={14} /></button>
      </div>
      <div className="flex flex-1 min-h-0">
        {showHistory ? (
          <nav className="w-[200px] shrink-0 border-r overflow-y-auto p-2 space-y-2" data-testid="ask-sessions-list" aria-label="Ask sessions">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground" title={status?.sessionsDir ? `${LOCAL_HISTORY_NOTE}\n\n${status.sessionsDir}` : LOCAL_HISTORY_NOTE} data-testid="ask-sessions-local-note">
              <span>History</span>
              <span className="normal-case tracking-normal rounded border px-1 py-px cursor-help">local only</span>
            </div>
            <div className="flex rounded border text-[10px]" role="tablist">
              {(['page', 'all'] as SessionsTab[]).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`ask-sessions-tab-${t}`} className={`flex-1 px-1 py-1 ${tab === t ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'}`}>
                  {t === 'page' ? `This page (${sessions.filter((s) => s.page.route === route).length})` : `All (${sessions.length})`}
                </button>
              ))}
            </div>
            {visible.length === 0 ? <p className="text-[11px] text-muted-foreground" data-testid="ask-sessions-empty">{tab === 'page' ? 'No questions asked on this page yet.' : 'No questions asked yet.'}</p> : null}
            {grouped.map(([r, list]) => (
              <div key={r} className="space-y-1">
                {tab === 'all' ? (
                  <button type="button" onClick={() => navigate(r)} className="w-full text-left text-[10px] text-muted-foreground hover:text-foreground truncate flex items-center gap-1" title={r}>
                    <ExternalLink size={9} className="shrink-0" /> <span className="truncate">{list[0].page.title || r}</span>
                  </button>
                ) : null}
                {list.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onOpenSession(s.id)}
                    className={`w-full text-left rounded border px-1.5 py-1 hover:bg-accent ${thread?.sessionId === s.id ? 'border-primary bg-accent/50' : ''}`}
                    data-testid="ask-session-item"
                  >
                    <div className="text-[11px] font-medium line-clamp-2">{s.firstQuestion || '(no question)'}</div>
                    <div className="text-[10px] text-muted-foreground">{s.turnCount} turn{s.turnCount === 1 ? '' : 's'} · {relTime(s.updatedAt)}</div>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        ) : null}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
            {disabled ? (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs" data-testid="ask-disabled">
                The assistant is turned off on this server (<code>assistant.enabled: false</code> in <code>agent-health.config.ts</code>).
              </div>
            ) : null}
            <div className="space-y-1" data-testid="ask-context-chips">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Context ({thread?.selections.length ?? 0})</div>
              {thread?.selections.length ? thread.selections.map((s) => (
                <SelectionQuote key={s.text} selection={s} compact onRemove={thread.turns.length ? undefined : () => onRemoveSelection(s.text)} />
              )) : <p className="text-[11px] text-muted-foreground">Highlight text anywhere on the page and click <b>Ask</b>; while a question is open here, highlights also offer <b>Add to current question</b>.</p>}
              {thread?.route && thread.route !== route ? (
                <button type="button" onClick={() => navigate(thread.route)} className="text-[10px] text-opensearch-blue hover:underline inline-flex items-center gap-1" data-testid="ask-thread-page-link"><ExternalLink size={9} /> Asked on {thread.route}</button>
              ) : null}
              {thread?.loaded?.length ? <div className="text-[10px] text-muted-foreground" data-testid="ask-loaded">Pre-loaded: {thread.loaded.join(' · ')}</div> : null}
            </div>
            {thread?.turns.map((turn) => <TurnView key={turn.id} turn={turn} thread={thread} />)}
          </div>
          <div className="border-t px-3 py-2">
            <AskComposer
              busy={busy}
              disabled={disabled}
              onSubmit={onAsk}
              onCancel={onCancel}
              placeholder={thread?.turns.length ? 'Follow up…' : thread?.selections.length ? 'Ask about the highlighted text…' : 'Ask about this page…'}
              suggestions={thread?.turns.length ? undefined : suggestionsFor(route, !!thread?.selections.length)}
              testId="ask-panel-composer"
            />
          </div>
        </div>
      </div>
    </aside>
  );
};

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
