/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive service.
 *
 * Guards the things most likely to silently regress:
 *   1. the SYSTEM_PROMPT actually instructs the agent to hunt + report ERRORS
 *      on the traced case (this content was lost once and re-added);
 *   2. buildUserPrompt threads each run's identity (key, runId, label) so the
 *      agent can cite spans with the correct runId, AND (this round) threads
 *      the full A-vs-B results table so the default prompt can analyze the
 *      comparison as a whole, not just the one traced case;
 *   3. the exactly-2-runs guard on the public entry point;
 *   4. the optional systemPrompt override plumbing (Change 4, prior round).
 */

import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  generateComparisonDeepDive,
  type ComparisonRunInput,
  type ComparisonRowSummary,
} from '@/server/services/comparisonDeepDiveService';

describe('comparisonDeepDiveService — SYSTEM_PROMPT', () => {
  it('instructs the agent to hunt for errors on EACH side of the traced case', () => {
    expect(SYSTEM_PROMPT).toMatch(/ERRORS/);
    expect(SYSTEM_PROMPT).toMatch(/hunt for failures on EACH side/i);
    // Mentions concrete error signals so the model knows what to look for.
    expect(SYSTEM_PROMPT).toMatch(/otel\.status_code=ERROR/);
    expect(SYSTEM_PROMPT).toMatch(/exception\./);
    expect(SYSTEM_PROMPT).toMatch(/failed or were retried/i);
  });

  it('requires an always-present Errors bullet for the traced case, covering side A, B, or both', () => {
    expect(SYSTEM_PROMPT).toMatch(/\*\*Errors\*\* bullet for the TRACED CASE that is ALWAYS present/);
    expect(SYSTEM_PROMPT).toMatch(/side A, side B, or both/);
    // And an explicit per-side "no errors observed" when clean (never omitted).
    expect(SYSTEM_PROMPT).toMatch(/no errors observed/);
    expect(SYSTEM_PROMPT).toMatch(/never silently omit/i);
  });

  it('analyzes the comparison AS A WHOLE, selectively picking rows from the results table (not a fixed rubric, not every row)', () => {
    // Round 2 owner request: the default prompt now takes into account ALL
    // compared cases via a results table, selectively surfacing disagreements/
    // score gaps/category patterns — a real shift from the prior "ONE CASE
    // only" scope, so the old "CASE, never RUN" absolute rule no longer fits
    // (comparison-wide, run-level framing is now expected).
    expect(SYSTEM_PROMPT).toMatch(/RESULTS TABLE/);
    expect(SYSTEM_PROMPT).toMatch(/SELECTIVELY pick the rows that actually matter/);
    expect(SYSTEM_PROMPT).toMatch(/Do NOT force a fixed rubric onto every row/);
    expect(SYSTEM_PROMPT).toMatch(/do NOT walk the table top to bottom/);
    expect(SYSTEM_PROMPT).toMatch(/COMPARISON AS A WHOLE/);
    // Explicitly no longer forbids run-level language — the opposite of the
    // old rule.
    expect(SYSTEM_PROMPT).toMatch(/fine to discuss run-level \/ comparison-wide patterns/);
    expect(SYSTEM_PROMPT).not.toMatch(/CASE, never RUN/);
    expect(SYSTEM_PROMPT).not.toMatch(/NEVER write "Run A" \/ "Run B"/);
  });

  it('scopes the span/log tools to exactly ONE traced case and forbids claiming trace detail elsewhere', () => {
    expect(SYSTEM_PROMPT).toMatch(/scoped to exactly ONE representative case/);
    expect(SYSTEM_PROMPT).toMatch(/CANNOT inspect any case in the table other than the traced one/);
    expect(SYSTEM_PROMPT).toMatch(/never claim to have traced a case you did not query/);
  });

  it('still asks for span citations + a tight markdown deep-dive', () => {
    expect(SYSTEM_PROMPT).toMatch(/span:<runId>:<spanId>/);
    expect(SYSTEM_PROMPT).toMatch(/headline verdict/i);
    // Word cap bumped up this round (280 -> 350) to make room for the
    // comparison-wide framing.
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

  it('labels both sides and threads each runId for span citations', () => {
    const prompt = buildUserPrompt(runs);
    expect(prompt).toMatch(/## A — aos-oncall \(Claude Code\)/);
    expect(prompt).toMatch(/## B — cp-oncall \(Claude Code\)/);
    // Never the "Run A"/"Run B" framing in the per-run header itself.
    expect(prompt).not.toMatch(/## Run [AB]/);
    // The runId is explicitly surfaced "use this in span: citations".
    expect(prompt).toContain('subprocess-AAA');
    expect(prompt).toContain('subprocess-BBB');
    expect(prompt).toMatch(/use this in span: citations/i);
  });

  it('includes per-run outcome + duration context when known', () => {
    const prompt = buildUserPrompt(runs);
    expect(prompt).toMatch(/outcome: passed \(judgeScore: 100 on a 0-100 scale\)/);
    expect(prompt).toMatch(/outcome: failed/);
    expect(prompt).toMatch(/211\.0s/);
    expect(prompt).toMatch(/266\.0s/);
  });

  it('tells the agent to inspect BOTH runs before writing', () => {
    expect(buildUserPrompt(runs)).toMatch(/query_spans \/ query_logs on BOTH/);
  });

  it('omits the results-table section entirely when no rows are supplied (back-compat)', () => {
    const prompt = buildUserPrompt(runs);
    expect(prompt).not.toMatch(/Full results table/);
  });

  it('omits the results-table section for an empty rows array too', () => {
    const prompt = buildUserPrompt(runs, []);
    expect(prompt).not.toMatch(/Full results table/);
  });

  it('renders the full A-vs-B results table when rows are supplied, ahead of the traced-case section', () => {
    const rows: ComparisonRowSummary[] = [
      { testCaseId: 'tc-1', testCaseName: 'Disagreement case', a: { passFailStatus: 'passed', score: 92 }, b: { passFailStatus: 'failed', score: 41 } },
      { testCaseId: 'tc-2', testCaseName: 'Both pass', a: { passFailStatus: 'passed', score: 88 }, b: { passFailStatus: 'passed', score: 90 } },
      { testCaseId: 'tc-3', testCaseName: 'B never ran this one', a: { passFailStatus: 'passed', score: 75 } },
    ];
    const prompt = buildUserPrompt(runs, rows);
    expect(prompt).toMatch(/## Full results table — 3 compared cases \(A vs B\)/);
    expect(prompt).toContain('- Disagreement case — A: passed (92/100) · B: failed (41/100)');
    expect(prompt).toContain('- Both pass — A: passed (88/100) · B: passed (90/100)');
    expect(prompt).toContain('- B never ran this one — A: passed (75/100) · B: not run');
    // The results table comes BEFORE the traced-case per-run sections.
    expect(prompt.indexOf('Full results table')).toBeLessThan(prompt.indexOf('## A — aos-oncall'));
  });

  it('pluralizes "case" correctly for exactly 1 row', () => {
    const rows: ComparisonRowSummary[] = [
      { testCaseId: 'tc-1', testCaseName: 'Only one', a: { passFailStatus: 'passed', score: 100 } },
    ];
    const prompt = buildUserPrompt(runs, rows);
    expect(prompt).toMatch(/## Full results table — 1 compared case \(A vs B\)/);
  });
});

describe('comparisonDeepDiveService — generateComparisonDeepDive guard', () => {
  it('rejects when not exactly 2 runs (before any SDK/model work)', async () => {
    await expect(
      generateComparisonDeepDive({ runs: [{ key: 'A', label: 'only one' }] })
    ).rejects.toThrow(/exactly 2 runs/);
    await expect(
      generateComparisonDeepDive({
        runs: [
          { key: 'A', label: 'a' },
          { key: 'B', label: 'b' },
          { key: 'C', label: 'c' },
        ],
      })
    ).rejects.toThrow(/exactly 2 runs/);
  });
});

describe('comparisonDeepDiveService — optional systemPrompt override (Change 4, browser-cache-only)', () => {
  // The pi SDK is an optional dependency, dynamically imported and not
  // installed in this test environment — mock it (virtual module) so we can
  // capture exactly what `systemPromptOverride()` the service hands to the
  // resource loader, which is the one piece of new plumbing worth a unit test
  // here (the server route owns request validation; see the integration test).
  const runs: ComparisonRunInput[] = [
    { key: 'A', label: 'agent A', runId: 'run-a' },
    { key: 'B', label: 'agent B', runId: 'run-b' },
  ];

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
    const result = await generate({ runs, modelId: mockModel.id });
    expect(capturedResourceLoaderOpts.systemPromptOverride()).toBe(defaultPrompt);
    expect(result.markdown).toBe('mock deep-dive markdown');
  });

  it('threads a caller-supplied systemPrompt into systemPromptOverride instead of the default', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    const custom = 'CUSTOM PROMPT: focus only on token usage.';
    await generate({ runs, modelId: mockModel.id, systemPrompt: custom });
    expect(capturedResourceLoaderOpts.systemPromptOverride()).toBe(custom);
  });

  it('falls back to the default when systemPrompt is only whitespace', async () => {
    const { generateComparisonDeepDive: generate, SYSTEM_PROMPT: defaultPrompt } =
      require('@/server/services/comparisonDeepDiveService');
    await generate({ runs, modelId: mockModel.id, systemPrompt: '   ' });
    expect(capturedResourceLoaderOpts.systemPromptOverride()).toBe(defaultPrompt);
  });

  it('threads the optional rows summary into the user prompt sent to the agent', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    const rows: ComparisonRowSummary[] = [
      { testCaseId: 'tc-1', testCaseName: 'Disagreement case', a: { passFailStatus: 'passed', score: 92 }, b: { passFailStatus: 'failed', score: 41 } },
    ];
    await generate({ runs, modelId: mockModel.id, rows });
    expect(capturedPrompt).toContain('Full results table');
    expect(capturedPrompt).toContain('Disagreement case');
  });

  it('omits the results-table section when no rows are passed', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    await generate({ runs, modelId: mockModel.id });
    expect(capturedPrompt).not.toContain('Full results table');
  });
});
