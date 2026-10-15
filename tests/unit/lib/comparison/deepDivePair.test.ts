/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pair selection for the trace-grounded deep-dive on a 3+-run compare page
 * (lib/comparison/deepDivePair.ts): defaults (oldest → A, newest → B), URL
 * round-trip, A ≠ B enforcement, and the "keep the pinned pair only while
 * both runs stay selected" rule.
 *
 * Plus the representative-case resolution for a resolved [A, B]
 * (`resolveDeepDiveCasePair`): the owner's 2-run report — the section was
 * missing with exactly two runs — came down to the pair being read ONLY from
 * the comparison rows, which carry a reportId only after the browser has
 * downloaded that report doc. The run docs carry the ids from the start.
 */

import {
  changeDeepDivePairSide,
  defaultDeepDivePair,
  parseDeepDivePairParam,
  resolveDeepDiveCasePair,
  resolveDeepDivePair,
  retainDeepDivePairForSelection,
  serializeDeepDivePair,
} from '@/lib/comparison/deepDivePair';

const run = (id: string, createdAt: string) => ({ id, createdAt } as any);
// Deliberately NOT in chronological selection order.
const RUNS = [run('mid', '2026-10-02T00:00:00Z'), run('newest', '2026-10-03T00:00:00Z'), run('oldest', '2026-10-01T00:00:00Z')];
const IDS = RUNS.map((r) => r.id);

describe('defaultDeepDivePair', () => {
  it('picks the oldest selected run as A (baseline) and the newest as B regardless of selection order', () => {
    expect(defaultDeepDivePair(RUNS)).toEqual(['oldest', 'newest']);
  });

  it('returns null for fewer than two runs', () => {
    expect(defaultDeepDivePair([])).toBeNull();
    expect(defaultDeepDivePair([run('only', '2026-10-01T00:00:00Z')])).toBeNull();
  });

  it('breaks ties / unparseable dates by id so the result is deterministic regardless of list order', () => {
    expect(defaultDeepDivePair([run('x', 'garbage'), run('y', 'garbage'), run('z', 'garbage')])).toEqual(['x', 'z']);
    expect(defaultDeepDivePair([run('z', 'garbage'), run('y', 'garbage'), run('x', 'garbage')])).toEqual(['x', 'z']);
    expect(defaultDeepDivePair([run('y', '2026-10-01T00:00:00Z'), run('x', '2026-10-01T00:00:00Z')])).toEqual(['x', 'y']);
  });
});

describe('parseDeepDivePairParam / serializeDeepDivePair', () => {
  it('round-trips a valid pair', () => {
    const s = serializeDeepDivePair(['oldest', 'mid']);
    expect(s).toBe('oldest,mid');
    expect(parseDeepDivePairParam(s, IDS)).toEqual(['oldest', 'mid']);
  });

  it('rejects absent, partial, duplicate (A = B) and non-selected ids', () => {
    expect(parseDeepDivePairParam(null, IDS)).toBeNull();
    expect(parseDeepDivePairParam('', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest,', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest,oldest', IDS)).toBeNull();
    expect(parseDeepDivePairParam('oldest,not-selected', IDS)).toBeNull();
    expect(parseDeepDivePairParam('a,b,c', ['a', 'b', 'c'])).toBeNull();
  });
});

describe('resolveDeepDivePair', () => {
  it('uses the default pair (flagged isDefault) when the URL carries nothing usable', () => {
    expect(resolveDeepDivePair(RUNS, null)).toEqual({ pair: ['oldest', 'newest'], isDefault: true });
    expect(resolveDeepDivePair(RUNS, 'oldest,gone')).toEqual({ pair: ['oldest', 'newest'], isDefault: true });
  });

  it('honours a valid URL pair and flags it non-default (so it does not auto-start the LLM job)', () => {
    expect(resolveDeepDivePair(RUNS, 'oldest,mid')).toEqual({ pair: ['oldest', 'mid'], isDefault: false });
    expect(resolveDeepDivePair(RUNS, 'newest,oldest')).toEqual({ pair: ['newest', 'oldest'], isDefault: false });
  });

  it('a URL pair identical to the default still counts as the default', () => {
    expect(resolveDeepDivePair(RUNS, 'oldest,newest')).toEqual({ pair: ['oldest', 'newest'], isDefault: true });
  });

  it('returns null with fewer than two runs', () => {
    expect(resolveDeepDivePair([RUNS[0]], 'oldest,newest')).toBeNull();
  });
});

