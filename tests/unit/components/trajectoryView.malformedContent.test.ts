/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: TrajectoryView used to read `step.content.length` (and hand
 * `step.content` straight to react-markdown, which throws on non-strings).
 * One persisted `action` step without a string `content` therefore threw
 * mid-render and — with no error boundary anywhere above it — blanked the
 * entire Run inspector / `/runs/:id` page.
 *
 * These tests render the real component on a 12-step real-shaped trajectory
 * with the malformed step in the middle, once per malformed shape, and assert
 * that every other step is still on screen. All of them fail on the pre-fix
 * component (the `.length` read throws before markdown is even reached).
 */

import * as React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { TrajectoryView } from '@/components/TrajectoryView';
import { TrajectoryStep } from '@/types';
import {
  MALFORMED_CONTENT_SHAPES,
  MALFORMED_STEP_TOOL_NAME,
  REAL_SHAPED_STEP_COUNT,
  STEP_AFTER_MALFORMED_TEXT,
  STEP_BEFORE_MALFORMED_TEXT,
  FINAL_RESPONSE_TEXT,
  buildRealShapedTrajectory,
} from '../../helpers/trajectoryFixtures';

// react-markdown is ESM-only and not transformed under Jest's CJS loader, so
// (like every other unit suite here) the module boundary is stubbed. The stub
// deliberately enforces the same contract the real library does —
// `createFile()` in react-markdown/lib/index.js calls `unreachable(...)` when
// `children` is not a string — so the pre-fix `<Markdown>{step.content}</Markdown>`
// path still fails here. The REAL library in a real browser is exercised by
// tests/e2e/run-inspector-malformed-step.spec.ts.
jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children, className }: any) => {
    if (typeof children !== 'string') {
      throw new Error(`Unexpected value \`${children}\` for \`children\` prop, expected \`string\``);
    }
    // Sentinel used by the error-boundary tests to force a render-time throw
    // *inside* a step after every data coercion has already succeeded.
    if (children.includes('__THROW_IN_MARKDOWN__')) throw new Error('markdown renderer exploded');
    return React.createElement('div', { className, 'data-testid': 'markdown' }, children);
  },
  hasRealMarkdown: () => false,
}));

function renderSteps(steps: Array<Record<string, unknown>>) {
  // Silence React's expected error-boundary logging for the throwing cases.
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const result = render(React.createElement(TrajectoryView, { steps: steps as unknown as TrajectoryStep[], loading: false }));
  return { ...result, consoleError };
}

