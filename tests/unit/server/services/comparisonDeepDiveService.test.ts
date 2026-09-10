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

describe('comparisonDeepDiveService — model selection (owner: "I want it to be Fable 5.1")', () => {
  const runs: ComparisonRunInput[] = [
    { key: 'A', label: 'agent A', runId: 'run-a', reportId: 'rep-a' },
    { key: 'B', label: 'agent B', runId: 'run-b', reportId: 'rep-b' },
  ];
  const baseOpts = { defaultCaseId: 'tc-default', caseReports: new Map(), getReport: async () => null };
  const OLD_REGION = process.env.AWS_REGION;
  // Registry snapshot (subset) from the machine that motivated the change.
  const registry = [
    { provider: 'amazon-bedrock', id: 'anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { provider: 'amazon-bedrock', id: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5 (Global)' },
    { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (US)' },
    { provider: 'amazon-bedrock', id: 'us.anthropic.claude-opus-4-8', name: 'Claude Opus 4.8 (US)' },
    { provider: 'amazon-bedrock', id: 'eu.anthropic.claude-fable-5', name: 'Claude Fable 5 (EU)' },
    { provider: 'amazon-bedrock', id: 'jp.anthropic.claude-opus-4-8', name: 'Claude Opus 4.8 (JP)' },
    { provider: 'amazon-bedrock', id: 'us.anthropic.claude-fable-5', name: 'Claude Fable 5 (US)' },
    { provider: 'amazon-bedrock', id: 'us.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1 (US)' },
    { provider: 'amazon-bedrock', id: 'openai.gpt-5.5', name: 'GPT-5.5' },
  ];
  let capturedSessionOpts: any;

  beforeEach(() => {
    process.env.AWS_REGION = 'us-east-1';
    jest.resetModules();
    capturedSessionOpts = undefined;
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession: jest.fn(async (opts: any) => {
          capturedSessionOpts = opts;
          return {
            session: {
              prompt: jest.fn(async () => {}),
              messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
            },
          };
        }),
        SessionManager: { inMemory: jest.fn(() => ({})) },
        AuthStorage: { create: jest.fn(() => ({})) },
        ModelRegistry: { create: jest.fn(() => ({ getAvailable: jest.fn(async () => registry) })) },
        DefaultResourceLoader: jest.fn().mockImplementation(() => ({ reload: jest.fn(async () => {}) })),
        getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
      }),
      { virtual: true }
    );
  });
  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    process.env.AWS_REGION = OLD_REGION;
  });

  it('DEFAULT (no modelId) runs on Fable 5.1 — not the 4.x Sonnet the judge fallback would pick', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    const result = await generate({ runs, ...baseOpts });
    expect(capturedSessionOpts.model.id).toBe('us.anthropic.claude-fable-5-1');
    expect(result.modelId).toBe('amazon-bedrock/us.anthropic.claude-fable-5-1');
  });

  it('the default is a PIN on Fable 5.1, not just "highest score": a hypothetical newer 5.x in the registry does not displace it', async () => {
    const { resolveDefaultDeepDiveModel, DEEP_DIVE_PREFERRED_MODEL_ID } = require('@/server/services/comparisonDeepDiveService');
    expect(DEEP_DIVE_PREFERRED_MODEL_ID).toBe('anthropic.claude-fable-5-1');
    const withNewer = [...registry, { provider: 'amazon-bedrock', id: 'us.anthropic.claude-fable-5-2', name: 'Claude Fable 5.2 (US)' }];
    expect(resolveDefaultDeepDiveModel(withNewer)?.id).toBe('us.anthropic.claude-fable-5-1');
    // Only a global./other-region Fable 5.1 profile credentialed → still pinned to it.
    const onlyGlobal = registry.filter((m) => m.id !== 'us.anthropic.claude-fable-5-1').concat({ provider: 'amazon-bedrock', id: 'global.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1 (Global)' });
    expect(resolveDefaultDeepDiveModel(onlyGlobal)?.id).toBe('global.anthropic.claude-fable-5-1');
  });

  it('falls back to the newest-Claude heuristic only when NO Fable 5.1 profile is credentialed', async () => {
    const { resolveDefaultDeepDiveModel } = require('@/server/services/comparisonDeepDiveService');
    const noFable51 = registry.filter((m) => !m.id.includes('fable-5-1'));
    expect(resolveDefaultDeepDiveModel(noFable51)?.id).toBe('us.anthropic.claude-fable-5');
    const only4x = noFable51.filter((m) => !m.id.includes('fable'));
    expect(resolveDefaultDeepDiveModel(only4x)?.id).toMatch(/claude-(sonnet|opus)-4/);
    expect(resolveDefaultDeepDiveModel([])).toBeUndefined();
  });

  it('AH_DEEP_DIVE_MODEL_ID overrides the pin per server', async () => {
    const OLD = process.env.AH_DEEP_DIVE_MODEL_ID;
    process.env.AH_DEEP_DIVE_MODEL_ID = 'anthropic.claude-opus-4-8';
    try {
      const { resolveDefaultDeepDiveModel, selectDeepDiveModelOptions } = require('@/server/services/comparisonDeepDiveService');
      expect(resolveDefaultDeepDiveModel(registry)?.id).toBe('us.anthropic.claude-opus-4-8');
      expect(selectDeepDiveModelOptions(registry).defaultId).toBe('us.anthropic.claude-opus-4-8');
    } finally {
      if (OLD === undefined) delete process.env.AH_DEEP_DIVE_MODEL_ID; else process.env.AH_DEEP_DIVE_MODEL_ID = OLD;
    }
  });

  it('an explicit modelId wins over the default and is echoed in result.modelId', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    const result = await generate({ runs, modelId: 'us.anthropic.claude-sonnet-4-6', ...baseOpts });
    expect(capturedSessionOpts.model.id).toBe('us.anthropic.claude-sonnet-4-6');
    expect(result.modelId).toBe('amazon-bedrock/us.anthropic.claude-sonnet-4-6');
  });

  it('an explicit modelId this server cannot invoke fails loudly instead of silently running a different model', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    await expect(generate({ runs, modelId: 'us.anthropic.claude-mythos-9', ...baseOpts })).rejects.toThrow(
      /requested model "us.anthropic.claude-mythos-9" is not available/
    );
    expect(capturedSessionOpts).toBeUndefined();
  });

  it('does not cap the session (no maxTokens / thinkingLevel override) — Fable 5.1 keeps its 128k output + registry-default reasoning', async () => {
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');
    await generate({ runs, ...baseOpts });
    expect(capturedSessionOpts).not.toHaveProperty('maxTokens');
    expect(capturedSessionOpts).not.toHaveProperty('thinkingLevel');
  });

  describe('selectDeepDiveModelOptions (GET /api/comparison/deep-dive/models payload)', () => {
    it('lists only Claude models on a usable (region or global) inference profile, best-first, with Fable 5.1 as defaultId', () => {
      const { selectDeepDiveModelOptions } = require('@/server/services/comparisonDeepDiveService');
      const { models, defaultId } = selectDeepDiveModelOptions(registry);
      expect(defaultId).toBe('us.anthropic.claude-fable-5-1');
      expect(models[0]).toEqual({ provider: 'amazon-bedrock', id: 'us.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1 (US)' });
      const ids = models.map((m: any) => m.id);
      expect(ids).not.toContain('anthropic.claude-sonnet-4-6'); // bare id — fails on-demand
      expect(ids).not.toContain('eu.anthropic.claude-fable-5'); // wrong region
      expect(ids).not.toContain('jp.anthropic.claude-opus-4-8'); // wrong region
      expect(ids).not.toContain('openai.gpt-5.5'); // not Claude
      expect(ids).toContain('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(ids.indexOf('us.anthropic.claude-fable-5')).toBeLessThan(ids.indexOf('us.anthropic.claude-sonnet-4-6'));
    });
    it('returns an empty list / null default when nothing usable is available', () => {
      const { selectDeepDiveModelOptions } = require('@/server/services/comparisonDeepDiveService');
      expect(selectDeepDiveModelOptions([{ provider: 'x', id: 'openai.gpt-5.5' }])).toEqual({ models: [], defaultId: null });
    });
  });

  it('listDeepDiveModels reads the live registry and never throws when the pi SDK is missing', async () => {
    const { listDeepDiveModels } = require('@/server/services/comparisonDeepDiveService');
    const live = await listDeepDiveModels();
    expect(live.defaultId).toBe('us.anthropic.claude-fable-5-1');
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.resetModules();
    jest.doMock('@earendil-works/pi-coding-agent', () => { throw new Error('Cannot find module'); }, { virtual: true });
    const { listDeepDiveModels: listWithoutSdk } = require('@/server/services/comparisonDeepDiveService');
    await expect(listWithoutSdk()).resolves.toEqual({ models: [], defaultId: null });
  });
});

