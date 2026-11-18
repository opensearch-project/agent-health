/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The same "step without a string `content`" shape that blanked the Run
 * inspector also reached the comparison page's `TrajectorySection`, which
 * passed `step.content` straight to `<Markdown>` (react-markdown throws on
 * non-string children). It now goes through `stepContentText()`. These tests
 * render the real component on the shared real-shaped fixture, once per
 * malformed shape.
 *
 * (The legacy `TrajectoryCompareView` has the same `content.length` read but
 * is deleted by the pending legacy-page retirement PR, so it is deliberately
 * left untouched here to avoid a modify/delete conflict.)
 */

import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TrajectorySection } from '@/components/comparison/sections/TrajectorySection';
import type { EvaluationReport, BenchmarkRun } from '@/types';
import {
  MALFORMED_CONTENT_SHAPES,
  MALFORMED_STEP_TOOL_NAME,
  REAL_SHAPED_STEP_COUNT,
  STEP_AFTER_MALFORMED_TEXT,
  STEP_BEFORE_MALFORMED_TEXT,
  FINAL_RESPONSE_TEXT,
  buildReportWithMalformedStep,
} from '../../../helpers/trajectoryFixtures';

// react-markdown is ESM-only (not transformed under Jest); the stub enforces
// the same `children must be a string` contract as the real library so the
// pre-fix `<Markdown>{step.content}</Markdown>` path still fails here.
jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children, className }: any) => {
    if (typeof children !== 'string') {
      throw new Error(`Unexpected value \`${children}\` for \`children\` prop, expected \`string\``);
    }
    return React.createElement('div', { className, 'data-testid': 'markdown' }, children);
  },
  hasRealMarkdown: () => false,
}));

// jsdom has no ResizeObserver (Radix ScrollArea needs it).
beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const report = (id: string, shape: (typeof MALFORMED_CONTENT_SHAPES)[number]) =>
  buildReportWithMalformedStep(id, shape) as unknown as EvaluationReport;

describe('TrajectorySection (comparison page) — step without a string content', () => {
  afterEach(() => jest.restoreAllMocks());

  const makeRun = (id: string, reportId: string): BenchmarkRun =>
    ({
      id,
      name: `Run ${id}`,
      status: 'completed',
      createdAt: new Date().toISOString(),
      results: { 'tc-1': { reportId, status: 'completed', passFailStatus: 'pass' } },
    }) as unknown as BenchmarkRun;

  it.each(MALFORMED_CONTENT_SHAPES)('expanding the malformed step (%s content) renders its arguments, not a crash', (shape) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = report('r-1', shape);
    render(
      React.createElement(TrajectorySection, {
        runs: [makeRun('run-1', r.id)],
        reports: { [r.id]: r },
        useCaseId: 'tc-1',
      }),
    );

    expect(screen.getByText(`${REAL_SHAPED_STEP_COUNT} steps`)).toBeTruthy();
    // The action step and its tool_result share the tool name (as real data
    // does) — the action is the first one in document order.
    const [trigger] = screen.getAllByText(MALFORMED_STEP_TOOL_NAME);
    fireEvent.click(trigger);

    const item = trigger.closest('[data-state]') as HTMLElement;
    expect(item.getAttribute('data-state')).toBe('open');
    // Arguments are shown; the "Content:" block is shown only when there is text.
    expect(within(item.parentElement as HTMLElement).getAllByText(/orders-2026\.\*/).length).toBeGreaterThanOrEqual(1);
    if (shape === 'undefined' || shape === 'null') {
      expect(screen.queryByText('Content:')).toBeNull();
    } else {
      expect(screen.getByText('Content:')).toBeTruthy();
    }
  });
});
