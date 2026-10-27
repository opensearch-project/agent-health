/**
 * @jest-environment jsdom
 */
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AskPanel / AskPopover render tests (jsdom + RTL). The sessions API is
 * mocked at the client boundary; everything the user sees — history tabs and
 * grouping, "local only" note, disabled state, context chips, composer
 * placeholders, drag / keyboard resize, popover placement + Escape — is
 * asserted on the rendered DOM. Real-shaped fixtures: identical questions on
 * different pages, a session that is not on this page, relative timestamps
 * across minutes / hours / days.
 */

import * as React from 'react';
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

jest.mock('react-markdown', () => ({ __esModule: true, default: ({ children }: { children: string }) => React.createElement('div', { 'data-testid': 'md' }, children) }));
jest.mock('remark-gfm', () => () => {});
const mockList = jest.fn();
jest.mock('@/services/client/askApi', () => ({ listAskSessions: (...a: any[]) => mockList(...a) }));

import { AskPanel, LOCAL_HISTORY_NOTE } from '@/components/ask/AskPanel';
import { AskPopover } from '@/components/ask/AskPopover';
import { PANEL_MIN_WIDTH, type AskThread } from '@/components/ask/askState';

const h = React.createElement;
const Where: React.FC = () => h('div', { 'data-testid': 'where' }, useLocation().pathname + useLocation().search);
const inRouter = (ui: React.ReactElement, initial = '/evaluations/runs/r1') =>
  h(MemoryRouter, { initialEntries: [initial] }, h(Routes, null, h(Route, { path: '*', element: h(React.Fragment, null, ui, h(Where)) })));

const route = '/evaluations/runs/r1';
const status = { enabled: true, agent: { key: 'agent-health-assistant', name: 'Agent Health assistant' }, model: null, sessionsDir: '/srv/.agent-health/ask-sessions', maxConcurrent: 4, inFlight: 0, local: true } as any;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const sessions = [
  { id: 'ask-a', page: { route, title: 'Run r1' }, firstQuestion: 'Why did this fail?', turnCount: 1, updatedAt: iso(0.2), createdAt: iso(1), lastAnswerPreview: '' },
  { id: 'ask-b', page: { route, title: 'Run r1' }, firstQuestion: 'Why did this fail?', turnCount: 3, updatedAt: iso(5), createdAt: iso(9), lastAnswerPreview: '' },
  { id: 'ask-c', page: { route: '/compare/b?runs=x,y', title: 'Compare' }, firstQuestion: 'Why did this fail?', turnCount: 2, updatedAt: iso(3 * 60), createdAt: iso(200), lastAnswerPreview: '' },
  { id: 'ask-d', page: { route: '/evaluations/test-cases/t9' }, firstQuestion: '', turnCount: 1, updatedAt: iso(5 * 24 * 60), createdAt: iso(5 * 24 * 60), lastAnswerPreview: '' },
];

const props = () => ({
  route, status, width: 560,
  onResize: jest.fn(), onAsk: jest.fn(), onCancel: jest.fn(), onRemoveSelection: jest.fn(), onNewThread: jest.fn(), onOpenSession: jest.fn(), onClose: jest.fn(),
  thread: null as AskThread | null,
});

beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(NOW); mockList.mockResolvedValue(sessions); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); mockList.mockReset(); });

