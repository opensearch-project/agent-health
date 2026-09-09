/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the agent trace judge's pure helpers. The full
 * `evaluateWithPiAgenticTrace` path drives the in-process pi SDK
 * (`createAgentSession`) + a live model, so it's covered by e2e validation;
 * here we test the deterministic helpers and the tool wiring (see
 * traceJudgeTools.test.ts) that don't need a model.
 */

import { pickJudgeModel, extractFinalAssistantText, findRequestedModel, buildAgentTraceJudgeSystemPrompt } from '@/server/services/piAgenticJudgeService';
import type { JudgeRequest } from '@/server/services/bedrockService';

describe('pickJudgeModel', () => {
  const m = (provider: string, id: string) => ({ provider, id });

  it('returns undefined for an empty model list', () => {
    expect(pickJudgeModel([])).toBeUndefined();
  });

  it('prefers sonnet > opus > claude > anything', () => {
    const models = [m('x', 'gpt-4o'), m('a', 'claude-haiku'), m('b', 'claude-opus-4'), m('c', 'claude-sonnet-4-5')];
    expect(pickJudgeModel(models)?.id).toBe('claude-sonnet-4-5');
    expect(pickJudgeModel([m('x', 'gpt-4o'), m('b', 'claude-opus-4'), m('a', 'claude-haiku')])?.id).toBe('claude-opus-4');
    expect(pickJudgeModel([m('x', 'gpt-4o'), m('a', 'claude-haiku')])?.id).toBe('claude-haiku');
  });

  it('falls back to the first model when none are claude', () => {
    expect(pickJudgeModel([m('x', 'gpt-4o'), m('y', 'gemini-2')])?.id).toBe('gpt-4o');
  });
});

describe('findRequestedModel (Bedrock inference profiles)', () => {
  const m = (id: string) => ({ provider: 'amazon-bedrock', id });
  const OLD = process.env.AWS_REGION;
  afterEach(() => { process.env.AWS_REGION = OLD; });

  it('returns undefined when no model id is requested', () => {
    expect(findRequestedModel([m('anthropic.claude-sonnet-4-5')], undefined)).toBeUndefined();
  });

  it('matches the requested model ignoring the region prefix', () => {
    const models = [m('anthropic.claude-3-5-sonnet'), m('global.anthropic.claude-sonnet-4-5')];
    // requested with a us. prefix; only a global. profile exists -> pick it (not the bare/old one)
    const found = findRequestedModel(models, 'us.anthropic.claude-sonnet-4-5');
    expect(found?.id).toBe('global.anthropic.claude-sonnet-4-5');
  });

  it('prefers the region-appropriate inference profile over global/bare', () => {
    process.env.AWS_REGION = 'us-east-1';
    const models = [
      m('anthropic.claude-sonnet-4-5'), // bare (fails on-demand)
      m('global.anthropic.claude-sonnet-4-5'),
      m('us.anthropic.claude-sonnet-4-5'),
    ];
    expect(findRequestedModel(models, 'us.anthropic.claude-sonnet-4-5')?.id).toBe('us.anthropic.claude-sonnet-4-5');
  });

  it('prefers an inference-profile variant over the bare id', () => {
    const models = [m('anthropic.claude-sonnet-4-5'), m('global.anthropic.claude-sonnet-4-5')];
    expect(findRequestedModel(models, 'anthropic.claude-sonnet-4-5')?.id).toBe('global.anthropic.claude-sonnet-4-5');
  });

  it('returns undefined when no model shares the requested base id', () => {
    expect(findRequestedModel([m('amazon.nova-pro')], 'us.anthropic.claude-opus-4')).toBeUndefined();
  });
});

