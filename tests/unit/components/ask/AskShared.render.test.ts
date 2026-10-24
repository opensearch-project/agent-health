/**
 * @jest-environment jsdom
 */
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// react-markdown is ESM-only; this stand-in renders paragraphs, **bold**,
// [text](href) and ![alt](src) through the SAME `components` overrides the
// real renderer would call, so AskMarkdown's link/img handling is exercised.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children, components }: { children: string; components?: any }) => {
    const parts: React.ReactNode[] = [];
    const re = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
    let last = 0; let m: RegExpExecArray | null; let i = 0;
    while ((m = re.exec(children))) {
      parts.push(children.slice(last, m.index));
      if (m[1] !== undefined) parts.push(components?.img ? React.createElement(components.img, { key: i++, src: m[2], alt: m[1] }) : React.createElement('img', { key: i++, src: m[2] }));
      else if (m[3] !== undefined) parts.push(React.createElement(components?.a ?? 'a', { key: i++, href: m[4] }, m[3]));
      else parts.push(React.createElement('strong', { key: i++ }, m[5]));
      last = m.index + m[0].length;
    }
    parts.push(children.slice(last));
    return React.createElement('div', { 'data-testid': 'md' }, ...parts);
  },
}));
jest.mock('remark-gfm', () => () => {});

import { AskChip, AskComposer, TurnView, AskMarkdown, suggestionsFor } from '@/components/ask/AskShared';
import type { AskThread, AskTurnState } from '@/components/ask/askState';

const h = React.createElement;
const rect = { top: 100, left: 100, bottom: 120, right: 300, width: 200, height: 20 };
afterEach(cleanup);

describe('AskChip', () => {
  it('always offers Ask; "Add to current question" only when a handler is given', () => {
    const onAsk = jest.fn();
    const { rerender } = render(h(AskChip, { rect, onAsk }));
    expect(screen.getByTestId('ask-chip').textContent).toContain('Ask');
    expect(screen.queryByTestId('ask-chip-add')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-chip'));
    expect(onAsk).toHaveBeenCalledTimes(1);
    const onAdd = jest.fn();
    rerender(h(AskChip, { rect, onAsk, onAddToCurrent: onAdd }));
    expect(screen.getByTestId('ask-chip-add').textContent).toContain('Add to current question');
    fireEvent.click(screen.getByTestId('ask-chip-add'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe('AskComposer', () => {
  it('submits on Enter (not Shift+Enter), clears, offers suggestions, shows Stop while busy, honours disabled', () => {
    const onSubmit = jest.fn();
    const onCancel = jest.fn();
    const { rerender } = render(h(AskComposer, { onSubmit, onCancel, suggestions: ['Why did this case fail?'] }));
    fireEvent.click(screen.getByTestId('ask-suggestion'));
    expect(onSubmit).toHaveBeenCalledWith('Why did this case fail?');
    const input = screen.getByTestId('ask-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenLastCalledWith('line one');
    expect(input.value).toBe('');
    rerender(h(AskComposer, { onSubmit, onCancel, busy: true }));
    fireEvent.click(screen.getByTestId('ask-composer-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(h(AskComposer, { onSubmit, disabled: true }));
    expect((screen.getByTestId('ask-composer-input') as HTMLTextAreaElement).disabled).toBe(true);
  });
});

const thread: AskThread = { id: 't', route: '/x', selections: [], turns: [], createdAt: 0, model: 'amazon-bedrock/some-model', prepared: true };
const inRouter = (ui: React.ReactElement) => h(MemoryRouter, null, ui);

describe('TurnView', () => {
  const base: AskTurnState = { id: 'turn', question: 'Why?', answer: '', status: 'streaming', tools: [], startedAt: 0 };

  it('waiting → streaming → done with tool activity and timings; error state', () => {
    const { rerender } = render(inRouter(h(TurnView, { turn: base, thread })));
    expect(screen.getByTestId('ask-turn-waiting').textContent).toContain('Thinking');
    rerender(inRouter(h(TurnView, { turn: { ...base, tools: [{ name: 'query_spans', status: 'start' }], answer: 'The span' }, thread })));
    expect(screen.getByTestId('ask-tool-activity').textContent).toContain('Looking up query_spans');
    expect(screen.getByTestId('ask-turn-answer').textContent).toContain('The span');
    rerender(inRouter(h(TurnView, { turn: { ...base, status: 'done', answer: 'The **span** waits.', tools: [{ name: 'query_spans', status: 'end' }], firstTokenMs: 1234, durationMs: 5678 }, thread })));
    expect(screen.getByTestId('ask-tool-activity').textContent).toContain('Looked up via query_spans');
    expect(screen.getByTestId('ask-turn-meta').textContent).toBe('first token 1.2s · total 5.7s · some-model');
    expect(screen.getByTestId('ask-turn-answer').querySelector('strong')?.textContent).toBe('span');
    rerender(inRouter(h(TurnView, { turn: { ...base, status: 'error', error: 'Cancelled' }, thread })));
    expect(screen.getByTestId('ask-turn-error').textContent).toContain('Cancelled');
    expect(screen.queryByTestId('ask-turn-answer')).toBeNull();
    expect(screen.queryByTestId('ask-turn-waiting')).toBeNull();
    // a model call that died mid-answer: what streamed stays visible, the error sits under it (not a success, not blank)
    rerender(inRouter(h(TurnView, { turn: { ...base, status: 'error', answer: 'Half an answer', error: 'Model stream error: socket hang up' }, thread })));
    expect(screen.getByTestId('ask-turn-answer').textContent).toContain('Half an answer');
    expect(screen.getByTestId('ask-turn-error').textContent).toContain('socket hang up');
    expect(screen.queryByTestId('ask-turn-meta')).toBeNull();
  });
});

describe('AskMarkdown', () => {
  const Where: React.FC = () => h('div', { 'data-testid': 'where' }, useLocation().pathname);
  it('routes internal PATH links through the router, opens external ones in a new tab, never renders images', () => {
    render(
      h(MemoryRouter, { initialEntries: ['/start'] },
        h(Routes, null, h(Route, { path: '*', element: h(React.Fragment, null,
          h(AskMarkdown, null, '[report](/evaluations/runs/r/inspect) [docs](https://example.com) ![pixel](https://evil.example/p.png)'),
          h(Where)) })))
    );
    expect(document.querySelector('img')).toBeNull();
    const ext = screen.getByText('docs') as HTMLAnchorElement;
    expect(ext.target).toBe('_blank');
    expect(ext.rel).toBe('noreferrer');
    fireEvent.click(screen.getByText('report'));
    expect(screen.getByTestId('where').textContent).toBe('/evaluations/runs/r/inspect');
  });
});

describe('suggestionsFor', () => {
  it('matches the page', () => {
    expect(suggestionsFor('/compare/b?runs=x,y', true)[0]).toMatch(/regressed/);
    expect(suggestionsFor('/evaluations/benchmarks/b/runs/r/inspect', true)[0]).toMatch(/Why did this case fail/);
    expect(suggestionsFor('/evaluations/benchmarks/b/runs/r/inspect', false)[0]).toMatch(/Why did this run fail/);
    expect(suggestionsFor('/agent-traces', false)[0]).toMatch(/span/);
    expect(suggestionsFor('/evaluations/test-cases/t', false)[0]).toMatch(/test case/);
    expect(suggestionsFor('/', false)).toEqual(['What am I looking at?']);
  });
});