describe('AskPanel — history list', () => {
  it('"This page" lists only this route\'s sessions (identical questions kept apart), "All" groups by page with links back; relative times; opens a session', async () => {
    const p = props();
    render(inRouter(h(AskPanel, p)));
    await waitFor(() => expect(screen.getByTestId('ask-sessions-tab-all').textContent).toBe('All (4)'));
    expect(mockList).toHaveBeenCalledWith({ limit: 200 });

    const list = screen.getByTestId('ask-sessions-list');
    expect(screen.getByTestId('ask-sessions-tab-page').textContent).toBe('This page (2)');
    expect(screen.getByTestId('ask-sessions-tab-all').textContent).toBe('All (4)');
    let items = within(list).getAllByTestId('ask-session-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Why did this fail?');
    expect(items[0].textContent).toContain('1 turn · just now');
    expect(items[1].textContent).toContain('3 turns · 5m ago');
    expect(list.querySelectorAll('[title="/compare/b?runs=x,y"]')).toHaveLength(0);
    expect(screen.getByTestId('ask-sessions-local-note').getAttribute('title')).toBe(`${LOCAL_HISTORY_NOTE}\n\n/srv/.agent-health/ask-sessions`);

    fireEvent.click(screen.getByTestId('ask-sessions-tab-all'));
    items = within(list).getAllByTestId('ask-session-item');
    expect(items).toHaveLength(4);
    expect(items[2].textContent).toContain('2 turns · 3h ago');
    expect(items[3].textContent).toContain('(no question)');
    expect(items[3].textContent).toContain('1 turn · 5d ago');
    // page headers link back to the page (title when known, else the route)
    expect(screen.getByText('Compare')).toBeTruthy();
    fireEvent.click(screen.getByText('/evaluations/test-cases/t9'));
    expect(screen.getByTestId('where').textContent).toBe('/evaluations/test-cases/t9');

    fireEvent.click(items[1]);
    expect(p.onOpenSession).toHaveBeenCalledWith('ask-b');
  });

  it('empty states per tab; history toggle hides the list; New / Close call back; a failed list keeps the panel usable', async () => {
    mockList.mockRejectedValueOnce(new Error('offline'));
    const p = props();
    render(inRouter(h(AskPanel, p)));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.getByTestId('ask-sessions-empty').textContent).toBe('No questions asked on this page yet.');
    fireEvent.click(screen.getByTestId('ask-sessions-tab-all'));
    expect(screen.getByTestId('ask-sessions-empty').textContent).toBe('No questions asked yet.');
    fireEvent.click(screen.getByTestId('ask-panel-history-toggle'));
    expect(screen.queryByTestId('ask-sessions-list')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-panel-history-toggle'));
    expect(screen.getByTestId('ask-sessions-list')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ask-panel-new'));
    expect(p.onNewThread).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('ask-panel-close'));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    // without a sessionsDir the note is just the sentence
    cleanup();
    render(inRouter(h(AskPanel, { ...props(), status: { ...status, sessionsDir: undefined } })));
    await waitFor(() => expect(screen.getByTestId('ask-sessions-tab-all').textContent).toBe('All (4)'));
    expect(screen.getByTestId('ask-sessions-local-note').getAttribute('title')).toBe(LOCAL_HISTORY_NOTE);
  });
});

