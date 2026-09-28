/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * evaluateWithPiAgenticTrace — failure classification + prompt budget.
 *
 * Regression suite for the "Failed to parse Pi judge response. The CLI may
 * have returned invalid JSON." incident: the pi SDK reports a failed provider
 * call (Bedrock "Input is too long for requested model") as an assistant
 * message with `stopReason: 'error'` — `session.prompt()` does not throw —
 * and its overflow-recovery path then REMOVES that message from
 * `session.messages`. The service saw an empty final text and blamed the
 * JSON. Every case that hit this was retried 10× with identical input.
 *
 * The SDK is mocked as a virtual module (same pattern as the sdkWiring
 * suite); the fake session emits events through `subscribe` exactly the way
 * the real AgentSession does (message_end / turn_end carrying the message).
 */

import type { TrajectoryStep } from '@/types';

const mockModel = { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', contextWindow: 200_000 };

const verdict = JSON.stringify({
  pass_fail_status: 'passed',
  metrics: { accuracy: 91 },
  reasoning: 'ranked list matches the expected products',
});

const OVERFLOW_MSG = 'Validation error: The model returned the following errors: Input is too long for requested model.';

type FakeAssistant = { stopReason: string; errorMessage?: string; text?: string; keepInMessages?: boolean };

/**
 * Build a fake AgentSession. `turns` is the sequence of assistant messages
 * the session "produces" for a prompt; each is emitted via subscribe() and,
 * unless `keepInMessages: false` (the SDK overflow-recovery removal), also
 * appended to `messages`.
 */
function fakeSession(turns: FakeAssistant[], onPrompt?: (p: string) => void) {
  const listeners: Array<(ev: any) => void> = [];
  const messages: any[] = [];
  return {
    messages,
    subscribe: jest.fn((fn: (ev: any) => void) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }),
    prompt: jest.fn(async (p: string) => {
      onPrompt?.(p);
      messages.push({ role: 'user', content: [{ type: 'text', text: p }] });
      for (const t of turns) {
        const message = {
          role: 'assistant',
          stopReason: t.stopReason,
          errorMessage: t.errorMessage,
          content: t.text ? [{ type: 'text', text: t.text }] : [],
        };
        for (const l of listeners) l({ type: 'message_end', message });
        for (const l of listeners) l({ type: 'turn_end', message });
        if (t.keepInMessages !== false) messages.push(message);
      }
    }),
  };
}

function installSdkMock(session: any) {
  jest.doMock(
    '@earendil-works/pi-coding-agent',
    () => ({
      createAgentSession: jest.fn(async () => ({ session })),
      SessionManager: { inMemory: jest.fn(() => ({ kind: 'in-memory' })) },
      ModelRuntime: { create: jest.fn(async () => ({ getAvailable: jest.fn(async () => [mockModel]) })) },
      DefaultResourceLoader: jest.fn().mockImplementation(() => ({ reload: jest.fn(async () => {}) })),
      getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
    }),
    { virtual: true },
  );
  jest.doMock('@/lib/debug', () => ({ debug: jest.fn() }));
}

const smallTrajectory: TrajectoryStep[] = [
  { id: 's1', timestamp: 1, type: 'action', content: '{}', toolName: 'search_products', toolArgs: {} } as TrajectoryStep,
  { id: 's2', timestamp: 2, type: 'response', content: 'Ranked results (2):\n1. id 11 — Trail Bike (score 9.1)\n2. id 12 — Road Bike (score 8.7)' } as TrajectoryStep,
];

