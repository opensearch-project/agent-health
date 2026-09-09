/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the agent trace judge's pure helpers and SDK orchestration.
 * The `evaluateWithPiAgenticTrace` tests use a deterministic SDK boundary;
 * live-model behavior remains covered by e2e validation. Tool implementation
 * details have their own focused suites (for example traceJudgeTools.test.ts).
 */

const mockBuildEvaluationPrompt = jest.fn(() => 'evaluation prompt');
const mockParseJudgeResponse = jest.fn(() => ({ passFailStatus: 'passed', accuracy: 100, metrics: {} }));
const mockBuildJudgeDebug = jest.fn(() => ({ provider: 'agent', modelId: 'test-model' }));
const mockCreateTraceExtension = jest.fn(() => ({ traceExtension: true }));
const mockCreateEvidenceExtension = jest.fn(() => ({ evidenceExtension: true }));
const mockBuildJudgeEvidence = jest.fn();
const mockRemoveJudgeEvidence = jest.fn();
const mockGetAvailable = jest.fn();
const mockPrompt = jest.fn();
const mockCreateAgentSession = jest.fn();
const mockReload = jest.fn();
const mockResourceOptions = jest.fn();

jest.mock('@/server/services/bedrockService', () => ({
  buildEvaluationPrompt: (...args: any[]) => mockBuildEvaluationPrompt(...args),
}));
jest.mock('@/server/services/judgeResponseParser', () => ({
  parseJudgeResponse: (...args: any[]) => mockParseJudgeResponse(...args),
}));
jest.mock('@/server/services/judgeDebug', () => ({
  buildJudgeDebug: (...args: any[]) => mockBuildJudgeDebug(...args),
}));
jest.mock('@/server/services/traceJudgeTools', () => ({
  createTraceJudgeExtension: (...args: any[]) => mockCreateTraceExtension(...args),
}));
jest.mock('@/server/services/evidenceJudgeTools', () => ({
  createEvidenceJudgeExtension: (...args: any[]) => mockCreateEvidenceExtension(...args),
}));
jest.mock('@/server/services/judgeEvidence', () => ({
  buildJudgeEvidence: (...args: any[]) => mockBuildJudgeEvidence(...args),
  removeJudgeEvidence: (...args: any[]) => mockRemoveJudgeEvidence(...args),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: jest.fn(() => ({ auth: true })) },
  ModelRegistry: { create: jest.fn(() => ({ getAvailable: mockGetAvailable })) },
  SessionManager: { inMemory: jest.fn(() => ({ memory: true })) },
  DefaultResourceLoader: class {
    constructor(options: any) { mockResourceOptions(options); }
    reload = mockReload;
  },
  createAgentSession: (...args: any[]) => mockCreateAgentSession(...args),
  getAgentDir: jest.fn(() => '/tmp/pi-agent'),
}), { virtual: true });

