/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for DebugLatencyHud -- visible only when page-latency
 * instrumentation is active AND there is a current record; hidden
 * otherwise. Hover/click reveals history.
 */

import * as React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockIsActive = jest.fn();
const mockGetCurrentRecord = jest.fn();
const mockGetHistory = jest.fn();
const mockSubscribe = jest.fn();

jest.mock('@/lib/pageLatency', () => ({
  isPageLatencyActive: () => mockIsActive(),
  getCurrentRecord: () => mockGetCurrentRecord(),
  getHistory: () => mockGetHistory(),
  subscribe: (fn: () => void) => mockSubscribe(fn),
}));

import { DebugLatencyHud } from '@/components/DebugLatencyHud';

describe('DebugLatencyHud', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockIsActive.mockReset().mockReturnValue(false);
    mockGetCurrentRecord.mockReset().mockReturnValue(null);
    mockGetHistory.mockReset().mockReturnValue([]);
    mockSubscribe.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing when instrumentation is inactive', () => {
    const { container } = render(React.createElement(DebugLatencyHud));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when active but there is no current record yet', () => {
    mockIsActive.mockReturnValue(true);
    const { container } = render(React.createElement(DebugLatencyHud));
    expect(container.innerHTML).toBe('');
  });

  it('renders the current record\u2019s summary line when active with a record', () => {
    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmark-runs', startedAt: Date.now(), renderMs: 120, readyMs: 840, apiCount: 6, apiTotalMs: 610,
    });
    render(React.createElement(DebugLatencyHud));
    const hud = screen.getByTestId('debug-latency-hud');
    expect(hud.textContent).toContain('benchmark-runs');
    expect(hud.textContent).toContain('render 120 ms');
    expect(hud.textContent).toContain('ready 840 ms');
    expect(hud.textContent).toContain('6 api / 610 ms');
  });

  it('shows an em dash for renderMs/readyMs before they are measured', () => {
    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmarks', startedAt: Date.now(), renderMs: null, readyMs: null, apiCount: 0, apiTotalMs: 0,
    });
    render(React.createElement(DebugLatencyHud));
    const hud = screen.getByTestId('debug-latency-hud');
    expect(hud.textContent).toContain('render \u2014');
    expect(hud.textContent).toContain('ready \u2014');
  });

  it('reveals history on hover and hides it again on mouse leave', () => {
    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmarks', startedAt: Date.now(), renderMs: 50, readyMs: 200, apiCount: 1, apiTotalMs: 20,
    });
    mockGetHistory.mockReturnValue([
      { route: 'benchmarks', startedAt: Date.now(), renderMs: 50, readyMs: 200, apiCount: 1, apiTotalMs: 20 },
      { route: 'eval-runs', startedAt: Date.now() - 1000, renderMs: 40, readyMs: 150, apiCount: 2, apiTotalMs: 40 },
    ]);
    render(React.createElement(DebugLatencyHud));
    const hud = screen.getByTestId('debug-latency-hud');
    expect(screen.queryByTestId('debug-latency-hud-history')).toBeNull();

    fireEvent.mouseEnter(hud);
    expect(screen.getByTestId('debug-latency-hud-history')).toBeTruthy();
    expect(screen.getByTestId('debug-latency-hud-history').textContent).toContain('eval-runs');

    fireEvent.mouseLeave(hud);
    expect(screen.queryByTestId('debug-latency-hud-history')).toBeNull();
  });

  it('polls isPageLatencyActive so a debug-mode toggle in another tab is picked up without a remount', () => {
    mockIsActive.mockReturnValue(false);
    render(React.createElement(DebugLatencyHud));
    expect(screen.queryByTestId('debug-latency-hud')).toBeNull();

    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue({
      route: 'benchmarks', startedAt: Date.now(), renderMs: 10, readyMs: 20, apiCount: 0, apiTotalMs: 0,
    });
    act(() => { jest.advanceTimersByTime(1100); });
    expect(screen.getByTestId('debug-latency-hud')).toBeTruthy();
  });
});
