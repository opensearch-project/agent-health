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

// Deep-dive model-selection helpers (kept as a separate import so this hunk
// stays independent of the judge-regression tests' import lines).
import { pickNewestClaudeModel, scoreJudgeModel, scoreNewestClaudeModel, parseClaudeVersion } from '@/server/services/piAgenticJudgeService';
import { pickJudgeModel, extractFinalAssistantText, findRequestedModel, buildAgentTraceJudgeSystemPrompt } from '@/server/services/piAgenticJudgeService';

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

  // The judge's silent fallback (used when a run's configured judgeModelId is
  // unavailable) is DELIBERATELY not Claude-5-aware: moving it to a newer
  // family would change verdicts between otherwise-identical runs. Pin it.
  it('judge fallback stays on Claude 4.x Sonnet even when Fable 5.1 is available (verdict comparability)', () => {
    process.env.AWS_REGION = 'us-east-1';
    const registry = [
      m('amazon-bedrock', 'us.anthropic.claude-fable-5-1'),
      m('amazon-bedrock', 'us.anthropic.claude-fable-5'),
      m('amazon-bedrock', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'),
      m('amazon-bedrock', 'us.anthropic.claude-sonnet-4-6'),
      m('amazon-bedrock', 'us.anthropic.claude-opus-4-8'),
    ];
    expect(pickJudgeModel(registry)?.id).toMatch(/claude-sonnet-4-[56]/);
    expect(scoreJudgeModel('us.anthropic.claude-fable-5-1')).toBeLessThan(scoreJudgeModel('us.anthropic.claude-sonnet-4-6'));
  });
});

describe('parseClaudeVersion', () => {
  it('parses family/major/minor from Bedrock inference-profile ids', () => {
    expect(parseClaudeVersion('us.anthropic.claude-fable-5-1')).toEqual({ family: 'fable', major: 5, minor: 1 });
    expect(parseClaudeVersion('global.anthropic.claude-fable-5')).toEqual({ family: 'fable', major: 5, minor: 0 });
    expect(parseClaudeVersion('anthropic.claude-sonnet-4-5-20250929-v1:0')).toEqual({ family: 'sonnet', major: 4, minor: 5 });
    expect(parseClaudeVersion('us.anthropic.claude-opus-4-6-v1')).toEqual({ family: 'opus', major: 4, minor: 6 });
    expect(parseClaudeVersion('us.anthropic.claude-opus-4-8')).toEqual({ family: 'opus', major: 4, minor: 8 });
  });
  it('does not mistake a date stamp for a minor version', () => {
    // `claude-opus-4-20250514` — the 8-digit run is not a minor.
    expect(parseClaudeVersion('anthropic.claude-opus-4-20250514-v1:0')).toEqual({ family: 'opus', major: 4, minor: 0 });
  });
  it('returns undefined for non-Claude ids', () => {
    expect(parseClaudeVersion('openai.gpt-5.5')).toBeUndefined();
    expect(parseClaudeVersion('zai.glm-5')).toBeUndefined();
  });
});

describe('pickNewestClaudeModel / scoreNewestClaudeModel (deep-dive default: owner wants Fable 5.1)', () => {
  const m = (id: string) => ({ provider: 'amazon-bedrock', id });
  const OLD = process.env.AWS_REGION;
  afterEach(() => { process.env.AWS_REGION = OLD; });

  // The real registry snapshot (subset) from the machine that motivated this
  // change — the OLD picker chose global.anthropic.claude-sonnet-4-5 here.
  const registry = [
    m('anthropic.claude-sonnet-4-6'),
    m('anthropic.claude-opus-4-8'),
    m('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    m('global.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    m('us.anthropic.claude-sonnet-4-6'),
    m('us.anthropic.claude-opus-4-8'),
    m('eu.anthropic.claude-fable-5'),
    m('global.anthropic.claude-fable-5'),
    m('us.anthropic.claude-fable-5'),
    m('us.anthropic.claude-fable-5-1'),
    m('openai.gpt-5.5'),
    m('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  ];

  it('picks Fable 5.1 (US profile) over every Claude 4.x and over Fable 5.0', () => {
    process.env.AWS_REGION = 'us-east-1';
    expect(pickNewestClaudeModel(registry)?.id).toBe('us.anthropic.claude-fable-5-1');
    expect(pickJudgeModel(registry)?.id).not.toBe('us.anthropic.claude-fable-5-1'); // and the judge did NOT move
  });

  it('any Claude 5 family (mythos / opus-5 / sonnet-5) beats every 4.x; higher minor wins; fable is preferred within a tie', () => {
    const s = scoreNewestClaudeModel;
    expect(s('us.anthropic.claude-mythos-5')).toBeGreaterThan(s('us.anthropic.claude-opus-4-8'));
    expect(s('us.anthropic.claude-opus-5')).toBeGreaterThan(s('us.anthropic.claude-sonnet-4-6'));
    expect(s('us.anthropic.claude-sonnet-5')).toBeGreaterThan(s('us.anthropic.claude-sonnet-4-6'));
    expect(s('us.anthropic.claude-fable-5-1')).toBeGreaterThan(s('us.anthropic.claude-fable-5'));
    expect(s('us.anthropic.claude-fable-5')).toBeGreaterThan(s('us.anthropic.claude-mythos-5'));
    expect(s('us.anthropic.claude-opus-5-1')).toBeGreaterThan(s('us.anthropic.claude-fable-5'));
  });

  it('still prefers the region/global inference profile over a bare id and penalizes wrong-region profiles', () => {
    process.env.AWS_REGION = 'us-east-1';
    expect(scoreNewestClaudeModel('us.anthropic.claude-fable-5')).toBeGreaterThan(scoreNewestClaudeModel('anthropic.claude-fable-5'));
    expect(scoreNewestClaudeModel('anthropic.claude-fable-5')).toBeGreaterThan(scoreNewestClaudeModel('eu.anthropic.claude-fable-5'));
    process.env.AWS_REGION = 'eu-west-1';
    expect(pickNewestClaudeModel([m('us.anthropic.claude-fable-5'), m('eu.anthropic.claude-fable-5')])?.id).toBe('eu.anthropic.claude-fable-5');
  });

  it('falls back to the best 4.x when no Claude 5 exists, and to undefined for an empty list', () => {
    process.env.AWS_REGION = 'us-east-1';
    const only4 = registry.filter((x) => !/-5(?!-\d*\d{4})/.test(x.id) || x.id.includes('4-5'));
    expect(pickNewestClaudeModel(only4)?.id).toMatch(/claude-(sonnet|opus)-4/);
    expect(pickNewestClaudeModel([])).toBeUndefined();
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
