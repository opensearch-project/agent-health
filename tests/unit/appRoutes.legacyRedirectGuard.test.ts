/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * GUARD: no retired (pre-evals3) route may ever be mounted as a page again.
 *
 * The REAL route table (`AppRoutes` from App.tsx) is mounted under a
 * `MemoryRouter` (the same non-data router kind the app's `BrowserRouter` is)
 * at every legacy URL. For each one the router's own state — not the source
 * text — is asserted:
 *
 *   (a) the final location is the evals3 twin,
 *   (b) it got there with a REPLACE: the history is seeded with a sentinel
 *       entry BEFORE the legacy URL, and going back must land on that
 *       sentinel — a PUSH would leave the legacy URL in the stack, so Back
 *       would hit it and bounce to the destination again instead,
 *   (c) no page component ever rendered at the legacy pathname.
 *
 * The second block enumerates EVERY registered route pattern: anything that is
 * neither an `/evaluations/*` page nor one of the explicitly listed live
 * non-evals3 pages (`/`, `/compare*`, …) must behave like (a)–(c). Adding a
 * new legacy-style page route (or re-registering an old one) without a
 * `<Navigate replace>` fails this test; a genuinely new page has to be added
 * to `LIVE_NON_EVALS3_PATTERNS` deliberately.
 */

import * as React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import {
  MemoryRouter, createRoutesFromChildren, useLocation, useNavigate, useNavigationType,
} from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';

/** Every (pathname) a page stub rendered at, in order. Reset per test. */
const pageRenders: Array<{ page: string; pathname: string }> = [];

// One stub per page module: records WHERE it rendered so a test can prove a
// page never mounted at a legacy pathname.
const stub = (name: string) => ({
  __esModule: true,
  ...Object.fromEntries(
    ['Dashboard', 'SettingsPage', 'ComparisonPage', 'AgentTracesPage', 'PerformanceOverlay',
      'CodingAgentsPage', 'EvaluatorsPage', 'EvaluatorEditPage', 'AssistantChat', 'SkillsPage',
      'BenchmarksPage4', 'TestCasesPage4', 'BenchmarkRunsPage2', 'TestCaseDetailPage', 'EvalRunsPage',
      'RunInspectorPage', 'NewRunPage', 'Layout',
    ].map(exportName => [exportName, function Page() {
      const loc = useLocation();
      // Recorded on commit (not during render) so abandoned renders don't count.
      React.useEffect(() => { pageRenders.push({ page: name, pathname: loc.pathname }); }, [loc.pathname]);
      return React.createElement('div', { 'data-testid': `page-${name}` }, loc.pathname + loc.search);
    }]),
  ),
});

jest.mock('@/components/Dashboard', () => stub('dashboard'));
jest.mock('@/components/SettingsPage', () => stub('settings'));
jest.mock('@/components/comparison/ComparisonPage', () => stub('compare'));
jest.mock('@/components/traces/AgentTracesPage', () => stub('agent-traces'));
jest.mock('@/components/PerformanceOverlay', () => stub('perf'));
jest.mock('@/components/codingAgents/CodingAgentsPage', () => stub('coding-agents'));
jest.mock('@/components/EvaluatorsPage', () => stub('evaluators'));
jest.mock('@/components/EvaluatorEditPage', () => stub('evaluator-edit'));
jest.mock('@/components/assistant-ui/AssistantChat', () => stub('assistant'));
jest.mock('@/components/skills/SkillsPage', () => stub('skills'));
jest.mock('@/components/Layout', () => stub('layout'));
jest.mock('@/components/evals3/BenchmarksPage', () => stub('evals3-benchmarks'));
jest.mock('@/components/evals3/TestCasesPage', () => stub('evals3-test-cases'));
jest.mock('@/components/evals3/BenchmarkRunsPage', () => stub('evals3-benchmark-runs'));
jest.mock('@/components/evals3/TestCaseDetailPage', () => stub('evals3-test-case-detail'));
jest.mock('@/components/evals3/EvalRunsPage', () => stub('evals3-eval-runs'));
jest.mock('@/components/evals3/RunInspectorPage', () => stub('evals3-run-inspector'));
jest.mock('@/components/evals3/NewRunPage', () => stub('evals3-new-run'));
jest.mock('@/lib/constants', () => ({ refreshConfig: jest.fn(), subscribeConfigChange: jest.fn(() => () => {}), DEFAULT_CONFIG: { agents: [], models: {} } }));
jest.mock('@/lib/theme', () => ({ initializeTheme: jest.fn() }));

// `/runs/:runId` resolves a REPORT id through storage before redirecting; give
// it a report that belongs to a reachable run so it, too, lands on the inspector.
jest.mock('@/services/storage', () => ({
  asyncRunStorage: {
    getReportById: jest.fn(async (id: string) => ({ id, testCaseId: 'tc-1', experimentId: 'bm-1', experimentRunId: 'run-1' })),
  },
  asyncBenchmarkStorage: { getById: jest.fn(async () => ({ id: 'bm-1', runs: [{ id: 'run-1' }] })) },
}));
jest.mock('@/services/client', () => ({ getEvaluationRun: jest.fn(async () => ({ id: 'run-1' })) }));

import { AppRoutes } from '../../App';
import { legacyRouteRedirects } from '../../lib/legacyRouteRedirects';

/* ------------------------------------------------------------------------ */

/** The real route table as data routes (what `<Routes>` would match). */
function appRouteObjects(): RouteObject[] {
  const routesElement = AppRoutes() as React.ReactElement<{ children: React.ReactNode }>;
  return createRoutesFromChildren(routesElement.props.children);
}

/** Flat list of every registered absolute route pattern (nested paths joined). */
function registeredPatterns(routes: RouteObject[], prefix = ''): string[] {
  const out: string[] = [];
  for (const r of routes) {
    const raw = r.path === undefined ? prefix : (r.path.startsWith('/') ? r.path : `${prefix}/${r.path}`);
    const path = raw.replace(/\/{2,}/g, '/');
    if (r.path !== undefined || r.index) out.push(path === '/*' ? '*' : (path || '/'));
    if (r.children) out.push(...registeredPatterns(r.children, path));
  }
  return out;
}

/** Fill a route pattern with sample values so it can be visited. */
function sampleUrl(pattern: string): string {
  if (pattern === '*') return '/no/such/route';
  return pattern
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => `sample-${name}`)
    .replace(/\/\*$/, '/deeper/path');
}