describe('comparisonDeepDiveService — DEEP_DIVE_DEADLINE_MS is a long safety backstop, NOT a 180s budget (owner: "My comparison times out after 180 seconds, remove this limit")', () => {
  // Same pi-SDK mock pattern as above, but `session.prompt()` is controlled
  // by the test: either settles after a long-but-legitimate wall-clock time
  // (a reasoning model over a big results table) or never settles (a
  // genuinely stuck agent loop).
  const runs: ComparisonRunInput[] = [
    { key: 'A', label: 'agent A', runId: 'run-a', reportId: 'rep-a' },
    { key: 'B', label: 'agent B', runId: 'run-b', reportId: 'rep-b' },
  ];
  const baseOpts = { defaultCaseId: 'tc-default', caseReports: new Map(), getReport: async () => null };
  const mockModel = { provider: 'mock', id: 'mock.claude-fable-5-1' };
  const abortMock = jest.fn(async () => {});

  function mockSdkWithPrompt(prompt: () => Promise<unknown>) {
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession: jest.fn(async () => ({
          session: {
            prompt: jest.fn(prompt),
            abort: abortMock,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'slow but fine' }] }],
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
  }

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    abortMock.mockClear();
  });

  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.useRealTimers();
  });

  it('is derived from the job-store TTL (5 min before it) and is well past the old 180s cutoff', () => {
    const { DEEP_DIVE_DEADLINE_MS } = require('@/server/services/comparisonDeepDiveService');
    const { DEFAULT_JOB_TTL_MS } = require('@/server/services/comparisonDeepDiveJobStore');
    expect(DEEP_DIVE_DEADLINE_MS).toBe(DEFAULT_JOB_TTL_MS - 5 * 60_000);
    expect(DEEP_DIVE_DEADLINE_MS).toBe(25 * 60_000);
    expect(DEEP_DIVE_DEADLINE_MS).toBeGreaterThan(180_000);
  });

  it('a generation that takes 10 minutes (far past the old 180s limit) completes normally — the deadline no longer fails legitimate long runs', async () => {
    // prompt() resolves only after 10 simulated minutes.
    mockSdkWithPrompt(() => new Promise((resolve) => setTimeout(resolve, 10 * 60_000)));
    const { generateComparisonDeepDive: generate } = require('@/server/services/comparisonDeepDiveService');

    const promise = generate({ runs, modelId: mockModel.id, ...baseOpts });
    // Attach handlers BEFORE advancing so a rejection can never go unhandled.
    const settled = promise.then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, e }));
    await jest.advanceTimersByTimeAsync(180_000 + 1);
    // 3 minutes in: still running, nothing rejected.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const outcome: any = await settled;
    expect(outcome.ok).toBe(true);
    expect(outcome.r.markdown).toBe('slow but fine');
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('a GENUINELY stuck loop is still stopped at the backstop, aborting the pi session, with an error that says how long it ran, which model, and that Regenerate may succeed', async () => {
    mockSdkWithPrompt(() => new Promise(() => {})); // never settles
    const { generateComparisonDeepDive: generate, DEEP_DIVE_DEADLINE_MS } = require('@/server/services/comparisonDeepDiveService');

    const promise = generate({ runs, modelId: mockModel.id, ...baseOpts });
    const assertion = expect(promise).rejects.toThrow(
      /safety deadline after 25m 0s \(model mock\/mock\.claude-fable-5-1\)[\s\S]*Regenerate/
    );
    await jest.advanceTimersByTimeAsync(DEEP_DIVE_DEADLINE_MS - 1);
    expect(abortMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('never uses the old "timed out after 180s" wording', () => {
    const { buildDeadlineErrorMessage, formatDurationMs } = require('@/server/services/comparisonDeepDiveService');
    const msg = buildDeadlineErrorMessage(25 * 60_000, 'amazon-bedrock/us.anthropic.claude-fable-5-1');
    expect(msg).not.toMatch(/180s/);
    expect(msg).toContain('25m 0s');
    expect(msg).toContain('us.anthropic.claude-fable-5-1');
    expect(msg).toMatch(/Regenerate/);
    expect(formatDurationMs(95_000)).toBe('1m 35s');
    expect(formatDurationMs(42_000)).toBe('42s');
  });
});