describe('changeDeepDivePairSide (A ≠ B)', () => {
  it('changes one side and leaves the other alone when there is no collision', () => {
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'B', 'mid')).toEqual(['oldest', 'mid']);
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'A', 'mid')).toEqual(['mid', 'newest']);
  });

  it('swaps instead of producing A = B when the new value collides with the other side', () => {
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'B', 'oldest')).toEqual(['newest', 'oldest']);
    expect(changeDeepDivePairSide(['oldest', 'newest'], 'A', 'newest')).toEqual(['newest', 'oldest']);
  });
});

describe('retainDeepDivePairForSelection', () => {
  it('keeps the pinned pair while both runs stay selected and drops it otherwise', () => {
    expect(retainDeepDivePairForSelection('oldest,mid', IDS)).toBe('oldest,mid');
    expect(retainDeepDivePairForSelection('oldest,mid', ['oldest', 'newest'])).toBeUndefined();
    expect(retainDeepDivePairForSelection(null, IDS)).toBeUndefined();
  });
});

// ── Representative case for the resolved pair ─────────────────────────────────

const RUN_A = {
  id: 'run-a',
  createdAt: '2026-10-01T00:00:00Z',
  testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'Case One' }, { id: 'tc-2', version: 1, name: 'Case Two' }],
  results: {
    'tc-1': { reportId: 'rep-a-1', status: 'completed' },
    'tc-2': { reportId: 'rep-a-2', status: 'failed' },
    'tc-3': { reportId: '', status: 'cancelled' },
  },
} as any;
const RUN_B = {
  id: 'run-b',
  createdAt: '2026-10-02T00:00:00Z',
  results: {
    'tc-1': { reportId: 'rep-b-1', status: 'completed' },
    'tc-2': { reportId: 'rep-b-2', status: 'completed' },
  },
} as any;
/** A row as buildTestCaseComparisonRows emits it BEFORE the report docs are loaded: no reportId, status 'missing'. */
const unloadedRow = (testCaseId: string, name: string) =>
  ({ testCaseId, testCaseName: name, results: { 'run-a': { status: 'missing' }, 'run-b': { status: 'missing' } } } as any);
const loadedRow = (testCaseId: string, name: string, a: string, b: string) =>
  ({ testCaseId, testCaseName: name, results: { 'run-a': { reportId: a, status: 'completed' }, 'run-b': { reportId: b, status: 'completed' } } } as any);