/** Seeded as the history entry BEFORE the visited URL (where Back must land). */
const SENTINEL = '/__guard-sentinel__';

interface Landing {
  pathname: string;
  search: string;
  /** `useNavigationType()` at the landing: POP (initial), PUSH or REPLACE. */
  historyAction: string;
  /** Location after asking the router to go back one entry. */
  afterBack: { pathname: string; search: string };
}

/** Every POP (back/forward) location the probe observed, in order. */
const backTargets: Array<{ pathname: string; search: string }> = [];

/** Observes the router from inside the tree (location, last action) and exposes `navigate`. */
function makeProbe() {
  const state = {
    pathname: '', search: '', historyAction: '',
    navigate: (null as null | ((delta: number) => void)),
  };
  function Probe() {
    const loc = useLocation();
    const action = useNavigationType();
    state.pathname = loc.pathname;
    state.search = loc.search;
    state.historyAction = action;
    state.navigate = useNavigate();
    React.useEffect(() => {
      if (action === 'POP') backTargets.push({ pathname: loc.pathname, search: loc.search });
    }, [action, loc.pathname, loc.search]);
    return null;
  }
  return { state, Probe };
}

/** Mount the real route table at `url`, let any redirect settle, report the router state. */
async function visit(url: string): Promise<Landing> {
  pageRenders.length = 0;
  const { state, Probe } = makeProbe();
  const view = render(
    React.createElement(MemoryRouter, { initialEntries: [SENTINEL, url], initialIndex: 1 },
      React.createElement(Probe), React.createElement(AppRoutes)),
  );
  // Redirects (sync `<Navigate>` or the async report lookup) settle once a
  // page stub has rendered at the current location.
  await waitFor(() => {
    expect(pageRenders.some(p => p.pathname === state.pathname)).toBe(true);
  }, { timeout: 4000 });
  const { pathname, search, historyAction } = state;
  // Go back ONE entry. After a proper REPLACE the entry before the landing is
  // the sentinel. The sentinel itself matches the `*` catch-all, so read the
  // location the back navigation produced (what `backTargets` recorded) rather
  // than whatever the catch-all redirects to afterwards.
  backTargets.length = 0;
  await act(async () => { state.navigate!(-1); });
  const afterBack = backTargets[0] ?? { pathname: state.pathname, search: state.search };
  view.unmount();
  return { pathname, search, historyAction, afterBack };
}

