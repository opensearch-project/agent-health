/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AskSurface — mounts the Agent Health assistant on every page.
 *
 * One combined mode, no URL flag: highlight text → "Ask" chip → popover
 * anchored to the selection (the entry point). "Open in panel" continues the
 * same pi session in the docked, resizable panel, which also lists earlier
 * sessions ("This page" / "All"). While a thread is open in the panel, a new
 * highlight ALSO offers "Add to current question".
 *
 * Wraps the page content so the open panel reserves space on the right.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getAskSession } from '@/services/client/askApi';
import { onOpenAskPanel, useAskStatus, useAskThreads, usePersistedPanelWidth, useTextSelection } from './askState';
import { AskChip } from './AskShared';
import { AskPopover } from './AskPopover';
import { AskPanel } from './AskPanel';

export const AskSurface: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const route = location.pathname + location.search;
  const status = useAskStatus();
  const enabled = status?.enabled !== false;
  const [pending, clearPending] = useTextSelection();
  const { threads, createThread, prepare, addSelection, removeSelection, importSession, ask, cancel } = useAskThreads();
  const [panelWidth, setPanelWidth] = usePersistedPanelWidth();

  const [popover, setPopover] = useState<{ threadId: string; anchor: NonNullable<typeof pending>['rect'] } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelThreadId, setPanelThreadId] = useState<string | null>(null);

  // Leaving the page closes the popover (its anchor is gone); the panel persists.
  useEffect(() => { setPopover(null); }, [location.pathname]);

  // Sidebar "Assistant", the nudge and /assistant open the panel.
  useEffect(() => onOpenAskPanel(({ question }) => {
    setPanelOpen(true);
    if (question) {
      let id = panelThreadId && threads[panelThreadId] && threads[panelThreadId].turns.length === 0 ? panelThreadId : null;
      if (!id) { id = createThread(route, []).id; setPanelThreadId(id); }
      ask(id, question);
    }
  }), [panelThreadId, threads, route, createThread, ask]);

  const panelThread = panelThreadId ? threads[panelThreadId] ?? null : null;

  const startAsk = useCallback(() => {
    if (!pending) return;
    const sel = { text: pending.text, nearbyText: pending.nearbyText };
    // prepare: build the snapshot + pi session now, while the user types.
    const t = createThread(route, [sel], { prepare: true });
    setPopover({ threadId: t.id, anchor: pending.rect });
    clearPending();
    document.getSelection()?.removeAllRanges();
  }, [pending, route, createThread, clearPending]);

  const addToCurrent = useCallback(() => {
    if (!pending || !panelThread) return;
    addSelection(panelThread.id, { text: pending.text, nearbyText: pending.nearbyText });
    setPanelOpen(true);
    clearPending();
    document.getSelection()?.removeAllRanges();
  }, [pending, panelThread, addSelection, clearPending]);

  const openInPanel = useCallback(() => {
    if (!popover) return;
    setPanelThreadId(popover.threadId);
    setPopover(null);
    setPanelOpen(true);
  }, [popover]);

  const openSession = useCallback(async (sessionId: string) => {
    const existing = Object.values(threads).find((t) => t.sessionId === sessionId);
    const t = existing ?? (await getAskSession(sessionId).then((s) => (s ? importSession(s) : null)));
    if (!t) return;
    setPanelThreadId(t.id);
    setPanelOpen(true);
  }, [threads, importSession]);

  const reserve = panelOpen ? panelWidth : 0;
  const canAddToCurrent = panelOpen && !!panelThread && !panelThread.turns.some((t) => t.status === 'streaming');

  return (
    <>
      {/*
       * The wrapper must stay a flex-column item of `SidebarInset` (`flex flex-col`):
       * pages size their own scroll containers with `h-full` / `flex-1 min-h-0`
       * (benchmark cases list, runs table, compare grid). A plain block div here
       * gives them no height to fill, every windowed list grows to its full length
       * and the "load more" sentinels are always in view.
       */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        style={reserve ? { paddingRight: reserve } : undefined}
        data-testid="ask-surface"
        data-ask-panel-open={panelOpen || undefined}
      >
        {children}
      </div>

      {enabled && pending && !popover ? (
        <AskChip rect={pending.rect} onAsk={startAsk} onAddToCurrent={canAddToCurrent ? addToCurrent : undefined} />
      ) : null}

      {enabled && popover && threads[popover.threadId] ? (
        <AskPopover
          anchor={popover.anchor}
          thread={threads[popover.threadId]}
          onAsk={(q) => ask(popover.threadId, q)}
          onCancel={() => cancel(popover.threadId)}
          onClose={() => setPopover(null)}
          onOpenInPanel={openInPanel}
        />
      ) : null}

      {panelOpen ? (
        <AskPanel
          route={route}
          status={status}
          width={panelWidth}
          onResize={setPanelWidth}
          thread={panelThread}
          onAsk={(q) => {
            let id = panelThreadId;
            if (!id || !threads[id]) { id = createThread(route, []).id; setPanelThreadId(id); }
            ask(id, q);
          }}
          onCancel={() => panelThreadId && cancel(panelThreadId)}
          onRemoveSelection={(text) => panelThreadId && removeSelection(panelThreadId, text)}
          onNewThread={() => { const t = createThread(route, []); setPanelThreadId(t.id); prepare(t.id); }}
          onOpenSession={openSession}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
    </>
  );
};

/** `/assistant` deep link: open the panel on the overview page. */
export const AskOpenRedirect: React.FC = () => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/', { replace: true });
    setTimeout(() => window.dispatchEvent(new CustomEvent('agent-health:ask-open', { detail: {} })), 0);
  }, [navigate]);
  return null;
};