describe('resolveDeepDiveCasePair', () => {
  it('uses the rows\' report ids when they carry them (the loaded-reports path)', () => {
    const pair = resolveDeepDiveCasePair([RUN_A, RUN_B], [loadedRow('tc-2', 'Case Two', 'rep-a-2', 'rep-b-2')]);
    expect(pair).toEqual({ testCaseId: 'tc-2', testCaseName: 'Case Two', reportIdA: 'rep-a-2', reportIdB: 'rep-b-2', cacheKey: 'rep-a-2|rep-b-2' });
  });

  it('picks the LOWEST testCaseId among the candidates, independent of row order — the table re-sorts as metadata loads and a moving pair relaunched the LLM job', () => {
    const byName = [loadedRow('tc-2', 'Alpha', 'rep-a-2', 'rep-b-2'), loadedRow('tc-1', 'Beta', 'rep-a-1', 'rep-b-1')];
    const byId = [...byName].reverse();
    const expected = { testCaseId: 'tc-1', testCaseName: 'Beta', reportIdA: 'rep-a-1', reportIdB: 'rep-b-1', cacheKey: 'rep-a-1|rep-b-1' };
    expect(resolveDeepDiveCasePair([RUN_A, RUN_B], byName)).toEqual(expected);
    expect(resolveDeepDiveCasePair([RUN_A, RUN_B], byId)).toEqual(expected);
    // Same choice before the reports are in (run-doc ids) and after (row ids): the cache key never moves.
    expect(resolveDeepDiveCasePair([RUN_A, RUN_B], [unloadedRow('tc-2', 'Alpha'), unloadedRow('tc-1', 'Beta')])?.cacheKey).toBe('rep-a-1|rep-b-1');
  });

  it('falls back to the run docs\' report ids when the rows do not carry them yet (reports still downloading / failed to load)', () => {
    const pair = resolveDeepDiveCasePair([RUN_A, RUN_B], [unloadedRow('tc-1', 'Case One'), unloadedRow('tc-2', 'Case Two')]);
    expect(pair).toEqual({ testCaseId: 'tc-1', testCaseName: 'Case One', reportIdA: 'rep-a-1', reportIdB: 'rep-b-1', cacheKey: 'rep-a-1|rep-b-1' });
  });

  it('names the case from the row, else a run\'s test-case snapshot, else the id — and never looks past the rows', () => {
    const nameless = { testCaseId: 'tc-1', testCaseName: '', results: { 'run-a': { status: 'missing' }, 'run-b': { status: 'missing' } } } as any;
    expect(resolveDeepDiveCasePair([RUN_A, RUN_B], [nameless])).toMatchObject({ testCaseId: 'tc-1', testCaseName: 'Case One', reportIdA: 'rep-a-1', reportIdB: 'rep-b-1' });
    const bare = { ...RUN_A, testCaseSnapshots: undefined };
    expect(resolveDeepDiveCasePair([bare, RUN_B], [nameless])).toMatchObject({ testCaseName: 'tc-1' });
    // The rows are the visible comparison surface: a case both run docs have
    // but no row shows is not picked (no rows → no pair).
    expect(resolveDeepDiveCasePair([RUN_A, RUN_B], [])).toBeNull();
  });

  it('skips cases that have a report on only one side', () => {
    const onlyA = { ...RUN_B, results: { 'tc-1': { status: 'cancelled' }, 'tc-2': { reportId: 'rep-b-2', status: 'completed' } } };
    expect(resolveDeepDiveCasePair([RUN_A, onlyA], [unloadedRow('tc-1', 'Case One'), unloadedRow('tc-2', 'Case Two')]))
      .toMatchObject({ testCaseId: 'tc-2', reportIdA: 'rep-a-2', reportIdB: 'rep-b-2' });
  });

  it('mixes sources per side: a row id on one side, the run doc on the other', () => {
    const row = { testCaseId: 'tc-1', testCaseName: 'Case One', results: { 'run-a': { reportId: 'rep-a-1', status: 'completed' }, 'run-b': { status: 'missing' } } } as any;
    expect(resolveDeepDiveCasePair([RUN_A, RUN_B], [row])).toMatchObject({ reportIdA: 'rep-a-1', reportIdB: 'rep-b-1' });
  });

  it('returns null when no case has a report on both sides, and for anything but exactly two runs', () => {
    const disjoint = { ...RUN_B, results: { 'tc-9': { reportId: 'rep-b-9', status: 'completed' } } };
    expect(resolveDeepDiveCasePair([RUN_A, disjoint], [unloadedRow('tc-1', 'Case One')])).toBeNull();
    expect(resolveDeepDiveCasePair([RUN_A, { ...RUN_B, results: undefined }], [unloadedRow('tc-1', 'Case One')])).toBeNull();
    expect(resolveDeepDiveCasePair([RUN_A], [unloadedRow('tc-1', 'Case One')])).toBeNull();
    expect(resolveDeepDiveCasePair([RUN_A, RUN_B, RUN_A], [unloadedRow('tc-1', 'Case One')])).toBeNull();
  });
});