describe('evaluateWithPiAgenticTrace — failure classification', () => {
  const savedBudget = process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
  beforeEach(() => {
    jest.resetModules();
    delete process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
  });
  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.dontMock('@/lib/debug');
    if (savedBudget === undefined) delete process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
    else process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = savedBudget;
  });

  it('a provider context-overflow error (dropped from session.messages by the SDK) becomes a non-retryable context_overflow JudgeError — NOT "invalid JSON"', async () => {
    installSdkMock(fakeSession([{ stopReason: 'error', errorMessage: OVERFLOW_MSG, keepInMessages: false }]));
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    const { isJudgeError } = require('@/server/services/judgeErrors');
    let caught: any;
    try {
      await evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['ranks the trail bike first'], runId: 'run-1' }, undefined, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isJudgeError(caught)).toBe(true);
    expect(caught.errorClass).toBe('context_overflow');
    expect(caught.retryable).toBe(false);
    expect(caught.message).toContain('Input is too long for requested model');
    expect(caught.message).not.toMatch(/invalid JSON|did not contain a JSON object/);
  });

  it('a throttling error is classified retryable', async () => {
    installSdkMock(fakeSession([{ stopReason: 'error', errorMessage: 'ThrottlingException: Too many requests, please wait before trying again.' }]));
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'throttling', retryable: true });
  });

  it('an overflow on the SECOND turn (after a tool call) is still caught even though the first turn had text', async () => {
    installSdkMock(
      fakeSession([
        { stopReason: 'toolUse', text: 'Let me verify the spans first.' },
        { stopReason: 'error', errorMessage: OVERFLOW_MSG, keepInMessages: false },
      ]),
    );
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'context_overflow' });
  });

  it('a parseable verdict WINS over a stale trailing error event (SDK retry/compaction leftovers never discard a real verdict)', async () => {
    installSdkMock(
      fakeSession([
        { stopReason: 'stop', text: verdict },
        // e.g. an intermediate provider error the SDK later recovered from, observed last
        { stopReason: 'error', errorMessage: 'ThrottlingException: Too many requests', keepInMessages: false },
      ]),
    );
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    const res = await evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true);
    expect(res.passFailStatus).toBe('passed');
  });

  it('a normal stop with no text at all is an empty_response, with the stopReason named', async () => {
    installSdkMock(fakeSession([{ stopReason: 'stop', text: '' }]));
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'empty_response', retryable: false, message: expect.stringContaining('stopReason=stop') });
  });

  it('an aborted turn is classified as timeout (retryable)', async () => {
    installSdkMock(fakeSession([{ stopReason: 'aborted' }]));
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'timeout', retryable: true });
  });

  it('prose that really has no JSON verdict is the ONLY case reported as invalid_json', async () => {
    installSdkMock(fakeSession([{ stopReason: 'stop', text: 'I looked at the spans and the agent did fine, no JSON for you.' }]));
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'invalid_json', retryable: false });
  });

  it('a JSON verdict after a prose preamble parses', async () => {
    installSdkMock(fakeSession([{ stopReason: 'stop', text: `Based on my verification of the spans, here is my evaluation:\n\n\`\`\`json\n${verdict}\n\`\`\`` }]));
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    const res = await evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true);
    expect(res.passFailStatus).toBe('passed');
    expect(res.metrics.accuracy).toBe(91);
  });

  it('a synchronous SDK pre-flight throw (no credentials) is classified rather than surfacing as a parse error', async () => {
    const session = fakeSession([]);
    session.prompt = jest.fn(async () => {
      throw new Error('No API key found for provider "amazon-bedrock". Authentication failed.');
    });
    installSdkMock(session);
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'auth', retryable: false });
  });

  it('works with an SDK session that has no subscribe() (falls back to session.messages)', async () => {
    const session = fakeSession([{ stopReason: 'error', errorMessage: OVERFLOW_MSG }]);
    delete (session as any).subscribe;
    installSdkMock(session);
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory: smallTrajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'context_overflow' });
  });
});

