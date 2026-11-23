/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for TrajectoryView (Scope A theming fix).
 *
 * The fix added a dark-mode variant to the failed-step color
 * (`text-red-400` -> `text-red-600 dark:text-red-400`) so failed steps stay
 * legible in light mode too. These tests render the real component to
 * exercise both the failed and non-failed color branches.
 */

import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TrajectoryView } from '@/components/TrajectoryView';
import { ToolCallStatus, TrajectoryStep } from '@/types';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children, className }: any) => React.createElement('div', { className, 'data-testid': 'markdown' }, children),
  hasRealMarkdown: () => false,
}));

function makeStep(overrides: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return {
    id: 'step-1',
    type: 'action',
    content: 'did a thing',
    ...overrides,
  } as TrajectoryStep;
}

describe('TrajectoryView', () => {
  it('renders the failed-step label in the red text-red-600/dark:text-red-400 color', () => {
    const steps = [makeStep({ id: 'fail-1', type: 'action', status: ToolCallStatus.FAILURE, toolName: 'run_tests' })];
    render(React.createElement(TrajectoryView, { steps, loading: false }));

    const label = screen.getByText(/action · run_tests/);
    expect(label.className).toContain('text-red-600');
    expect(label.className).toContain('dark:text-red-400');
  });

  it('renders non-failed steps with the per-type color, not the failure red', () => {
    const steps = [makeStep({ id: 'ok-1', type: 'assistant', status: ToolCallStatus.SUCCESS })];
    render(React.createElement(TrajectoryView, { steps, loading: false }));

    const label = screen.getByText('assistant');
    expect(label.className).toBe('font-semibold text-purple-400');
    expect(label.className).not.toContain('red');
  });

  it('shows the empty state when there are no steps and not loading', () => {
    render(React.createElement(TrajectoryView, { steps: [], loading: false }));
    expect(screen.getByText('No test case output available')).toBeTruthy();
  });

  it('shows the initializing indicator when there are no steps and loading', () => {
    render(React.createElement(TrajectoryView, { steps: [], loading: true }));
    expect(screen.getByText('Initializing agent...')).toBeTruthy();
  });

  it('renders a `user` step as "user prompt", not "thinking", with its own color', () => {
    const steps = [makeStep({ id: 'u1', type: 'user', content: 'Can you recommend a sturdy, stainless steel camping mug?' })];
    render(React.createElement(TrajectoryView, { steps, loading: false }));

    const label = screen.getByText('user prompt');
    expect(label.className).toContain('text-cyan-400');
    expect(screen.queryByText('thinking')).toBeNull();
  });

  it('relabels a legacy (pre-fix) thinking step at position 0 that echoes "User: ..." as a user prompt', () => {
    const steps = [
      makeStep({ id: 'legacy-1', type: 'thinking', content: 'User: Can you recommend a sturdy, stainless steel camping mug?' }),
      makeStep({ id: 'resp-1', type: 'response', content: 'Sure, here are a few options...' }),
    ];
    render(React.createElement(TrajectoryView, { steps, loading: false }));

    const label = screen.getByText('user prompt');
    expect(label.className).toContain('text-cyan-400');
    // The `User: ` echo prefix is stripped once the step is re-labeled.
    expect(screen.getByText(/^Can you recommend a sturdy, stainless steel camping mug\?/)).toBeTruthy();
    expect(screen.queryByText('thinking')).toBeNull();
  });

  it('does NOT relabel a genuine thinking step at position 0 that happens to contain "User" mid-sentence', () => {
    const steps = [makeStep({ id: 'think-1', type: 'thinking', content: 'The User asked about mugs, let me search.' })];
    render(React.createElement(TrajectoryView, { steps, loading: false }));
    expect(screen.getByText('thinking')).toBeTruthy();
    expect(screen.queryByText('user prompt')).toBeNull();
  });

  it('relabels a legacy "User: " thinking step at ANY position, not just index 0 (multi-turn legacy reports)', () => {
    const steps = [
      makeStep({ id: 'action-0', type: 'action', content: 'searched catalog', toolName: 'search' }),
      makeStep({ id: 'legacy-2', type: 'thinking', content: 'User: follow-up question' }),
    ];
    render(React.createElement(TrajectoryView, { steps, loading: false }));
    expect(screen.getByText('user prompt')).toBeTruthy();
    expect(screen.queryByText('thinking')).toBeNull();
  });
});