describe('TrajectoryView — step without a string `content` (inspector blank-page regression)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe.each(MALFORMED_CONTENT_SHAPES)('malformed content shape: %s', (shape) => {
    it('renders every one of the 12 steps, including the malformed action step', () => {
      renderSteps(buildRealShapedTrajectory(shape));

      const cards = screen.getAllByTestId('trajectory-step');
      expect(cards).toHaveLength(REAL_SHAPED_STEP_COUNT);
      // No step fell back to the error boundary card.
      expect(screen.queryAllByTestId('render-error-boundary')).toHaveLength(0);

      // Neighbours of the malformed step are still visible.
      expect(screen.getByText(STEP_BEFORE_MALFORMED_TEXT)).toBeTruthy();
      expect(screen.getByText(STEP_AFTER_MALFORMED_TEXT)).toBeTruthy();
      expect(screen.getByText(FINAL_RESPONSE_TEXT)).toBeTruthy();

      // The malformed step itself is labelled with its tool and shows the
      // serialized tool arguments (what the producer meant), not a crash.
      const malformed = screen.getByText(`action · ${MALFORMED_STEP_TOOL_NAME}`).closest('[data-testid="trajectory-step"]')!;
      expect(within(malformed as HTMLElement).getByText(/orders-2026\.\*/)).toBeTruthy();
    });

    it('shows a neutral "(no text)" body when the step has neither content nor toolArgs', () => {
      const steps = buildRealShapedTrajectory(shape, { withToolArgs: false });
      renderSteps(steps);

      expect(screen.getAllByTestId('trajectory-step')).toHaveLength(REAL_SHAPED_STEP_COUNT);
      const malformed = screen.getByText(`action · ${MALFORMED_STEP_TOOL_NAME}`).closest('[data-testid="trajectory-step"]') as HTMLElement;
      if (shape === 'object') {
        // The object content IS the serialized arguments — show them.
        expect(within(malformed).getByText(/orders-2026\.\*/)).toBeTruthy();
        expect(within(malformed).queryByTestId('trajectory-step-no-text')).toBeNull();
      } else if (shape === 'number') {
        expect(within(malformed).getByText('42')).toBeTruthy();
      } else {
        expect(within(malformed).getByTestId('trajectory-step-no-text').textContent).toBe('(no text)');
      }
    });
  });

  it('a long (collapsible) step whose content is an object shows a JSON preview + char count instead of throwing', () => {
    const big = { query: 'x'.repeat(300), filters: { a: 1, b: [1, 2, 3] } };
    const steps = [
      { id: 's0', timestamp: 1, type: 'assistant', content: 'Querying…' },
      { id: 's1', timestamp: 2, type: 'action', toolName: 'big_tool', content: big },
      { id: 's2', timestamp: 3, type: 'response', content: 'Done.' },
    ];
    renderSteps(steps);
    expect(screen.getAllByTestId('trajectory-step')).toHaveLength(3);
    // Collapsed preview with the serialized length (pretty-printed JSON of `big`).
    const expectedLen = JSON.stringify(big, null, 2).length;
    expect(screen.getByText(`(${expectedLen} chars)`)).toBeTruthy();
    expect(screen.getByText('Done.')).toBeTruthy();
  });

  it('a legacy "User: " thinking step with a null content does not throw in the normalizer', () => {
    const steps = [
      { id: 't0', timestamp: 1, type: 'thinking', content: null },
      { id: 'r0', timestamp: 2, type: 'response', content: 'ok' },
    ];
    renderSteps(steps);
    expect(screen.getAllByTestId('trajectory-step')).toHaveLength(2);
    expect(screen.getByText('thinking')).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('long object content expands to a monospace <pre>, not through markdown', () => {
    const big = { query: 'x'.repeat(300), filters: { a: 1, b: [1, 2, 3] } };
    const steps = [{ id: 's1', timestamp: 2, type: 'action', toolName: 'big_tool', content: big }];
    renderSteps(steps);
    fireEvent.click(screen.getByRole('button'));
    const card = screen.getByTestId('trajectory-step');
    const pre = card.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe(JSON.stringify(big, null, 2));
    expect(within(card).queryByTestId('markdown')).toBeNull();
  });

  it('a thinking step with no text shows "(no text)" instead of a "0 chars" expander', () => {
    const steps = [
      { id: 't0', timestamp: 1, type: 'thinking', content: undefined },
      { id: 't1', timestamp: 2, type: 'thinking', content: null },
      { id: 'r0', timestamp: 3, type: 'response', content: 'ok' },
    ];
    renderSteps(steps);
    expect(screen.getAllByTestId('trajectory-step-no-text')).toHaveLength(2);
    expect(screen.queryByText(/0 chars/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a `null` entry in the trajectory array becomes one inline error card; the other 11 steps still render', () => {
    const steps: Array<Record<string, unknown> | null> = buildRealShapedTrajectory('undefined');
    steps[5] = null;
    renderSteps(steps as Array<Record<string, unknown>>);
    expect(screen.getAllByTestId('trajectory-step')).toHaveLength(REAL_SHAPED_STEP_COUNT - 1);
    const cards = screen.getAllByTestId('render-error-boundary');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("Couldn't render trajectory step 6");
    expect(cards[0].textContent).toContain('malformed trajectory step: null');
    expect(screen.getByText(STEP_BEFORE_MALFORMED_TEXT)).toBeTruthy();
    expect(screen.getByText(STEP_AFTER_MALFORMED_TEXT)).toBeTruthy();
  });

  it('circular toolArgs render as text (String() fallback), not as an error card', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const steps = [{ id: 's1', timestamp: 2, type: 'action', toolName: 'circular_tool', content: 'call', toolArgs: circular }];
    renderSteps(steps);
    expect(screen.getAllByTestId('trajectory-step')).toHaveLength(1);
    expect(screen.queryAllByTestId('render-error-boundary')).toHaveLength(0);
    expect(screen.getByText('[object Object]')).toBeTruthy();
  });

  it('steps without an `id` (and steps sharing an id) expand and collapse independently', () => {
    const long = (n: number) => `${'word '.repeat(60)}tail-${n}`;
    const steps = [
      { timestamp: 1, type: 'assistant', content: long(1) },
      { timestamp: 2, type: 'assistant', content: long(2) },
      { id: 'dup', timestamp: 3, type: 'assistant', content: long(3) },
      { id: 'dup', timestamp: 4, type: 'assistant', content: long(4) },
    ];
    renderSteps(steps);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);

    fireEvent.click(buttons[0]);
    expect(screen.getAllByTestId('markdown')).toHaveLength(1);
    expect(screen.getByTestId('markdown').textContent).toContain('tail-1');

    fireEvent.click(buttons[3]);
    const open = screen.getAllByTestId('markdown').map(el => el.textContent);
    expect(open).toHaveLength(2);
    expect(open.join(' ')).toContain('tail-4');
    expect(open.join(' ')).not.toContain('tail-3');
  });

  it('error boundary: a step that still throws renders an inline error card while every sibling stays visible', () => {
    const steps = [
      { id: 's0', timestamp: 1, type: 'assistant', content: 'Before the bad step' },
      { id: 's1', timestamp: 2, type: 'response', content: '__THROW_IN_MARKDOWN__' },
      { id: 's2', timestamp: 3, type: 'response', content: 'After the bad step' },
    ];
    const { consoleError } = renderSteps(steps);

    expect(screen.getByText('Before the bad step')).toBeTruthy();
    expect(screen.getByText('After the bad step')).toBeTruthy();
    const cards = screen.getAllByTestId('render-error-boundary');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("Couldn't render trajectory step 2");
    expect(cards[0].textContent).toContain('markdown renderer exploded');
    // The boundary logged the error (so it is not swallowed silently).
    expect(consoleError).toHaveBeenCalled();
  });

  it('error boundary resets when the step data changes (a different run loaded into the same mounted view)', () => {
    const bad = [
      { id: 's0', timestamp: 1, type: 'assistant', content: 'Before' },
      { id: 's1', timestamp: 2, type: 'response', content: '__THROW_IN_MARKDOWN__' },
    ];
    const good = [
      { id: 's0', timestamp: 1, type: 'assistant', content: 'Before' },
      { id: 's1', timestamp: 2, type: 'response', content: 'Now fine' },
    ];
    const { rerender } = renderSteps(bad);
    expect(screen.getAllByTestId('render-error-boundary')).toHaveLength(1);

    rerender(React.createElement(TrajectoryView, { steps: good as unknown as TrajectoryStep[], loading: false }));
    expect(screen.queryAllByTestId('render-error-boundary')).toHaveLength(0);
    expect(screen.getByText('Now fine')).toBeTruthy();
  });
});