describe('AskPanel — thread, context chips, composer, disabled', () => {
  it('no thread: hint text, page-level placeholder and suggestions; model label defaults', async () => {
    render(inRouter(h(AskPanel, props())));
    await waitFor(() => expect(screen.getByTestId('ask-sessions-tab-all').textContent).toBe('All (4)'));
    expect(screen.getByTestId('ask-context-chips').textContent).toContain('Context (0)');
    expect(screen.getByTestId('ask-context-chips').textContent).toContain('Add to current question');
    expect((screen.getByTestId('ask-panel-composer-input') as HTMLTextAreaElement).placeholder).toBe('Ask about this page…');
    expect(screen.getAllByTestId('ask-suggestion')[0].textContent).toMatch(/Why did this run fail/);
    expect(screen.getByText('Agent Health assistant · read-only')).toBeTruthy();
  });

  it('a thread with selections: removable chips before the first turn, pre-loaded refs, page link when asked elsewhere, model label; after a turn chips are fixed and the composer follows up', async () => {
    const p = props();
    const thread: AskThread = {
      id: 't1', sessionId: 'ask-b', route: '/compare/b?runs=x,y', createdAt: 0, model: 'amazon-bedrock/claude-x',
      selections: [{ text: 'cell A' }, { text: 'cell B' }], turns: [], loaded: ['report', 'run'],
    };
    const { rerender } = render(inRouter(h(AskPanel, { ...p, thread })));
    await waitFor(() => expect(screen.getByTestId('ask-sessions-tab-all').textContent).toBe('All (4)'));
    expect(screen.getByTestId('ask-context-chips').textContent).toContain('Context (2)');
    expect(screen.getByTestId('ask-loaded').textContent).toBe('Pre-loaded: report · run');
    expect(screen.getByText('claude-x')).toBeTruthy();
    expect((screen.getByTestId('ask-panel-composer-input') as HTMLTextAreaElement).placeholder).toBe('Ask about the highlighted text…');
    fireEvent.click(screen.getByTestId('ask-thread-page-link'));
    expect(screen.getByTestId('where').textContent).toBe('/compare/b?runs=x,y');
    const removes = screen.getAllByLabelText('Remove selection');
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[1]);
    expect(p.onRemoveSelection).toHaveBeenCalledWith('cell B');
    // the current session is highlighted in the list
    const current = screen.getAllByTestId('ask-session-item').filter((el) => el.className.includes('border-primary'));
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('3 turns'); // ask-b, not its identically-worded sibling ask-a

    const answered: AskThread = { ...thread, turns: [{ id: 'u1', question: 'Which regressed?', answer: 'Case 3.', status: 'done', tools: [], startedAt: 0 }] };
    rerender(inRouter(h(AskPanel, { ...p, thread: answered })));
    expect(screen.queryAllByLabelText('Remove selection')).toHaveLength(0);
    expect((screen.getByTestId('ask-panel-composer-input') as HTMLTextAreaElement).placeholder).toBe('Follow up…');
    expect(screen.queryAllByTestId('ask-suggestion')).toHaveLength(0);
    expect(screen.getByTestId('ask-turn-answer').textContent).toContain('Case 3.');
    fireEvent.change(screen.getByTestId('ask-panel-composer-input'), { target: { value: 'and why?' } });
    fireEvent.keyDown(screen.getByTestId('ask-panel-composer-input'), { key: 'Enter' });
    expect(p.onAsk).toHaveBeenCalledWith('and why?');

    const streaming: AskThread = { ...answered, turns: [...answered.turns, { id: 'u2', question: 'and why?', answer: '', status: 'streaming', tools: [], startedAt: 0 }] };
    rerender(inRouter(h(AskPanel, { ...p, thread: streaming })));
    fireEvent.click(screen.getByTestId('ask-panel-composer-cancel'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('assistant.enabled: false → explanation and a disabled composer', async () => {
    render(inRouter(h(AskPanel, { ...props(), status: { ...status, enabled: false } })));
    await waitFor(() => expect(screen.getByTestId('ask-sessions-tab-all').textContent).toBe('All (4)'));
    expect(screen.getByTestId('ask-disabled').textContent).toContain('assistant.enabled: false');
    expect((screen.getByTestId('ask-panel-composer-input') as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe('AskPanel — resize handle', () => {
  it('drag from the left edge resizes (clamped to the minimum), pointer capture is released, keyboard arrows step by 24px', async () => {
    const p = props();
    render(inRouter(h(AskPanel, p)));
    await waitFor(() => expect(screen.getByTestId('ask-sessions-tab-all').textContent).toBe('All (4)'));
    const handle = screen.getByTestId('ask-panel-resize-handle');
    expect(handle.getAttribute('aria-valuenow')).toBe('560');
    expect((screen.getByTestId('ask-panel') as HTMLElement).style.width).toBe('560px');
    const setCapture = jest.fn(); const releaseCapture = jest.fn();
    (handle as any).setPointerCapture = setCapture; (handle as any).releasePointerCapture = releaseCapture;

    const pointer = (type: string, init: { clientX?: number; pointerId?: number }) => {
      // jsdom has no PointerEvent: a MouseEvent carrying pointerId is what React's onPointer* handlers receive.
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0 });
      Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
      act(() => { handle.dispatchEvent(ev); });
    };
    pointer('pointermove', { clientX: 100 }); // no drag in progress → ignored
    expect(p.onResize).not.toHaveBeenCalled();
    pointer('pointerdown', { clientX: 800, pointerId: 7 });
    expect(setCapture).toHaveBeenCalledWith(7);
    expect(document.body.style.cursor).toBe('col-resize');
    pointer('pointermove', { clientX: 600 }); // 200px to the left → wider
    expect(p.onResize).toHaveBeenLastCalledWith(760);
    pointer('pointermove', { clientX: 1800 }); // far right → clamped at the minimum
    expect(p.onResize).toHaveBeenLastCalledWith(PANEL_MIN_WIDTH);
    pointer('pointerup', { pointerId: 7 });
    expect(releaseCapture).toHaveBeenCalledWith(7);
    expect(document.body.style.cursor).toBe('');
    pointer('pointercancel', { pointerId: 7 }); // after the drag ended → no-op
    expect(releaseCapture).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(p.onResize).toHaveBeenLastCalledWith(584);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(p.onResize).toHaveBeenLastCalledWith(536);
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(p.onResize).toHaveBeenCalledTimes(4);
  });
});

describe('AskPopover', () => {
  let observed: Element[] = [];
  let roCallback: (() => void) | null = null;
  beforeEach(() => {
    observed = [];
    (window as any).HTMLElement.prototype.scrollTo = function () { /* jsdom has no layout */ };
    (window as any).ResizeObserver = class { constructor(cb: () => void) { roCallback = cb; } observe(el: Element) { observed.push(el); } disconnect() { observed = []; } };
  });
  afterEach(() => { delete (window as any).ResizeObserver; });
  const thread: AskThread = { id: 't', route: '/evaluations/benchmarks/b/runs/r/inspect?reportId=x', selections: [{ text: 'judge said no' }], turns: [], createdAt: 0, preparing: true };
  const setViewport = (w: number, hgt: number) => { Object.defineProperty(window, 'innerWidth', { value: w, configurable: true }); Object.defineProperty(window, 'innerHeight', { value: hgt, configurable: true }); };

  it('is placed to the right of the selection when there is room, otherwise below (or above near the bottom), clamped inside the viewport', () => {
    setViewport(1400, 900);
    const p = { thread, onAsk: jest.fn(), onCancel: jest.fn(), onClose: jest.fn(), onOpenInPanel: jest.fn() };
    const { rerender } = render(inRouter(h(AskPopover, { ...p, anchor: { top: 100, left: 100, right: 300, bottom: 120, width: 200, height: 20 } })));
    const pop = screen.getByTestId('ask-popover') as HTMLElement;
    expect(pop.style.left).toBe('312px');
    expect(pop.style.top).toBe('100px');
    // not enough room on the right → below the selection, left clamped to the viewport
    rerender(inRouter(h(AskPopover, { ...p, anchor: { top: 100, left: 1200, right: 1300, bottom: 120, width: 100, height: 20 } })));
    expect(pop.style.top).toBe('128px');
    expect(pop.style.left).toBe(`${1400 - 440 - 8}px`);
    // near the bottom → above the selection
    rerender(inRouter(h(AskPopover, { ...p, anchor: { top: 800, left: 1200, right: 1300, bottom: 820, width: 100, height: 20 } })));
    expect(pop.style.top).toBe(`${800 - 8 - 240}px`);
    // a selection high on a short viewport stays at least 8px from the top
    rerender(inRouter(h(AskPopover, { ...p, anchor: { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 } })));
    expect(pop.style.top).toBe('8px');
    // as the answer streams in and the card grows past the bottom edge it is pushed up
    expect(observed).toContain(pop);
    rerender(inRouter(h(AskPopover, { ...p, anchor: { top: 700, left: 100, right: 300, bottom: 720, width: 200, height: 20 } })));
    expect(pop.style.top).toBe('580px'); // min(anchor.top, innerHeight - 320)
    jest.spyOn(pop, 'getBoundingClientRect').mockReturnValue({ height: 600 } as DOMRect);
    act(() => { roCallback?.(); });
    expect(pop.style.top).toBe(`${900 - 600 - 8}px`);
  });

  it('shows the quote and "Reading the page data…" while preparing, then the loaded refs; Escape closes; Open in panel; follow-up placeholder once answered', () => {
    setViewport(1400, 900);
    const p = { thread, onAsk: jest.fn(), onCancel: jest.fn(), onClose: jest.fn(), onOpenInPanel: jest.fn() };
    const anchor = { top: 100, left: 100, right: 300, bottom: 120, width: 200, height: 20 };
    const { rerender } = render(inRouter(h(AskPopover, { ...p, anchor })));
    expect(screen.getByTestId('ask-popover').textContent).toContain('judge said no');
    expect(screen.getByTestId('ask-preparing')).toBeTruthy();
    expect((screen.getByTestId('ask-composer-input') as HTMLTextAreaElement).placeholder).toBe('Ask about the highlighted text…');
    expect(screen.getAllByTestId('ask-suggestion')[0].textContent).toMatch(/Why did this case fail/);

    rerender(inRouter(h(AskPopover, { ...p, anchor, thread: { ...thread, preparing: false, prepared: true, loaded: ['report', 'test case'] } })));
    expect(screen.getByTestId('ask-loaded').textContent).toBe('Context ready: report · test case');

    const answered = { ...thread, preparing: false, prepared: true, loaded: ['report'], turns: [{ id: 'u', question: 'Why?', answer: 'Because.', status: 'done' as const, tools: [], startedAt: 0 }] };
    rerender(inRouter(h(AskPopover, { ...p, anchor, thread: answered })));
    expect(screen.getByTestId('ask-loaded').textContent).toBe('Context: report');
    expect((screen.getByTestId('ask-composer-input') as HTMLTextAreaElement).placeholder).toBe('Follow up…');
    expect(screen.getByTestId('ask-turn-answer').textContent).toContain('Because.');

    fireEvent.click(screen.getByTestId('ask-open-in-panel'));
    expect(p.onOpenInPanel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('ask-popover-close'));
    expect(p.onClose).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByTestId('ask-composer-input'), { target: { value: 'more?' } });
    fireEvent.keyDown(screen.getByTestId('ask-composer-input'), { key: 'Enter' });
    expect(p.onAsk).toHaveBeenCalledWith('more?');
  });
});