describe('extractFinalAssistantText', () => {
  it('returns the last assistant text content', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'query_spans' }] }, // no text
      { role: 'assistant', content: [{ type: 'text', text: 'Verified.\n{"pass_fail_status":"passed"}' }] },
    ];
    expect(extractFinalAssistantText(messages)).toBe('Verified.\n{"pass_fail_status":"passed"}');
  });

  it('ignores non-assistant roles and concatenates multi-part text', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'ignore me' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ];
    expect(extractFinalAssistantText(messages)).toBe('ab');
  });

  it('returns empty string when there is no assistant text', () => {
    expect(extractFinalAssistantText([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])).toBe('');
    expect(extractFinalAssistantText([])).toBe('');
    expect(extractFinalAssistantText(undefined as any)).toBe('');
  });
});

describe('evaluateWithPiAgenticTrace (regression: keeps improvement strategies + custom fields)', () => {
  // Drives the real evaluateWithPiAgenticTrace() end-to-end with the optional
  // `@earendil-works/pi-coding-agent` SDK mocked out, so we exercise the exact
  // post-processing line that used to force `improvementStrategies: []`
  // (see server/services/piAgenticJudgeService.ts) rather than re-testing
  // parseJudgeResponse in isolation.
  const baseRequest: JudgeRequest = {
    trajectory: [{ type: 'assistant', content: 'did the thing' } as any],
    expectedOutcomes: ['thing done'],
    runId: 'run-1',
  } as any;

  function mockSdk(finalAssistantText: string) {
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession: jest.fn().mockResolvedValue({
          session: {
            prompt: jest.fn().mockResolvedValue(undefined),
            messages: [{ role: 'assistant', content: [{ type: 'text', text: finalAssistantText }] }],
          },
        }),
        SessionManager: { inMemory: () => ({}) },
        AuthStorage: { create: () => ({}) },
        ModelRegistry: {
          create: () => ({
            getAvailable: jest.fn().mockResolvedValue([{ provider: 'anthropic', id: 'claude-sonnet-4-5' }]),
          }),
        },
        DefaultResourceLoader: class {
          reload() {
            return Promise.resolve();
          }
        },
        getAgentDir: () => '/tmp/agent-dir',
      }),
      { virtual: true }
    );
  }

  beforeEach(() => {
    jest.resetModules();
  });

  it('keeps improvement_strategies the model emitted, shaped as ImprovementStrategy[]', async () => {
    mockSdk(JSON.stringify({
      pass_fail_status: 'passed',
      reasoning: 'Verified against real spans.',
      metrics: { accuracy: 90 },
      improvement_strategies: [
        { category: 'reliability', issue: 'retry storm', recommendation: 'add backoff', priority: 'high' },
      ],
    }));
    const { evaluateWithPiAgenticTrace } = await import('@/server/services/piAgenticJudgeService');
    const result = await evaluateWithPiAgenticTrace(baseRequest);
    expect(result.passFailStatus).toBe('passed');
    expect(result.improvementStrategies).toEqual([
      { category: 'reliability', issue: 'retry storm', recommendation: 'add backoff', priority: 'high' },
    ]);
  });

  it('returns an empty array when the model emits none (not undefined)', async () => {
    mockSdk(JSON.stringify({
      pass_fail_status: 'passed',
      reasoning: 'ok',
      metrics: { accuracy: 100 },
      improvement_strategies: [],
    }));
    const { evaluateWithPiAgenticTrace } = await import('@/server/services/piAgenticJudgeService');
    const result = await evaluateWithPiAgenticTrace(baseRequest);
    expect(result.improvementStrategies).toEqual([]);
  });

  it('keeps a custom output key (e.g. failure_tags) in extraFields', async () => {
    mockSdk(JSON.stringify({
      pass_fail_status: 'failed',
      reasoning: 'missed the root cause',
      metrics: { accuracy: 40 },
      improvement_strategies: [],
      failure_tags: ['wrong-root-cause', 'missing-evidence'],
    }));
    const { evaluateWithPiAgenticTrace } = await import('@/server/services/piAgenticJudgeService');
    const result = await evaluateWithPiAgenticTrace(baseRequest);
    expect(result.extraFields).toEqual({ failure_tags: ['wrong-root-cause', 'missing-evidence'] });
  });
});

