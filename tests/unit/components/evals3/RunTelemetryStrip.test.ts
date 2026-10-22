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
import { describeNoTraces, describeUnavailable, type RunTelemetry } from '@/lib/runTelemetry';

const tel = (over: Partial<RunTelemetry> = {}): RunTelemetry => ({
  totalTokens: 5_900_000, costUsd: 20.19, llmCalls: 312, toolCalls: 118,
  medianDurationMs: 44_000, spansCases: 4, totalCases: 4, errorCases: 0, pendingCases: 0, unavailable: false, hasSpans: true, partial: false, ...over,
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

  it('no spans → "no traces" (not a bare "—") with a tooltip that says the agent was not traced and how to enable it; Time/case and 0/N still shown', () => {
    const t = tel({ hasSpans: false, spansCases: 0, totalTokens: 0, costUsd: 0, llmCalls: 0, toolCalls: 0, medianDurationMs: 22_000 });
    render(React.createElement(RunTelemetryStrip, { telemetry: t, loading: false }));
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('empty');
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-empty-kind')).toBe('no-traces');
    for (const id of ['strip-tokens', 'strip-cost', 'strip-llmcalls', 'strip-toolcalls']) {
      expect(within(screen.getByTestId(id)).getByText('no traces')).toBeTruthy();
      expect(screen.getByTestId(id).getAttribute('title')).toBe(describeNoTraces(t));
    }
    expect(describeNoTraces(t)).toMatch(new RegExp(`^${STRIP_NO_SPANS_TITLE} — no spans were found for any of its 4 cases`));
    expect(describeNoTraces(t)).toMatch(/useTraces: true/);
    expect(describeNoTraces(t)).toMatch(/traceServiceName/);
    expect(screen.getByTestId('strip-timepercase').textContent).toBe('Time/case22 s');
    expect(screen.getByTestId('strip-spans').textContent).toBe('spans: 0/4 cases');
    expect(screen.getByTestId('strip-spans').getAttribute('title')).toBe(describeNoTraces(t));
  });

  it('metrics still in flight (pending keys, no spans yet) → skeletons on the trace stats, never a premature "no traces"', () => {
    const t = tel({ hasSpans: false, spansCases: 0, pendingCases: 3, totalTokens: 0, costUsd: 0, llmCalls: 0, toolCalls: 0, medianDurationMs: 22_000 });
    render(React.createElement(RunTelemetryStrip, { telemetry: t, loading: true }));
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('loading');
    expect(screen.getAllByLabelText('Loading')).toHaveLength(4);
    expect(screen.queryByText('no traces')).toBeNull();
    expect(screen.getByTestId('strip-timepercase').textContent).toBe('Time/case22 s');   // wall-clock is immediate
    expect(screen.getByTestId('strip-spans').textContent).toBe('spans: 0/4 cases (loading…)');
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

  it('run unavailable (query failed, no spans found) → "unavailable" with the failure in the tooltip, spans "—", wall-clock kept, Retry offered', () => {
    const onRetry = jest.fn();
    const t = unavailableTel({ medianDurationMs: 22_000, errorMessage: 'Request timed out' });
    render(React.createElement(RunTelemetryStrip, { telemetry: t, loading: false, onRetry }));
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('empty');
    expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-empty-kind')).toBe('unavailable');
    for (const id of ['strip-tokens', 'strip-cost', 'strip-llmcalls', 'strip-toolcalls']) {
      expect(within(screen.getByTestId(id)).getByText('unavailable')).toBeTruthy();
      expect(screen.getByTestId(id).getAttribute('title')).toBe(describeUnavailable(t));
    }
    expect(describeUnavailable(t)).toBe(`${STRIP_UNAVAILABLE_TITLE} — the trace-store query failed for 4 of 4 cases (Request timed out). Spans may well exist; use Retry.`);
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