/**
 * Structured content: `action` args, MCP-envelope tool results and JSON
 * responses render through <PrettyContent> (summary header + tree/table/raw)
 * instead of a single escaped line / raw <pre>.
 */
describe('TrajectoryView — prettified structured content', () => {
  const hits = Array.from({ length: 20 }, (_, i) => ({ id: `doc-${i}`, title: `Product ${i}`, score: 20 - i }));
  const inner = { status: 'ok', index: 'products', total: 91, hit_count: 20, hits };
  const envelope = JSON.stringify([{ type: 'text', text: JSON.stringify(inner) }]);
  const args = { index: 'products', query: { bool: { must: [{ match: { title: 'card shuffler' } }] } }, size: 20 };
  const argsContent = JSON.stringify(args);

  it('collapsed tool_result preview is the compact shape summary, not the escaped blob', () => {
    render(React.createElement(TrajectoryView, { steps: [makeStep({ id: 'r1', type: 'tool_result', content: envelope, toolName: 'search_index' })] }));
    const btn = screen.getByRole('button', { name: /object · 5 keys/ });
    expect(btn.textContent).toContain('status, index, total, hit_count, hits');
    expect(btn.textContent).toContain(`(${envelope.length} chars)`);
    expect(btn.textContent).not.toContain('\\"');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // Nothing heavy is rendered until expanded.
    expect(screen.queryByTestId('pretty-r1')).toBeNull();
  });

  it('expanding a tool_result shows the summary header, defaults to the table of hits, and Raw shows the original string', () => {
    render(React.createElement(TrajectoryView, { steps: [makeStep({ id: 'r1', type: 'tool_result', content: envelope })] }));
    fireEvent.click(screen.getByRole('button', { name: /object · 5 keys/ }));
    expect(screen.getByTestId('pretty-r1-summary').textContent).toBe('object · 5 keys');
    const table = screen.getByTestId('pretty-r1-table');
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(within(table).getByText('Product 3')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pretty-r1-mode-raw'));
    expect(screen.getByTestId('pretty-r1-raw').textContent).toBe(envelope);
  });

  it('action args render as a tree (not a single line) and keep the `action · tool · latency` header', () => {
    render(
      React.createElement(TrajectoryView, {
        steps: [makeStep({ id: 'a1', type: 'action', toolName: 'search_index', toolArgs: args, content: argsContent, latencyMs: 310 })],
      })
    );
    expect(screen.getByText('action · search_index')).toBeTruthy();
    expect(screen.getByText('310ms')).toBeTruthy();
    // Short args (<200 chars) are shown inline, expanded.
    const tree = screen.getByTestId('pretty-a1-tree');
    expect(within(tree).getByText('index')).toBeTruthy();
    expect(within(tree).getByText('"products"')).toBeTruthy();
    expect(within(tree).getByLabelText('Collapse query')).toBeTruthy();
    // Raw shows the persisted content string, not a re-serialisation.
    fireEvent.click(screen.getByTestId('pretty-a1-mode-raw'));
    expect(screen.getByTestId('pretty-a1-raw').textContent).toBe(argsContent);
  });

  it('long action args collapse to a summary preview and expand into the tree', () => {
    const bigArgs = { index: 'products', dsl: { size: 20, query: { bool: { must: [{ match: { title: { query: 'x'.repeat(200), operator: 'and' } } }] } } } };
    const content = JSON.stringify(bigArgs);
    render(React.createElement(TrajectoryView, { steps: [makeStep({ id: 'a2', type: 'action', toolName: 'search_index', toolArgs: bigArgs, content })] }));
    const btn = screen.getByRole('button', { name: /object · 2 keys · index, dsl/ });
    expect(screen.queryByTestId('pretty-a2')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId('pretty-a2-tree')).toBeTruthy();
  });

  it('large toolArgs with a tiny content echo are still collapsed by default', () => {
    const bigArgs = { index: 'products', filters: Array.from({ length: 40 }, (_, i) => ({ term: { [`f${i}`]: i } })) };
    render(React.createElement(TrajectoryView, { steps: [makeStep({ id: 'a3', type: 'action', toolName: 'search_index', toolArgs: bigArgs, content: 'search_index' })] }));
    expect(screen.queryByTestId('pretty-a3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /object · 2 keys · index, filters/ }));
    expect(screen.getByTestId('pretty-a3')).toBeTruthy();
  });

  it('a JSON response renders as a table of ranked results; a prose response stays markdown', () => {
    const ranked = JSON.stringify({ results: [{ rank: 1, id: 'a' }, { rank: 2, id: 'b' }, { rank: 3, id: 'c' }] });
    render(
      React.createElement(TrajectoryView, {
        steps: [
          makeStep({ id: 'resp-json', type: 'response', content: ranked }),
          makeStep({ id: 'resp-md', type: 'response', content: 'Here are the **top** results.' }),
        ],
      })
    );
    const table = screen.getByTestId('pretty-resp-json-table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('rank')).toBeTruthy();
    expect(screen.getByTestId('markdown').textContent).toBe('Here are the **top** results.');
  });

  it('a non-JSON tool_result still renders as a monospace <pre> when expanded', () => {
    const log = Array.from({ length: 10 }, (_, i) => `[INFO] line ${i}: shard ${i} allocated`).join('\n');
    render(React.createElement(TrajectoryView, { steps: [makeStep({ id: 'r2', type: 'tool_result', content: log })] }));
    fireEvent.click(screen.getByRole('button', { name: /\[INFO\] line 0/ }));
    expect(screen.queryByTestId('pretty-r2')).toBeNull();
    const pre = document.querySelector('pre.font-mono');
    expect(pre?.textContent).toBe(log);
  });

  it('renders a 500-step trajectory with large envelope results quickly (collapsed) and re-renders one toggle cheaply', () => {
    const steps: TrajectoryStep[] = [];
    for (let i = 0; i < 250; i++) {
      steps.push(makeStep({ id: `a${i}`, type: 'action', toolName: 'search_index', toolArgs: args, content: argsContent }));
      steps.push(makeStep({ id: `r${i}`, type: 'tool_result', content: envelope }));
    }
    const t0 = performance.now();
    render(React.createElement(TrajectoryView, { steps }));
    const initial = performance.now() - t0;
    expect(screen.getAllByText('action · search_index')).toHaveLength(250);

    // Locate first (jsdom's accessible-name query over a large DOM is slow
    // and not what we're measuring), then time the click → re-render.
    const firstResult = document.querySelector('[data-testid="trajectory-step-tool_result"] button') as HTMLElement;
    const t1 = performance.now();
    fireEvent.click(firstResult);
    const toggle = performance.now() - t1;
    expect(screen.getByTestId('pretty-r0-table')).toBeTruthy();

    // Generous bounds (jsdom is slow) — the point is "does not freeze": the
    // pre-change render of this fixture spent its time on 250 Markdown trees
    // and re-normalised every step on each toggle.
    expect(initial).toBeLessThan(5000);
    expect(toggle).toBeLessThan(1500);
    // eslint-disable-next-line no-console
    console.info(`[perf] 500-step trajectory: initial ${initial.toFixed(0)}ms, single toggle ${toggle.toFixed(0)}ms`);
  });
});
