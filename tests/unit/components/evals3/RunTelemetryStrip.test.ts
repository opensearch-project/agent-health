/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunTelemetryStrip — the compact Tokens · Cost · LLM calls · Tool calls ·
 * Time/case · spans N/M read-out under the run inspector header.
 */

import * as React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { RunTelemetryStrip, STRIP_NO_SPANS_TITLE, STRIP_UNAVAILABLE_TITLE } from '@/components/evals3/RunTelemetryStrip';
import type { RunTelemetry } from '@/lib/runTelemetry';

const tel = (over: Partial<RunTelemetry> = {}): RunTelemetry => ({
  totalTokens: 5_900_000, costUsd: 20.19, llmCalls: 312, toolCalls: 118,
  medianDurationMs: 44_000, spansCases: 4, totalCases: 4, errorCases: 0, unavailable: false, hasSpans: true, partial: false, ...over,
});
const unavailableTel = (over: Partial<RunTelemetry> = {}): RunTelemetry =>
  tel({ hasSpans: false, spansCases: 0, errorCases: 4, unavailable: true, totalTokens: 0, costUsd: 0, llmCalls: 0, toolCalls: 0, ...over });

describe('RunTelemetryStrip', () => {
  it('renders every stat with compact formatting and the spans ratio', () => {
    render(React.createElement(RunTelemetryStrip, { telemetry: tel(), loading: false }));
    const strip = screen.getByTestId('run-telemetry-strip');
    expect(strip.getAttribute('data-state')).toBe('value');
    expect(screen.getByTestId('strip-tokens').textContent).toBe('Tokens5.9M');
    expect(screen.getByTestId('strip-tokens').getAttribute('title')).toBe('5,900,000 tokens');
    expect(screen.getByTestId('strip-cost').textContent).toBe('Cost$20.19');
    expect(screen.getByTestId('strip-llmcalls').textContent).toBe('LLM calls312');
    expect(screen.getByTestId('strip-toolcalls').textContent).toBe('Tool calls118');
    expect(screen.getByTestId('strip-timepercase').textContent).toBe('Time/case44 s');
    expect(screen.getByTestId('strip-spans').textContent).toBe('spans: 4/4 cases');
  });

  it('prefixes ≥ on span-derived stats when partial', () => {
    render(React.createElement(RunTelemetryStrip, { telemetry: tel({ partial: true }), loading: false }));
    expect(screen.getByTestId('strip-tokens').textContent).toBe('Tokens≥5.9M');
    expect(screen.getByTestId('strip-llmcalls').textContent).toBe('LLM calls≥312');
    expect(screen.getByTestId('strip-timepercase').textContent).toBe('Time/case44 s');  // wall-clock is exact
  });

  it('no spans → "—" with the no-spans tooltip on span stats; Time/case and 0/N still shown', () => {
    render(React.createElement(RunTelemetryStrip, { telemetry: tel({ hasSpans: false, spansCases: 0, totalTokens: 0, costUsd: 0, llmCalls: 0, toolCalls: 0, medianDurationMs: 22_000 }), loading: false }));
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('empty');
    for (const id of ['strip-tokens', 'strip-cost', 'strip-llmcalls', 'strip-toolcalls']) {
      expect(within(screen.getByTestId(id)).getByText('—')).toBeTruthy();
      expect(screen.getByTestId(id).getAttribute('title')).toBe(STRIP_NO_SPANS_TITLE);
    }
    expect(screen.getByTestId('strip-timepercase').textContent).toBe('Time/case22 s');
    expect(screen.getByTestId('strip-spans').textContent).toBe('spans: 0/4 cases');
    expect(screen.getByTestId('strip-spans').getAttribute('title')).toBe(STRIP_NO_SPANS_TITLE);
  });

  it('spans present but zero cost → Cost "—" with an explanatory tooltip', () => {
    render(React.createElement(RunTelemetryStrip, { telemetry: tel({ costUsd: 0 }), loading: false }));
    expect(screen.getByTestId('strip-cost').textContent).toBe('Cost—');
    expect(screen.getByTestId('strip-cost').getAttribute('title')).toBe('Spans carried no cost');
    expect(screen.getByTestId('strip-tokens').textContent).toBe('Tokens5.9M');
  });

  it('loading (no value yet) → skeleton placeholders for every stat', () => {
    render(React.createElement(RunTelemetryStrip, { telemetry: undefined, loading: true }));
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('loading');
    expect(screen.getAllByLabelText('Loading')).toHaveLength(5);
  });

  it('run unavailable (every key errored) → span stats "—" with the unavailable tooltip, spans "—", wall-clock kept, Retry offered', () => {
    const onRetry = jest.fn();
    render(React.createElement(RunTelemetryStrip, { telemetry: unavailableTel({ medianDurationMs: 22_000 }), loading: false, onRetry }));
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('empty');
    for (const id of ['strip-tokens', 'strip-cost', 'strip-llmcalls', 'strip-toolcalls']) {
      expect(within(screen.getByTestId(id)).getByText('—')).toBeTruthy();
      expect(screen.getByTestId(id).getAttribute('title')).toBe(STRIP_UNAVAILABLE_TITLE);
    }
    expect(screen.getByTestId('strip-timepercase').textContent).toBe('Time/case22 s');
    expect(screen.getByTestId('strip-spans').textContent).toBe('spans: — cases');
    fireEvent.click(screen.getByTestId('strip-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('no Retry link when metrics are available or when no onRetry is supplied', () => {
    render(React.createElement(RunTelemetryStrip, { telemetry: tel(), loading: false, onRetry: jest.fn() }));
    expect(screen.queryByTestId('strip-retry')).toBeNull();
  });

  it('renders nothing when there is no roll-up and nothing loading (run has no reports yet)', () => {
    const { container } = render(React.createElement(RunTelemetryStrip, { telemetry: undefined, loading: false }));
    expect(container.firstChild).toBeNull();
  });
});