/** The three guard properties for a URL that must redirect. */
function expectReplaceRedirect(from: string, landed: Landing) {
  const fromPath = from.split('?')[0];
  // (a) landed on an evals3 page, somewhere other than the legacy URL
  expect(landed.pathname).not.toBe(fromPath);
  expect(landed.pathname).toMatch(/^\/evaluations\//);
  // (b) REPLACE: the router's last action was a replace, and Back lands on the
  //     sentinel seeded before the legacy URL — not on the legacy URL (a PUSH
  //     would leave it in the stack and Back would bounce through it again)
  expect(landed.historyAction).toBe('REPLACE');
  expect(landed.afterBack.pathname).toBe(SENTINEL);
  // (c) no page component ever rendered at the legacy pathname
  expect(pageRenders.filter(p => p.pathname === fromPath)).toEqual([]);
}

/* ------------------------------------------------------------------------ */

/**
 * The pre-evals3 pages this PR retired (plus the older evals3 run-detail page
 * and the bare benchmark-run URL). Listed explicitly — independent of the
 * redirect table — so deleting a table row AND mounting a page (or letting the
 * URL fall through to the dashboard catch-all) is caught, not just a missing
 * `replace`.
 */
const RETIRED_ROUTES: Array<[legacyUrl: string, evals3Path: string]> = [
  ['/benchmarks', '/evaluations/benchmarks'],
  ['/benchmarks/bm-1/runs', '/evaluations/benchmarks/bm-1/runs'],
  ['/benchmarks/bm-1/runs/run-1', '/evaluations/benchmarks/bm-1/runs/run-1/inspect'],
  ['/benchmarks/bm-1/anything/else', '/evaluations/benchmarks'],
  ['/test-cases', '/evaluations/test-cases'],
  ['/test-cases/tc-1/runs', '/evaluations/test-cases/tc-1'],
  ['/test-cases/tc-1/anything/else', '/evaluations/test-cases'],
  ['/runs/rep-1', '/evaluations/benchmarks/bm-1/runs/run-1/inspect'],
  ['/evals', '/evaluations/test-cases'],
  ['/run', '/evaluations/test-cases'],
  ['/reports', '/evaluations/benchmarks'],
  ['/experiments', '/evaluations/benchmarks'],
  ['/experiments/bm-1/runs', '/evaluations/benchmarks/bm-1/runs'],
  ['/evaluations/runs/run-1', '/evaluations/runs/run-1/inspect'],
  ['/evaluations/benchmarks/bm-1/runs/run-1', '/evaluations/benchmarks/bm-1/runs/run-1/inspect'],
];

/**
 * Non-evals3 pages that are legitimately still live. Anything else registered
 * outside `/evaluations/*` must be a replace-redirect. Add here ON PURPOSE when
 * a new top-level page is introduced.
 */
const LIVE_NON_EVALS3_PATTERNS = new Set([
  '/', '/evaluators', '/evaluators/new', '/evaluators/:evaluatorId', '/evaluators/:evaluatorId/edit',
  '/settings', '/compare', '/compare/:benchmarkId', '/agent-traces', '/skills', '/coding-agents', '/assistant',
  '*',
]);

describe('GUARD — every retired legacy route is a <Navigate replace> to its evals3 twin', () => {
  it.each(RETIRED_ROUTES)('%s → %s (replace, no page at the legacy URL)', async (from, to) => {
    const landed = await visit(from);
    expectReplaceRedirect(from, landed);
    expect(landed.pathname).toBe(to);
  });

  it('carries the legacy query string over to the evals3 page', async () => {
    const landed = await visit('/benchmarks/bm-1/runs/run-1?testCase=tc-9&tab=traces');
    expectReplaceRedirect('/benchmarks/bm-1/runs/run-1', landed);
    expect(landed.pathname).toBe('/evaluations/benchmarks/bm-1/runs/run-1/inspect');
    expect(new URLSearchParams(landed.search).get('testCase')).toBe('tc-9');
    expect(new URLSearchParams(landed.search).get('tab')).toBe('traces');
  });

  it('every row of the redirect table is actually mounted by App.tsx', () => {
    const patterns = new Set(registeredPatterns(appRouteObjects()));
    for (const { pattern } of legacyRouteRedirects) expect(patterns).toContain(pattern);
    expect(patterns).toContain('/runs/:runId');
  });

  it('no route pattern is registered twice (a later duplicate would be unreachable dead code, an earlier one a regression)', () => {
    const patterns = registeredPatterns(appRouteObjects());
    const dupes = patterns.filter((p, i) => patterns.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });
});

describe('GUARD — no registered route outside /evaluations/* renders a page unless listed as live', () => {
  const nonEvals3 = registeredPatterns(appRouteObjects())
    .filter(p => !p.startsWith('/evaluations/') && !LIVE_NON_EVALS3_PATTERNS.has(p));

  it('finds the legacy patterns (sanity: the enumeration sees the real table)', () => {
    expect(nonEvals3).toEqual(expect.arrayContaining(['/benchmarks', '/test-cases', '/runs/:runId']));
  });

  it.each(nonEvals3.map(p => [p]))('%s is a replace-redirect to an evals3 page', async (pattern) => {
    const from = sampleUrl(pattern);
    const landed = await visit(from);
    expectReplaceRedirect(from, landed);
  });

  it('the live non-evals3 pages still render in place (the allowlist is not a dead list)', async () => {
    for (const pattern of ['/', '/settings', '/compare/:benchmarkId', '/agent-traces', '/evaluators/:evaluatorId/edit']) {
      const from = sampleUrl(pattern);
      const landed = await visit(from);
      expect(landed.pathname).toBe(from);
      expect(landed.historyAction).toBe('POP');
      expect(landed.afterBack.pathname).toBe(SENTINEL);
      expect(pageRenders.some(p => p.pathname === from)).toBe(true);
    }
  });

  it('the catch-all sends unknown URLs to the dashboard with a replace', async () => {
    const landed = await visit('/no/such/route');
    expect(landed.pathname).toBe('/');
    expect(landed.historyAction).toBe('REPLACE');
    expect(landed.afterBack.pathname).toBe(SENTINEL);
  });
});