describe('buildAgentTraceJudgeSystemPrompt (evaluator-prompt-plumbing contract)', () => {
  // The trace-judging contract — the existence and use of `query_spans`/
  // `query_logs` — must survive any user customization of the saved
  // evaluator's `systemPrompt`. These tests pin that invariant so a future
  // refactor breaks loudly with a clear message.

  it('uses the default base prompt when no evaluator is supplied', () => {
    const out = buildAgentTraceJudgeSystemPrompt(undefined);
    expect(out).toContain('observability and Root Cause Analysis');
    expect(out).toContain('query_spans');
    expect(out).toContain('query_logs');
  });

  it('uses the default base prompt when evaluator.systemPrompt is empty/whitespace', () => {
    expect(buildAgentTraceJudgeSystemPrompt({ systemPrompt: '' }))
      .toContain('observability and Root Cause Analysis');
    expect(buildAgentTraceJudgeSystemPrompt({ systemPrompt: '   \n  ' }))
      .toContain('observability and Root Cause Analysis');
  });

  it('replaces the base prompt with the saved evaluator.systemPrompt verbatim', () => {
    const out = buildAgentTraceJudgeSystemPrompt({
      systemPrompt: 'I am the CP-Oncall judge. Emit only JSON.',
    });
    expect(out).toContain('I am the CP-Oncall judge');
    // The default base must NOT be present — the saved prompt fully
    // replaces it. (Pre-fix the override was silently dropped.)
    expect(out).not.toContain('observability and Root Cause Analysis');
  });

  it('ALWAYS appends the trace-tool addendum, even when the saved prompt does not mention tools', () => {
    // This is the critical invariant: a user who saves a custom prompt and
    // forgets to mention query_spans/query_logs must NOT accidentally
    // disable trace-grounded judging.
    const out = buildAgentTraceJudgeSystemPrompt({
      systemPrompt: 'You are a custom judge. Do not use tools.',
    });
    expect(out).toContain('query_spans');
    expect(out).toContain('query_logs');
    expect(out).toContain('READ-ONLY');
  });
});

describe('buildAgentTraceJudgeSystemPrompt (traceToolsAvailable=false -- trajectory-only degradation)', () => {
  // Root cause of the reported incident: a `useTraces: false` (non-
  // instrumented) REST agent has no runId/correlation hint, so the judge
  // must reason from the trajectory alone -- and must be told explicitly
  // that no trace tools exist, so it doesn't hallucinate span/log checks.

  it('defaults traceToolsAvailable to true (back-compat with 1-arg / 2-arg callers)', () => {
    const withDefault = buildAgentTraceJudgeSystemPrompt(undefined);
    const withExplicitTrue = buildAgentTraceJudgeSystemPrompt(undefined, true);
    expect(withDefault).toBe(withExplicitTrue);
    expect(withDefault).toContain('query_spans');
  });

  it('omits the query_spans/query_logs tool-use contract (READ-ONLY description) and explains their absence when traceToolsAvailable=false', () => {
    const out = buildAgentTraceJudgeSystemPrompt(undefined, false);
    // Still names the tools (so the model knows what it's missing, per the
    // addendum's own text) but must NOT include the trace-tools mode's
    // tool-use contract/description.
    expect(out).not.toContain('READ-ONLY, scoped to the run being judged');
    expect(out).not.toContain('query_spans({');
    expect(out).toContain('No trace-query tools available');
    expect(out).toContain('not instrumented with OpenTelemetry');
  });

  it('still replaces the base prompt with a saved evaluator systemPrompt when trace tools are unavailable', () => {
    const out = buildAgentTraceJudgeSystemPrompt({ systemPrompt: 'I am the CP-Oncall judge.' }, false);
    expect(out).toContain('I am the CP-Oncall judge');
    expect(out).not.toContain('observability and Root Cause Analysis');
    expect(out).toContain('No trace-query tools available');
  });

  it('instructs the model NOT to claim trace/log verification it never performed', () => {
    const out = buildAgentTraceJudgeSystemPrompt(undefined, false);
    expect(out.toLowerCase()).toContain('do not claim');
  });
});
