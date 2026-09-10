/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * lib/runLaunchState — the "Add Run" header button derives its state from the
 * polled RUN DOCUMENT, not from the SSE connection that launched the run
 * (owner report 2026-09-09: button stuck on "Running…" after an idle proxy
 * closed the stream on a 60-minute run).
 */

import {
  deriveAddRunButtonState,
  isTerminalRunStatus,
  LAUNCHED_RUN_DOC_GRACE_MS,
} from '@/lib/runLaunchState';

describe('isTerminalRunStatus', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)('%s is terminal', status => {
    expect(isTerminalRunStatus(status)).toBe(true);
  });

  it.each(['running', 'pending', undefined] as const)('%s is NOT terminal', status => {
    expect(isTerminalRunStatus(status)).toBe(false);
  });
});

describe('deriveAddRunButtonState', () => {
  const T0 = 1_700_000_000_000;

  it('is idle when nothing has been launched', () => {
    expect(deriveAddRunButtonState({ launching: false, launchedRunId: null, runs: [] })).toBe('idle');
    expect(deriveAddRunButtonState({
      launching: false, launchedRunId: null,
      runs: [{ id: 'other', status: 'running' }], // someone else's in-flight run does not spin OUR button
    })).toBe('idle');
  });

  it('is launching while the POST is in flight and no `started` (runId) has arrived', () => {
    expect(deriveAddRunButtonState({ launching: true, launchedRunId: null, runs: [] })).toBe('launching');
  });

  it('is running once a runId is known and the polled doc is non-terminal', () => {
    expect(deriveAddRunButtonState({
      launching: false, launchedRunId: 'r1', runs: [{ id: 'r1', status: 'running' }],
    })).toBe('running');
    expect(deriveAddRunButtonState({
      launching: false, launchedRunId: 'r1', runs: [{ id: 'r1', status: 'pending' }],
    })).toBe('running');
    // A status-less (legacy-shaped) doc is treated as still running.
    expect(deriveAddRunButtonState({
      launching: false, launchedRunId: 'r1', runs: [{ id: 'r1' }],
    })).toBe('running');
  });

  it('a runId with `launching` still true is running (the doc is authoritative once we have an id)', () => {
    expect(deriveAddRunButtonState({
      launching: true, launchedRunId: 'r1', runs: [{ id: 'r1', status: 'running' }],
    })).toBe('running');
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'returns to idle as soon as the polled doc is %s — regardless of any SSE connection',
    status => {
      expect(deriveAddRunButtonState({
        launching: false, launchedRunId: 'r1', runs: [{ id: 'r1', status }],
      })).toBe('idle');
    }
  );

  it('is running (optimistic) while the launched doc has not shown up in the polled list yet', () => {
    expect(deriveAddRunButtonState({
      launching: false, launchedRunId: 'r1', launchedAt: T0, now: T0, runs: [],
    })).toBe('running');
    expect(deriveAddRunButtonState({
      launching: false, launchedRunId: 'r1', launchedAt: T0, now: T0 + LAUNCHED_RUN_DOC_GRACE_MS, runs: [],
    })).toBe('running');
  });

  it('gives up on a launched doc that never appears after the bounded grace (no second way to spin forever)', () => {
    expect(deriveAddRunButtonState({
      launching: false, launchedRunId: 'r1', launchedAt: T0, now: T0 + LAUNCHED_RUN_DOC_GRACE_MS + 1, runs: [],
    })).toBe('idle');
  });

  it('defaults the clock to Date.now() and launchedAt to now when omitted (missing doc → running)', () => {
    expect(deriveAddRunButtonState({ launching: false, launchedRunId: 'r1', runs: [] })).toBe('running');
  });
});
