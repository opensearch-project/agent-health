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

const BASE_ENTRIES = [
  'evidence/',
  'evidence/run.json',
  'evidence/steps/',
  'evidence/steps/001-action.json',
  'evidence/testcase.json',
  'evidence/trajectory.json',
  'evidence/trajectory.ndjson',
  'scratch/',
];

const promptState = (over: Partial<Parameters<typeof buildAgentTraceJudgeSystemPrompt>[1]> = {}) => ({
  registeredTools: ['bash'],
  evidenceEntries: BASE_ENTRIES,
  traceMode: 'file' as const,
  traceDataExists: false,
  ...over,
});

describe('buildAgentTraceJudgeSystemPrompt (runtime-composed contract)', () => {
  it('uses the default base prompt when no evaluator is supplied', () => {
    const out = buildAgentTraceJudgeSystemPrompt(undefined, promptState());
    expect(out).toContain('observability and Root Cause Analysis');
    expect(out).toContain('`bash`');
    expect(out).not.toContain('query_spans');
    expect(out).not.toContain('query_logs');
  });

  it('uses the default base prompt when evaluator.systemPrompt is empty/whitespace', () => {
    expect(buildAgentTraceJudgeSystemPrompt({ systemPrompt: '' }, promptState()))
      .toContain('observability and Root Cause Analysis');
    expect(buildAgentTraceJudgeSystemPrompt({ systemPrompt: '   \n  ' }, promptState()))
      .toContain('observability and Root Cause Analysis');
  });

  it('replaces the base prompt with the saved evaluator.systemPrompt verbatim', () => {
    const out = buildAgentTraceJudgeSystemPrompt(
      { systemPrompt: 'I am the CP-Oncall judge. Emit only JSON.' },
      promptState()
    );
    expect(out).toContain('I am the CP-Oncall judge');
    expect(out).not.toContain('observability and Root Cause Analysis');
  });

  it('ALWAYS appends the runtime addendum to a custom evaluator base prompt', () => {
    const out = buildAgentTraceJudgeSystemPrompt(
      { systemPrompt: 'You are a custom judge. Do not use tools.' },
      promptState()
    );
    expect(out).toContain('Complete judgment evidence + restricted tools');
    expect(out).toContain('READ-ONLY');
    expect(out).toContain('evidence/testcase.json');
  });

  it('renders file-mode trace mounts and the join example only when they resolve in the real tree', () => {
    const withSpans = buildAgentTraceJudgeSystemPrompt(undefined, promptState({
      evidenceEntries: [...BASE_ENTRIES, 'evidence/spans.ndjson'],
      traceDataExists: true,
    }));
    expect(withSpans).toContain('spans.ndjson  # canonical trace-store mount');
    expect(withSpans).toContain('Trace/trajectory join example');
    expect(withSpans).not.toContain('logs.ndjson');
    expect(withSpans).not.toContain('query_spans');

    const withoutSpans = buildAgentTraceJudgeSystemPrompt(undefined, promptState());
    expect(withoutSpans).not.toContain('spans.ndjson');
    expect(withoutSpans).not.toContain('logs.ndjson');
    expect(withoutSpans).toContain('no trace data exists for this run — judge from trajectory evidence');
  });

  it('cluster mode lists no trace files and mentions each registered trace tool iff registered', () => {
    const onlySpans = buildAgentTraceJudgeSystemPrompt(undefined, promptState({
      registeredTools: ['bash', 'query_spans'],
      traceMode: 'cluster',
      traceDataExists: true,
    }));
    expect(onlySpans).toContain('query_spans');
    expect(onlySpans).not.toContain('query_logs');
    expect(onlySpans).not.toContain('spans.ndjson');
    expect(onlySpans).toContain('interim interface until a PPL tool lands');

    const both = buildAgentTraceJudgeSystemPrompt(undefined, promptState({
      registeredTools: ['bash', 'query_spans', 'query_logs'],
      traceMode: 'cluster',
      traceDataExists: true,
    }));
    expect(both).toContain('query_spans');
    expect(both).toContain('query_logs');
  });

  it('tree entries are listed iff supplied by the evidence bundle', () => {
    const out = buildAgentTraceJudgeSystemPrompt(undefined, promptState({
      evidenceEntries: [...BASE_ENTRIES, 'evidence/workspace/', 'evidence/workspace/answer.txt'],
    }));
    expect(out).toContain('answer.txt');
    expect(out).toContain('workspace/');
    expect(out).not.toContain('workspace-error.txt');
    expect(out).not.toContain('README');
    expect(out).not.toContain('manifest');
  });
});
