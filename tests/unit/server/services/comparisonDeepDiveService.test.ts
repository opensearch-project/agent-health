/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the comparison deep-dive service.
 *
 * Guards the two things most likely to silently regress:
 *   1. the SYSTEM_PROMPT actually instructs the agent to hunt + report ERRORS
 *      in either/both runs (this content was lost once and re-added);
 *   2. buildUserPrompt threads each run's identity (key, runId, label) so the
 *      agent can cite spans with the correct runId.
 * Plus the exactly-2-runs guard on the public entry point.
 */

import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  generateComparisonDeepDive,
  type ComparisonRunInput,
} from '@/server/services/comparisonDeepDiveService';

describe('comparisonDeepDiveService — SYSTEM_PROMPT', () => {
  it('instructs the agent to hunt for errors on EACH side', () => {
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
    // And an explicit per-side "no errors observed" when clean (never omitted).
    expect(SYSTEM_PROMPT).toMatch(/no errors observed/);
    expect(SYSTEM_PROMPT).toMatch(/never silently omit/i);
  });

  it('instructs the agent to say CASE, never RUN, using the owner-mandated outcome+score template', () => {
    // This deep-dive is per test case, not a benchmark run's aggregate pass
    // rate -- owner feedback: "Run A passed (100/100)" reads like a run-level
    // stat even though the panel is analyzing one case (see #398 follow-up).
    expect(SYSTEM_PROMPT).toMatch(/CASE, never RUN/);
    expect(SYSTEM_PROMPT).toMatch(/NEVER write "Run A" \/ "Run B"/);
    expect(SYSTEM_PROMPT).toMatch(/On this case, A passed \(judge 100\/100\)/);
    expect(SYSTEM_PROMPT).toMatch(/On this case, B failed \(judge 42\/100\)/);
  });

  it('still asks for span citations + a tight markdown deep-dive', () => {
    expect(SYSTEM_PROMPT).toMatch(/span:<runId>:<spanId>/);
    expect(SYSTEM_PROMPT).toMatch(/headline verdict/i);
  });

  it('instructs the agent to record a chart and follow-up experiment suggestions before writing', () => {
    expect(SYSTEM_PROMPT).toMatch(/record_deepdive_extras` AT MOST ONCE/);
    expect(SYSTEM_PROMPT).toMatch(/grounded in what you actually found/i);
    expect(SYSTEM_PROMPT).toMatch(/omit either or both rather than fabricating/i);
  });

  it('instructs the agent to never write a bare "N/N" judge score (misreads as a case count)', () => {
    expect(SYSTEM_PROMPT).toMatch(/scored 100\/100 judge points/);
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
    // Never the "Run A"/"Run B" framing -- that reads like a benchmark run's
    // aggregate stat, not this one test case's two attempts (see #398 follow-up).
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

  beforeEach(() => {
    jest.resetModules();
    capturedResourceLoaderOpts = undefined;
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession: jest.fn(async () => ({
          session: {
            prompt: jest.fn(async () => {}),
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
});
