/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * lib/runLaunchState — the benchmark page tracks the runs it LAUNCHED by their
 * polled RUN DOCUMENTS, not by the SSE connections that launched them (owner
 * report 2026-09-09: header stuck on "Running…" after an idle proxy closed the
 * stream on a 60-minute run), and it tracks a LIST of them because launching
 * several arms back-to-back on one benchmark is the normal flow (owner
 * clarification 2026-09-13: Add Run must never be blocked by a running run).
 */

import {
  pruneLaunchedRuns,
  countRunsInFlight,
  progressFromPolledDoc,
  LAUNCHED_RUN_DOC_GRACE_MS,
  type LaunchedRun,
} from '@/lib/runLaunchState';

const T0 = 1_700_000_000_000;
const launched = (runId: string, launchedAt = T0): LaunchedRun => ({ runId, name: `Run ${runId}`, launchedAt });

describe('pruneLaunchedRuns', () => {
  it('keeps a launched run whose polled doc is non-terminal', () => {
    const l = [launched('r1')];
    expect(pruneLaunchedRuns(l, [{ id: 'r1', status: 'running' }], T0)).toEqual(l);
    expect(pruneLaunchedRuns(l, [{ id: 'r1', status: 'pending' }], T0)).toEqual(l);
    // A status-less (legacy-shaped) doc is treated as still running.
    expect(pruneLaunchedRuns(l, [{ id: 'r1' }], T0)).toEqual(l);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'drops a launched run as soon as its polled doc is %s — regardless of any SSE connection',
    status => {
      expect(pruneLaunchedRuns([launched('r1')], [{ id: 'r1', status }], T0)).toEqual([]);
    }
  );

  it('keeps a launched run (optimistically) while its doc has not shown up in the polled list yet, within the grace', () => {
    const l = [launched('r1')];
    expect(pruneLaunchedRuns(l, [], T0)).toEqual(l);
    expect(pruneLaunchedRuns(l, [], T0 + LAUNCHED_RUN_DOC_GRACE_MS)).toEqual(l);
  });

  it('gives up on a launched doc that never appears after the bounded grace (no second way to linger forever)', () => {
    expect(pruneLaunchedRuns([launched('r1')], [], T0 + LAUNCHED_RUN_DOC_GRACE_MS + 1)).toEqual([]);
  });

  it('defaults the clock to Date.now() (missing doc launched just now → kept)', () => {
    const l = [launched('r1', Date.now())];
    expect(pruneLaunchedRuns(l, [])).toEqual(l);
  });

  it('handles several launched runs independently and preserves launch order', () => {
    const l = [launched('r1'), launched('r2'), launched('r3'), launched('r4', T0 - LAUNCHED_RUN_DOC_GRACE_MS - 1)];
    const runs = [
      { id: 'r1', status: 'completed' as const },
      { id: 'r2', status: 'running' as const },
      // r3: doc not in the list yet (within grace) → kept
      // r4: doc never appeared, past grace → dropped
      { id: 'other', status: 'running' as const }, // someone else's run is not ours
    ];
    expect(pruneLaunchedRuns(l, runs, T0).map(x => x.runId)).toEqual(['r2', 'r3']);
  });

  it('returns the SAME array instance when nothing changed (so callers can skip a state update)', () => {
    const l = [launched('r1'), launched('r2')];
    const runs = [{ id: 'r1', status: 'running' as const }, { id: 'r2', status: 'running' as const }];
    expect(pruneLaunchedRuns(l, runs, T0)).toBe(l);
    expect(pruneLaunchedRuns([], runs, T0)).toEqual([]);
  });
});

describe('countRunsInFlight', () => {
  it('counts every run whose effective status is `running` — ours or anyone else\'s — and nothing else, so the count matches the table\'s status: running filter exactly', () => {
    expect(countRunsInFlight([])).toBe(0);
    expect(countRunsInFlight([
      { id: 'a', status: 'running' },
      { id: 'a2', status: 'running' },
      { id: 'b', status: 'pending' }, // not a table `running` row → not counted
      { id: 'c', status: 'completed' },
      { id: 'd', status: 'failed' },
      { id: 'e', status: 'cancelled' },
    ])).toBe(2);
  });

  it('resolves legacy status-less docs through their per-case results, like the runs table does', () => {
    expect(countRunsInFlight([
      { id: 'legacy-running', results: { tc1: { status: 'running' } } },
      { id: 'legacy-done', results: { tc1: { status: 'completed' } } },
    ])).toBe(1);
  });
});

describe('progressFromPolledDoc', () => {
  const cases = [
    { id: 'tc-1', name: 'Case 1', status: 'running' as const },
    { id: 'tc-2', name: 'Case 2', status: 'pending' as const },
    { id: 'tc-3', name: 'Case 3', status: 'pending' as const },
    { id: 'tc-4', name: 'Case 4', status: 'pending' as const },
    { id: 'tc-5', name: 'Case 5', status: 'pending' as const },
  ];

  it('rebuilds each row from the polled doc\'s results; a case with no result yet is pending (stale stream `running` reset)', () => {
    const rows = progressFromPolledDoc(cases, {
      id: 'r1', status: 'running',
      results: {
        'tc-2': { status: 'completed' }, 'tc-3': { status: 'failed' },
        'tc-4': { status: 'cancelled' }, 'tc-5': { status: 'running' },
        // tc-1: not started per the doc — its stream-era `running` is stale.
      },
    });
    expect(rows.map(r => r.status)).toEqual(['pending', 'completed', 'failed', 'cancelled', 'running']);
    expect(rows.map(r => r.name)).toEqual(cases.map(c => c.name));
  });

  it('keeps the stream\'s last-known rows while the doc has not appeared yet (grace window)', () => {
    expect(progressFromPolledDoc(cases, null)).toEqual(cases);
    expect(progressFromPolledDoc(cases, undefined)).toEqual(cases);
  });

  it('ignores unknown result statuses (row unchanged)', () => {
    const rows = progressFromPolledDoc(cases, { id: 'r1', results: { 'tc-2': { status: 'weird' } } });
    expect(rows[1].status).toBe('pending');
  });
});