describe('evaluateWithPiAgenticTrace — prompt budget', () => {
  const savedBudget = process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
  beforeEach(() => {
    jest.resetModules();
  });
  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.dontMock('@/lib/debug');
    if (savedBudget === undefined) delete process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
    else process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = savedBudget;
  });

  it('REGRESSION: a long ranked-list response step with big tool outputs is truncated to budget (largest field first, marker present) and judges successfully', async () => {
    process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = '20000'; // 50k chars
    const rankedList =
      'Ranked results (20, results_source=return_results):\n' +
      Array.from({ length: 20 }, (_, i) => `${i + 1}. id ${1000 + i} — Product "${'Widget'.repeat(3)}" {brand: 'ACME', tags: [a, b]} (score ${(20 - i).toFixed(2)})`).join('\n');
    const bigToolOutput = JSON.stringify({ hits: Array.from({ length: 800 }, (_, i) => ({ _id: `${i}`, _score: i / 7, _source: { title: `item ${i}`, description: 'x'.repeat(120) } })) });
    const trajectory: TrajectoryStep[] = [
      { id: 'u', timestamp: 1, type: 'user', content: 'search products for a red bike' } as TrajectoryStep,
      { id: 't1', timestamp: 2, type: 'tool_result', toolName: 'search', content: '[see toolOutput]', toolOutput: bigToolOutput } as TrajectoryStep,
      { id: 't2', timestamp: 3, type: 'tool_result', toolName: 'search', content: '[see toolOutput]', toolOutput: bigToolOutput.slice(0, 30_000) } as TrajectoryStep,
      { id: 'r', timestamp: 4, type: 'response', content: rankedList } as TrajectoryStep,
    ];
    let prompted = '';
    installSdkMock(fakeSession([{ stopReason: 'stop', text: verdict }], (p) => { prompted = p; }));
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    const res = await evaluateWithPiAgenticTrace({ trajectory, expectedOutcomes: ['ranks the red bike first'], runId: 'run-1' }, undefined, true);

    expect(res.passFailStatus).toBe('passed');
    expect(prompted.length).toBeLessThanOrEqual(50_000);
    expect(prompted).toContain("to fit the judge's context budget");
    // The ranked list (the verdict-relevant step) survived intact.
    expect(prompted).toContain('Ranked results (20, results_source=return_results)');
    expect(prompted).toContain('20. id 1019');
  });

  it('a prompt that cannot be fit even after truncation fails fast with context_overflow, BEFORE calling the model', async () => {
    process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = '1000'; // 2.5k chars — impossible for 30 steps
    const trajectory: TrajectoryStep[] = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`, timestamp: i, type: 'tool_result', toolName: 'search', content: 'c'.repeat(600),
    })) as TrajectoryStep[];
    const session = fakeSession([{ stopReason: 'stop', text: verdict }]);
    installSdkMock(session);
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory, expectedOutcomes: ['x'], runId: 'run-1' }, undefined, true),
    ).rejects.toMatchObject({ errorClass: 'context_overflow', retryable: false, message: expect.stringContaining('even after truncating') });
    expect(session.prompt).not.toHaveBeenCalled();
  });
});

describe('classifyAssistantOutcome (pure)', () => {
  it('returns undefined for a normal turn with text', () => {
    const { classifyAssistantOutcome } = require('@/server/services/piAgenticJudgeService');
    expect(classifyAssistantOutcome({ stopReason: 'stop', text: '{}' }, '{}')).toBeUndefined();
    expect(classifyAssistantOutcome(undefined, '{}')).toBeUndefined();
  });
  it('labels a generic provider error without the overflow wording', () => {
    const { classifyAssistantOutcome } = require('@/server/services/piAgenticJudgeService');
    const e = classifyAssistantOutcome({ stopReason: 'error', errorMessage: 'ServiceUnavailableException 503', text: '' }, '');
    expect(e.errorClass).toBe('provider_error');
    expect(e.message).toMatch(/^Judge model call failed: /);
  });
  it('handles an error with no message', () => {
    const { classifyAssistantOutcome } = require('@/server/services/piAgenticJudgeService');
    const e = classifyAssistantOutcome({ stopReason: 'error', text: '' }, '');
    expect(e.errorClass).toBe('unknown');
    expect(e.message).toContain('without a message');
  });
});