import {
  pickJudgeModel,
  extractFinalAssistantText,
  findRequestedModel,
  buildAgentTraceJudgeSystemPrompt,
  composeAgentTraceToolAddendum,
  renderJudgeEvidenceTree,
  evaluateWithPiAgenticTrace,
} from '@/server/services/piAgenticJudgeService';

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

  it('penalizes legacy Claude and wrong-region profiles', () => {
    const models = [
      m('a', 'global.anthropic.claude-3-5-sonnet'),
      m('b', 'eu.anthropic.claude-opus-4'),
      m('c', 'anthropic.claude-opus-4'),
    ];
    expect(pickJudgeModel(models)?.id).toBe('anthropic.claude-opus-4');
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

  it('falls back to any inference profile before a bare model', () => {
    process.env.AWS_REGION = 'us-east-1';
    const models = [
      m('anthropic.claude-sonnet-4-5'),
      m('eu.anthropic.claude-sonnet-4-5'),
    ];
    expect(findRequestedModel(models, 'anthropic.claude-sonnet-4-5')?.id)
      .toBe('eu.anthropic.claude-sonnet-4-5');
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

describe('evaluateWithPiAgenticTrace', () => {
  const evidence = {
    rootDir: '/tmp/judge-evidence',
    files: ['evidence/testcase.json', 'evidence/trajectory.json'],
    mounts: [],
    trace: { mode: 'cluster', exists: true },
  };
  const request = {
    trajectory: [{ type: 'response', content: 'done' }],
    expectedOutcomes: ['resolved'],
    expectedTrajectory: [],
    logs: [],
    runId: 'run-123',
    modelId: 'us.anthropic.claude-sonnet-4-5',
    agents: ['agent-a'],
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AH_JUDGE_KEEP_EVIDENCE;
    mockBuildJudgeEvidence.mockResolvedValue(evidence);
    mockGetAvailable.mockResolvedValue([
      { provider: 'amazon-bedrock', id: 'anthropic.claude-sonnet-4-5' },
      { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-5' },
    ]);
    mockCreateAgentSession.mockResolvedValue({
      session: {
        prompt: mockPrompt,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"pass_fail_status":"passed"}' }] }],
      },
    });
    mockParseJudgeResponse.mockReturnValue({ passFailStatus: 'passed', accuracy: 100, metrics: {} });
    mockBuildJudgeDebug.mockReturnValue({ provider: 'agent', modelId: 'test-model' });
    mockCreateEvidenceExtension.mockImplementation((_root: string, options: any) => {
      options.onCommand('cat evidence/testcase.json');
      return { evidenceExtension: true };
    });
  });

  it('runs a scoped in-process session and records evidence commands in judge debug', async () => {
    const result = await evaluateWithPiAgenticTrace(request, { id: 'eval-1', name: 'Evaluator' } as any);

    expect(mockBuildEvaluationPrompt).toHaveBeenCalledWith(
      request.trajectory, request.expectedOutcomes, request.expectedTrajectory, request.logs
    );
    expect(mockCreateTraceExtension).toHaveBeenCalledWith('run-123', expect.any(String), ['agent-a']);
    expect(mockResourceOptions).toHaveBeenCalledWith(expect.objectContaining({
      cwd: evidence.rootDir,
      noExtensions: true,
      noSkills: true,
      extensionFactories: expect.arrayContaining([expect.anything()]),
    }));
    const resourceOptions = mockResourceOptions.mock.calls[0][0];
    expect(resourceOptions.systemPromptOverride()).toContain('Complete judgment evidence');
    expect(resourceOptions.appendSystemPromptOverride()).toEqual([]);
    expect(mockReload).toHaveBeenCalled();
    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ id: 'us.anthropic.claude-sonnet-4-5' }),
      tools: ['bash', 'query_spans', 'query_logs'],
    }));
    expect(mockPrompt).toHaveBeenCalledWith('evaluation prompt');
    expect(mockParseJudgeResponse).toHaveBeenCalledWith(
      '{"pass_fail_status":"passed"}',
      expect.objectContaining({ evaluator: expect.objectContaining({ id: 'eval-1' }), source: 'AgentJudge' })
    );
    expect(result).toEqual(expect.objectContaining({
      passFailStatus: 'passed',
      improvementStrategies: [],
      judgeMode: 'trace-tools',
      judgeDebug: expect.objectContaining({
        toolCalls: [{ tool: 'bash', command: 'cat evidence/testcase.json' }],
      }),
    }));
    expect(mockRemoveJudgeEvidence).toHaveBeenCalledWith(evidence);
  });

  it('fails clearly when the SDK has no credentialed model and still removes evidence', async () => {
    mockGetAvailable.mockResolvedValue([]);

    await expect(evaluateWithPiAgenticTrace(request)).rejects.toThrow(/no model available/);
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
    expect(mockRemoveJudgeEvidence).toHaveBeenCalledWith(evidence);
  });

  it('degrades to trajectory-only mode and honors retained evidence', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    process.env.AH_JUDGE_KEEP_EVIDENCE = 'yes';
    mockBuildJudgeEvidence.mockResolvedValue({
      ...evidence,
      mounts: [{ virtualPath: 'evidence/spans.ndjson', sourcePaths: ['/canonical/spans.ndjson'] }],
      trace: { mode: 'file', exists: false },
    });
    mockBuildJudgeDebug.mockReturnValue(undefined);

    try {
      const result = await evaluateWithPiAgenticTrace({ ...request, runId: undefined }, undefined, false);
      expect(result.judgeMode).toBe('trajectory-only');
      expect(result.judgeDebug).toBeUndefined();
      expect(mockCreateTraceExtension).not.toHaveBeenCalled();
      expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ['bash'] }));
      expect(mockRemoveJudgeEvidence).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Keeping evidence directory'));
    } finally {
      info.mockRestore();
    }
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
    expect(out).toContain('Required Per-Outcome Verdicts');
    expect(out).toContain('"outcomes"');
    expect(out).toContain('exactly one item for each expected outcome');
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
    expect(renderJudgeEvidenceTree(['/', 'evidence/testcase.json', 'evidence/testcase.json']))
      .toContain('testcase.json');
  });

  it('rejects a prompt contract without bash and describes an unavailable trace backend', () => {
    expect(() => composeAgentTraceToolAddendum({
      registeredTools: [],
      evidenceEntries: [],
      traceMode: 'unknown',
      traceDataExists: false,
    })).toThrow(/requires the registered bash tool/);

    const out = composeAgentTraceToolAddendum({
      registeredTools: ['bash'],
      evidenceEntries: [],
      traceMode: 'unknown',
      traceDataExists: true,
    });
    expect(out).toContain('backend is unavailable');
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
