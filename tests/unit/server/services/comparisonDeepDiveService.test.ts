/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive service.
 *
 * Guards the things most likely to silently regress:
 *   1. the SYSTEM_PROMPT actually instructs the agent to hunt + report ERRORS
 *      on whichever case(s) it actually traces (this content was lost once
 *      and re-added);
 *   2. buildUserPrompt threads each run's identity (key, runId, label) for
 *      the DEFAULT case, AND the full A-vs-B results table (round 2), AND
 *      (this round) makes clear the agent can trace ANY case by testCaseId
 *      — not just the one representative default;
 *   3. the exactly-2-runs guard on the public entry point;
 *   4. the optional systemPrompt override plumbing (round 1's Change 4).
 */

import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  generateComparisonDeepDive,
  type ComparisonRunInput,
  type ComparisonRowSummary,
} from '@/server/services/comparisonDeepDiveService';

describe('comparisonDeepDiveService — SYSTEM_PROMPT', () => {
  it('instructs the agent to hunt for errors on EACH side of whichever case(s) it traces', () => {
    expect(SYSTEM_PROMPT).toMatch(/ERRORS/);
    expect(SYSTEM_PROMPT).toMatch(/hunt for failures on EACH side/i);
    // Mentions concrete error signals so the model knows what to look for.
    expect(SYSTEM_PROMPT).toMatch(/otel\.status_code=ERROR/);
    expect(SYSTEM_PROMPT).toMatch(/exception\./);
    expect(SYSTEM_PROMPT).toMatch(/failed or were retried/i);
  });

  it('requires an always-present Errors bullet covering side A, B, or both', () => {
    expect(SYSTEM_PROMPT).toMatch(/\*\*Errors\*\* bullet that is ALWAYS present/);
    expect(SYSTEM_PROMPT).toMatch(/side A, side B, or both/);
    // And an explicit "no errors observed" when clean (never omitted).
    expect(SYSTEM_PROMPT).toMatch(/no errors observed/);
    expect(SYSTEM_PROMPT).toMatch(/never silently omit/i);
  });

  it('analyzes the comparison AS A WHOLE, selectively picking rows from the results table (not a fixed rubric, not every row)', () => {
    expect(SYSTEM_PROMPT).toMatch(/RESULTS TABLE/);
    expect(SYSTEM_PROMPT).toMatch(/SELECTIVELY pick the rows that actually matter/);
    expect(SYSTEM_PROMPT).toMatch(/Do NOT force a fixed rubric onto every row/);
    expect(SYSTEM_PROMPT).toMatch(/do NOT walk the table top to bottom/);
    expect(SYSTEM_PROMPT).toMatch(/COMPARISON AS A WHOLE/);
    // Comparison-wide/run-level language is expected, not forbidden.
    expect(SYSTEM_PROMPT).not.toMatch(/CASE, never RUN/);
    expect(SYSTEM_PROMPT).not.toMatch(/NEVER write "Run A" \/ "Run B"/);
  });

  it('makes trace tools available for ANY case in the table, not one fixed representative case (this round)', () => {
    // Owner: "we don't want the data only limited to a single test... I want
    // the wide one" — the trace tools are now case-selectable.
    expect(SYSTEM_PROMPT).toMatch(/REAL OpenTelemetry data for ANY case in the table/i);
    expect(SYSTEM_PROMPT).toMatch(/NOT limited to a single case/i);
    expect(SYSTEM_PROMPT).toMatch(/caseId\?/);
    expect(SYSTEM_PROMPT).toMatch(/ECHOES BACK the caseId and runId/);
    expect(SYSTEM_PROMPT).not.toMatch(/scoped to exactly ONE representative case/);
    expect(SYSTEM_PROMPT).not.toMatch(/CANNOT inspect any case in the table other than the traced one/);
  });

  it('still asks for span citations (now caseId-qualified) + a tight markdown deep-dive', () => {
    expect(SYSTEM_PROMPT).toMatch(/span:<caseId>:<runId>:<spanId>/);
    expect(SYSTEM_PROMPT).not.toMatch(/\(span:<runId>:<spanId>\)/);
    expect(SYSTEM_PROMPT).toMatch(/headline verdict/i);
    expect(SYSTEM_PROMPT).toMatch(/~350 words/);
  });

  it('instructs the agent to record a chart and follow-up experiment suggestions before writing', () => {
    expect(SYSTEM_PROMPT).toMatch(/record_deepdive_extras` AT MOST ONCE/);
    expect(SYSTEM_PROMPT).toMatch(/grounded in what you actually found/i);
    expect(SYSTEM_PROMPT).toMatch(/omit either or both rather than fabricating/i);
  });

  it('instructs the agent to never write a bare "N/N" judge score (misreads as a case count) using the "N/100 judge score" wording', () => {
    expect(SYSTEM_PROMPT).toMatch(/"N\/100 judge score"/);
    expect(SYSTEM_PROMPT).toMatch(/a 92\/100 judge score/);
    expect(SYSTEM_PROMPT).toMatch(/NEVER a bare "N\/N"/);
    expect(SYSTEM_PROMPT).toMatch(/misreads as a case count/i);
  });
});

describe('comparisonDeepDiveService — buildUserPrompt', () => {
  const runs: ComparisonRunInput[] = [
    {
      key: 'A',
      label: 'aos-oncall (Claude Code)',
      runId: 'subprocess-AAA',
      passFailStatus: 'passed',
      accuracy: 100,
      toolNames: ['Skill', 'mcp__builder__read_ticket'],
      durationMs: 211000,
      finalOutput: 'Root cause: protected index finding.',
    },
    {
      key: 'B',
      label: 'cp-oncall (Claude Code)',
      runId: 'subprocess-BBB',
      passFailStatus: 'failed',
      durationMs: 266000,
    },
  ];

  it('labels both sides for the default case (no "Run A"/"Run B" framing)', () => {
    const prompt = buildUserPrompt(runs, undefined, 'tc-default');
    expect(prompt).toMatch(/## A — aos-oncall \(Claude Code\) \(default case\)/);
    expect(prompt).toMatch(/## B — cp-oncall \(Claude Code\) \(default case\)/);
    expect(prompt).not.toMatch(/## Run [AB]/);
    expect(prompt).toContain('subprocess-AAA');
    expect(prompt).toContain('subprocess-BBB');
  });

  it('includes per-run outcome + duration context when known', () => {
    const prompt = buildUserPrompt(runs, undefined, 'tc-default');
    expect(prompt).toMatch(/outcome: passed \(judgeScore: 100 on a 0-100 scale\)/);
    expect(prompt).toMatch(/outcome: failed/);
    expect(prompt).toMatch(/211\.0s/);
    expect(prompt).toMatch(/266\.0s/);
  });

  it('names the default case and tells the agent it can trace ANY row by caseId', () => {
    const prompt = buildUserPrompt(runs, undefined, 'tc-default');
    expect(prompt).toMatch(/Default case \(used by query_spans\/query_logs only when you omit caseId\): tc-default/);
    expect(prompt).toMatch(/query_spans \/ query_logs with an explicit caseId on BOTH "A" and "B"/);
  });

  it('omits the results-table section entirely when no rows are supplied (back-compat)', () => {
    const prompt = buildUserPrompt(runs, undefined, 'tc-default');
    expect(prompt).not.toMatch(/Full results table/);
  });

  it('omits the results-table section for an empty rows array too', () => {
    const prompt = buildUserPrompt(runs, [], 'tc-default');
    expect(prompt).not.toMatch(/Full results table/);
  });

  it('renders the full A-vs-B results table (with bracketed testCaseIds) when rows are supplied, ahead of the default-case section', () => {
    const rows: ComparisonRowSummary[] = [
      { testCaseId: 'tc-1', testCaseName: 'Disagreement case', a: { passFailStatus: 'passed', score: 92, reportId: 'rep-1a' }, b: { passFailStatus: 'failed', score: 41, reportId: 'rep-1b' } },
      { testCaseId: 'tc-2', testCaseName: 'Both pass', a: { passFailStatus: 'passed', score: 88 }, b: { passFailStatus: 'passed', score: 90 } },
      { testCaseId: 'tc-3', testCaseName: 'B never ran this one', a: { passFailStatus: 'passed', score: 75 } },
    ];
    const prompt = buildUserPrompt(runs, rows, 'tc-default');
    expect(prompt).toMatch(/## Full results table — 3 compared cases \(A vs B\)/);
    expect(prompt).toContain('- [tc-1] Disagreement case — A: passed (92/100) · B: failed (41/100)');
    expect(prompt).toContain('- [tc-2] Both pass — A: passed (88/100) · B: passed (90/100)');
    expect(prompt).toContain('- [tc-3] B never ran this one — A: passed (75/100) · B: not run');
    // The results table comes BEFORE the default-case per-run sections.
    expect(prompt.indexOf('Full results table')).toBeLessThan(prompt.indexOf('## A — aos-oncall'));
    // Tells the agent to pass testCaseId as caseId — the wide-tracing contract.
    expect(prompt).toMatch(/pass that exact string as `caseId`/);
  });

  it('pluralizes "case" correctly for exactly 1 row', () => {
    const rows: ComparisonRowSummary[] = [
      { testCaseId: 'tc-1', testCaseName: 'Only one', a: { passFailStatus: 'passed', score: 100 } },
    ];
    const prompt = buildUserPrompt(runs, rows, 'tc-1');
    expect(prompt).toMatch(/## Full results table — 1 compared case \(A vs B\)/);
  });
});

describe('comparisonDeepDiveService — generateComparisonDeepDive guard', () => {
  it('rejects when not exactly 2 runs (before any SDK/model work)', async () => {
    await expect(
      generateComparisonDeepDive({
        runs: [{ key: 'A', label: 'only one' }],
        defaultCaseId: 'tc-1',
        caseReports: new Map(),
        getReport: async () => null,
      })
    ).rejects.toThrow(/exactly 2 runs/);
    await expect(
      generateComparisonDeepDive({
        runs: [
          { key: 'A', label: 'a' },
          { key: 'B', label: 'b' },
          { key: 'C', label: 'c' },
        ],
        defaultCaseId: 'tc-1',
        caseReports: new Map(),
        getReport: async () => null,
      })
    ).rejects.toThrow(/exactly 2 runs/);
  });
});

describe('comparisonDeepDiveService — optional systemPrompt override (browser-cache-only) + comparison-wide plumbing', () => {
  // The pi SDK is an optional dependency, dynamically imported and not
  // installed in this test environment — mock it (virtual module) so we can
  // capture exactly what `systemPromptOverride()` / `extensionFactories` the
  // service hands to the resource loader, and what prompt it sends.
  const runs: ComparisonRunInput[] = [
    { key: 'A', label: 'agent A', runId: 'run-a', reportId: 'rep-a' },
    { key: 'B', label: 'agent B', runId: 'run-b', reportId: 'rep-b' },
  ];
  const baseOpts = { defaultCaseId: 'tc-default', caseReports: new Map(), getReport: async () => null };

  const mockModel = { provider: 'mock', id: 'mock.claude-sonnet-4' };

  let capturedResourceLoaderOpts: any;
  let capturedPrompt: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    capturedResourceLoaderOpts = undefined;
    capturedPrompt = undefined;
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession: jest.fn(async () => ({
          session: {
            prompt: jest.fn(async (p: string) => { capturedPrompt = p; }),
            messages: [
              { role: 'assistant', content: [{ type: 'text', text: 'mock deep-dive markdown' }] },
            ],
          },
        })),
        SessionManager: { inMemory: jest.fn(() => ({})) },
        AuthStorage: { create: jest.fn(() => ({})) },
        ModelRegistry: {
          create: jest.fn(() => ({
            getAvailable: jest.fn(async () => [mockModel]),
          })),
        },
        DefaultResourceLoader: jest.fn().mockImplementation((opts: any) => {
          capturedResourceLoaderOpts = opts;
          return { reload: jest.fn(async () => {}) };
        }),
        getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
      }),
      { virtual: true }
    );
  });

  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
  });

  it('uses the built-in SYSTEM_PROMPT when no override is passed', async () => {
    const { generateComparisonDeepDive: generate, SYSTEM_PROMPT: defaultPrompt } =
      require('@/server/services/comparisonDeepDiveService');
    const result = await generate({ runs, modelId: mockModel.id, ...baseOpts });
    expect(capturedResourceLoaderOpts.systemPromptOverride()).toBe(defaultPrompt);
    expect(result.markdown).toBe('mock deep-dive markdown');
    // visitedCases defaults to an empty array when the agent never called query_spans/query_logs.
    expect(result.visitedCases).toEqual([]);
  });

  it('threads a caller-supplied systemPrompt into systemPromptOverride instead of the default', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    const custom = 'CUSTOM PROMPT: focus only on token usage.';
    await generate({ runs, modelId: mockModel.id, systemPrompt: custom, ...baseOpts });
    expect(capturedResourceLoaderOpts.systemPromptOverride()).toBe(custom);
  });

  it('falls back to the default when systemPrompt is only whitespace', async () => {
    const { generateComparisonDeepDive: generate, SYSTEM_PROMPT: defaultPrompt } =
      require('@/server/services/comparisonDeepDiveService');
    await generate({ runs, modelId: mockModel.id, systemPrompt: '   ', ...baseOpts });
    expect(capturedResourceLoaderOpts.systemPromptOverride()).toBe(defaultPrompt);
  });

  it('threads the optional rows summary into the user prompt sent to the agent', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    const rows: ComparisonRowSummary[] = [
      { testCaseId: 'tc-1', testCaseName: 'Disagreement case', a: { passFailStatus: 'passed', score: 92 }, b: { passFailStatus: 'failed', score: 41 } },
    ];
    await generate({ runs, modelId: mockModel.id, rows, ...baseOpts });
    expect(capturedPrompt).toContain('Full results table');
    expect(capturedPrompt).toContain('Disagreement case');
  });

  it('omits the results-table section when no rows are passed', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    await generate({ runs, modelId: mockModel.id, ...baseOpts });
    expect(capturedPrompt).not.toContain('Full results table');
  });

  it('registers exactly one extensionFactory (the comparison-wide trace tools)', () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    return generate({ runs, modelId: mockModel.id, ...baseOpts }).then(() => {
      expect(capturedResourceLoaderOpts.extensionFactories).toHaveLength(1);
      expect(typeof capturedResourceLoaderOpts.extensionFactories[0]).toBe('function');
    });
  });
});

describe('comparisonDeepDiveService — DEEP_DIVE_DEADLINE_MS (owner bug: "What\'s actually different" appeared to hang forever)', () => {
  // Same pi-SDK mock pattern as above, but `session.prompt()` never resolves
  // — simulating a genuinely stuck agent loop (Bedrock throttling with no
  // bounded retry, a runaway tool-call cycle, etc.). Without a server-side
  // deadline this would hold the HTTP response open indefinitely.
  const runs: ComparisonRunInput[] = [
    { key: 'A', label: 'agent A', runId: 'run-a', reportId: 'rep-a' },
    { key: 'B', label: 'agent B', runId: 'run-b', reportId: 'rep-b' },
  ];
  const baseOpts = { defaultCaseId: 'tc-default', caseReports: new Map(), getReport: async () => null };
  const mockModel = { provider: 'mock', id: 'mock.claude-sonnet-4' };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession: jest.fn(async () => ({
          session: {
            // Never resolves — the agent loop is stuck.
            prompt: jest.fn(() => new Promise(() => {})),
            messages: [],
          },
        })),
        SessionManager: { inMemory: jest.fn(() => ({})) },
        AuthStorage: { create: jest.fn(() => ({})) },
        ModelRegistry: {
          create: jest.fn(() => ({
            getAvailable: jest.fn(async () => [mockModel]),
          })),
        },
        DefaultResourceLoader: jest.fn().mockImplementation(() => ({ reload: jest.fn(async () => {}) })),
        getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
      }),
      { virtual: true }
    );
  });

  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.useRealTimers();
  });

  it('rejects with a clear, retryable timeout error instead of hanging forever once the deadline elapses', async () => {
    const { generateComparisonDeepDive: generate, DEEP_DIVE_DEADLINE_MS } = require('@/server/services/comparisonDeepDiveService');
    expect(DEEP_DIVE_DEADLINE_MS).toBeGreaterThan(0);

    const promise = generate({ runs, modelId: mockModel.id, ...baseOpts });
    const assertion = expect(promise).rejects.toThrow(
      new RegExp(`timed out after ${Math.round(DEEP_DIVE_DEADLINE_MS / 1000)}s`)
    );
    await jest.advanceTimersByTimeAsync(DEEP_DIVE_DEADLINE_MS);
    await assertion;
  });
});
