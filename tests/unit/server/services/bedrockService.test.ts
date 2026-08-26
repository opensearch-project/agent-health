/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock the Bedrock client BEFORE imports
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  ConverseCommand: jest.fn().mockImplementation((input) => input),
}));

// Mock the config
jest.mock('@/server/config', () => ({
  default: {
    AWS_REGION: 'us-east-1',
    BEDROCK_MODEL_ID: 'anthropic.claude-3-5-sonnet-v1',
  },
}));

import {
  truncateString,
  compactTrajectory,
  getJudgeContentCaps,
  buildEvaluationPrompt,
  evaluateTrajectory,
  parseBedrockError,
  JudgeRequest,
} from '@/server/services/bedrockService';
import { TrajectoryStep } from '@/types';

// Helper to create a valid TrajectoryStep with optional overrides
const createStep = (overrides: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'type'>): TrajectoryStep => ({
  id: `step-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  content: '',
  ...overrides,
});

describe('BedrockService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('truncateString', () => {
    it('should return empty string for null or undefined', () => {
      expect(truncateString(null)).toBe('');
      expect(truncateString(undefined)).toBe('');
    });

    it('should return original string if shorter than max length', () => {
      const short = 'short string';
      expect(truncateString(short, 100)).toBe(short);
    });

    it('should truncate string longer than max length', () => {
      const long = 'a'.repeat(200);
      const result = truncateString(long, 100);

      expect(result).toHaveLength(100 + '... [truncated 100 chars]'.length);
      expect(result).toContain('... [truncated 100 chars]');
    });

    it('should use default max length of 1000', () => {
      const long = 'a'.repeat(1500);
      const result = truncateString(long);

      expect(result).toContain('... [truncated 500 chars]');
    });

    it('should return exactly max length content plus truncation message', () => {
      const long = 'a'.repeat(50);
      const result = truncateString(long, 30);

      expect(result.startsWith('a'.repeat(30))).toBe(true);
      expect(result).toContain('[truncated 20 chars]');
    });
  });

  describe('compactTrajectory', () => {
    it('should truncate long content fields', () => {
      // Use 60_000 chars so it crosses the new default cap (50_000) without
      // depending on the env-var override path.
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'action', content: 'a'.repeat(60_000) }),
      ];

      const result = compactTrajectory(trajectory);

      expect(result[0].content).toContain('[truncated');
      expect((result[0].content as string).length).toBeLessThan(60_000);
    });

    it('should truncate long string toolOutput', () => {
      // Cross the new default toolOutput cap (100_000).
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'tool_result', content: '', toolOutput: 'b'.repeat(120_000) }),
      ];

      const result = compactTrajectory(trajectory);

      expect(result[0].toolOutput).toContain('[truncated');
    });

    it('should truncate object toolOutput as JSON', () => {
      const largeObject = { data: 'x'.repeat(120_000) };
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'tool_result', content: '', toolOutput: largeObject as any }),
      ];

      const result = compactTrajectory(trajectory);

      expect(typeof result[0].toolOutput).toBe('string');
      expect(result[0].toolOutput).toContain('[truncated');
    });

    it('should preserve short content', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'thinking', content: 'short content' }),
      ];

      const result = compactTrajectory(trajectory);

      expect(result[0].content).toBe('short content');
    });

    it('should not modify original trajectory', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'action', content: 'a'.repeat(60_000) }),
      ];
      const originalLength = (trajectory[0].content as string).length;

      compactTrajectory(trajectory);

      expect(trajectory[0].content).toHaveLength(originalLength);
    });

    // ─── New post-fix coverage: cap is configurable, default is generous ───
    //
    // Until 0.5.21 the cap was hardcoded at 500 chars / 1000 chars and the
    // judge graded from a SLICE of every assistant message ("truncated at
    // 7465 chars... from what is visible..."). These cases pin the new
    // contract so it can't silently regress.

    it('should preserve content of typical post-thinking assistant messages (8KB) at the default cap', () => {
      // 8KB is the size of a typical opus-4.x first-turn answer with
      // a brief diagnosis + a couple of [READ] command groups. The pre-fix
      // cap (500) sliced these down to a single sentence; the post-fix cap
      // (50_000) preserves them whole.
      const eightKb = 'q'.repeat(8 * 1024);
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'response', content: eightKb }),
      ];

      const result = compactTrajectory(trajectory);

      expect(result[0].content).toBe(eightKb);
      expect(result[0].content).not.toContain('[truncated');
    });

    it('honors AH_JUDGE_CONTENT_CAP env override', () => {
      const original = process.env.AH_JUDGE_CONTENT_CAP;
      process.env.AH_JUDGE_CONTENT_CAP = '100';
      try {
        const trajectory: TrajectoryStep[] = [
          createStep({ type: 'action', content: 'a'.repeat(500) }),
        ];
        const result = compactTrajectory(trajectory);
        // 100 chars + truncation marker
        expect((result[0].content as string).startsWith('a'.repeat(100))).toBe(true);
        expect(result[0].content).toContain('[truncated 400 chars]');
      } finally {
        if (original === undefined) delete process.env.AH_JUDGE_CONTENT_CAP;
        else process.env.AH_JUDGE_CONTENT_CAP = original;
      }
    });

    it('honors AH_JUDGE_TOOL_OUTPUT_CAP env override', () => {
      const original = process.env.AH_JUDGE_TOOL_OUTPUT_CAP;
      process.env.AH_JUDGE_TOOL_OUTPUT_CAP = '200';
      try {
        const trajectory: TrajectoryStep[] = [
          createStep({ type: 'tool_result', content: '', toolOutput: 'b'.repeat(1_000) }),
        ];
        const result = compactTrajectory(trajectory);
        expect((result[0].toolOutput as string).startsWith('b'.repeat(200))).toBe(true);
        expect(result[0].toolOutput).toContain('[truncated 800 chars]');
      } finally {
        if (original === undefined) delete process.env.AH_JUDGE_TOOL_OUTPUT_CAP;
        else process.env.AH_JUDGE_TOOL_OUTPUT_CAP = original;
      }
    });

    it('AH_JUDGE_NO_TRUNCATE=1 disables truncation entirely', () => {
      const original = process.env.AH_JUDGE_NO_TRUNCATE;
      process.env.AH_JUDGE_NO_TRUNCATE = '1';
      try {
        const huge = 'a'.repeat(200_000);
        const trajectory: TrajectoryStep[] = [
          createStep({ type: 'response', content: huge }),
        ];
        const result = compactTrajectory(trajectory);
        expect(result[0].content).toBe(huge);
        expect(result[0].content).not.toContain('[truncated');
      } finally {
        if (original === undefined) delete process.env.AH_JUDGE_NO_TRUNCATE;
        else process.env.AH_JUDGE_NO_TRUNCATE = original;
      }
    });

    it('explicit opts override env vars', () => {
      const original = process.env.AH_JUDGE_CONTENT_CAP;
      process.env.AH_JUDGE_CONTENT_CAP = '50';
      try {
        const trajectory: TrajectoryStep[] = [
          createStep({ type: 'action', content: 'a'.repeat(300) }),
        ];
        // Caller forces a higher cap than the env var.
        const result = compactTrajectory(trajectory, { contentCap: 1_000 });
        expect(result[0].content).toBe('a'.repeat(300));
        expect(result[0].content).not.toContain('[truncated');
      } finally {
        if (original === undefined) delete process.env.AH_JUDGE_CONTENT_CAP;
        else process.env.AH_JUDGE_CONTENT_CAP = original;
      }
    });

    it('rejects bogus env-var values and falls back to defaults', () => {
      const a = process.env.AH_JUDGE_CONTENT_CAP;
      const b = process.env.AH_JUDGE_TOOL_OUTPUT_CAP;
      process.env.AH_JUDGE_CONTENT_CAP = 'not-a-number';
      process.env.AH_JUDGE_TOOL_OUTPUT_CAP = '-7';
      try {
        const caps = getJudgeContentCaps();
        // 50_000 / 100_000 defaults from bedrockService.
        expect(caps.contentCap).toBe(50_000);
        expect(caps.toolOutputCap).toBe(100_000);
      } finally {
        if (a === undefined) delete process.env.AH_JUDGE_CONTENT_CAP;
        else process.env.AH_JUDGE_CONTENT_CAP = a;
        if (b === undefined) delete process.env.AH_JUDGE_TOOL_OUTPUT_CAP;
        else process.env.AH_JUDGE_TOOL_OUTPUT_CAP = b;
      }
    });
  });

  describe('buildEvaluationPrompt', () => {
    it('should include trajectory in JSON format', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'action', toolName: 'cluster_health', content: 'test' }),
      ];

      const result = buildEvaluationPrompt(trajectory);

      expect(result).toContain('Actual Agent Trajectory');
      expect(result).toContain('cluster_health');
    });

    it('should include expected outcomes when provided', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const expectedOutcomes = ['Check cluster health', 'Identify root cause'];

      const result = buildEvaluationPrompt(trajectory, expectedOutcomes);

      expect(result).toContain('Expected Outcomes');
      expect(result).toContain('1. Check cluster health');
      expect(result).toContain('2. Identify root cause');
    });

    it('should include legacy expected trajectory when no outcomes', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const expectedTrajectory = [{ description: 'Step 1', requiredTools: ['tool1'] }];

      const result = buildEvaluationPrompt(trajectory, undefined, expectedTrajectory);

      expect(result).toContain('Expected Trajectory (Legacy)');
      expect(result).toContain('Step 1');
    });

    it('should show "No expected outcomes" when neither provided', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];

      const result = buildEvaluationPrompt(trajectory);

      expect(result).toContain('No expected outcomes defined');
    });

    it('should include logs when provided', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const logs = [{ timestamp: '2024-01-01', message: 'Test log' }];

      const result = buildEvaluationPrompt(trajectory, undefined, undefined, logs);

      expect(result).toContain('Test log');
    });

    it('should limit logs to 20', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const logs = Array(30).fill(null).map((_, i) => ({ id: i, message: `Log ${i}` }));

      const result = buildEvaluationPrompt(trajectory, undefined, undefined, logs);

      expect(result).toContain('Log 19');
      expect(result).not.toContain('Log 20');
    });

    it('should show "No logs available" when empty', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];

      const result = buildEvaluationPrompt(trajectory, undefined, undefined, []);

      expect(result).toContain('No logs available');
    });

    // Regression for the judge-truncation bug: a 20KB assistant response
    // (≈12k tokens worth of reasoning) flowing through compactTrajectory →
    // buildEvaluationPrompt MUST appear intact in the prompt the judge sees.
    // Pre-fix, the prompt contained a 500-char SLICE plus the substring
    // `[truncated 19,756 chars]` and the judge graded "from what is visible".
    it('should preserve a 20KB step content in the prompt the judge sees', () => {
      const big = 'q'.repeat(20_000);
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'response', content: big }),
      ];
      const result = buildEvaluationPrompt(trajectory, ['identifies the cause']);

      // Full content present — the judge sees the whole assistant message.
      expect(result).toContain(big);
      // No truncation marker leaked.
      expect(result).not.toContain('[truncated 19500 chars]');
      expect(result).not.toContain('[truncated 19,500 chars]');
    });

    // Same regression, on the toolOutput side: a 20KB Logs-Insights query
    // result (the typical `query_spans` payload a trace-grounded judge
    // needs to grade tool correctness) MUST flow through intact.
    it('should preserve a 20KB toolOutput in the prompt the judge sees', () => {
      const bigOutput = 'log-line\n'.repeat(2_500); // ~22.5KB
      const trajectory: TrajectoryStep[] = [
        createStep({
          type: 'tool_result',
          content: '',
          toolOutput: bigOutput,
        }),
      ];
      const result = buildEvaluationPrompt(trajectory, ['picks the right SOP']);
      expect(result).toContain('log-line');
      // The string repeats 2,500 times — every occurrence is present, not
      // just the head.
      const matches = result.match(/log-line/g) ?? [];
      expect(matches.length).toBe(2_500);
      expect(result).not.toContain('[truncated');
    });
  });

  describe('evaluateTrajectory', () => {
    it('should call Bedrock API with correct parameters', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "accuracy": 0.9, "reasoning": "Good"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action', toolName: 'test' })],
        expectedOutcomes: ['Test outcome'],
      };

      await evaluateTrajectory(request);

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    // Bedrock contract change 4.6 -> 4.7/4.8: newer models reject ANY explicit
    // temperature ("temperature is deprecated for this model"). The judge must
    // omit the field entirely for those models — issue #299.
    it('omits temperature for models that have deprecated it (Opus 4.7/4.8+)', async () => {
      mockSend.mockResolvedValue({
        output: { message: { content: [{ text: '{"pass_fail_status": "passed", "accuracy": 1.0, "reasoning": "ok"}' }] } },
      });
      await evaluateTrajectory(
        { trajectory: [createStep({ type: 'action', toolName: 'test' })], expectedOutcomes: ['x'] },
        'us.anthropic.claude-opus-4-8',
      );
      const cfg = (mockSend.mock.calls.at(-1)![0] as any).inferenceConfig;
      expect(cfg.temperature).toBeUndefined();
      expect(cfg.maxTokens).toBe(4096);
    });

    it('still sends the evaluator temperature to models that accept it', async () => {
      mockSend.mockResolvedValue({
        output: { message: { content: [{ text: '{"pass_fail_status": "passed", "accuracy": 1.0, "reasoning": "ok"}' }] } },
      });
      await evaluateTrajectory(
        { trajectory: [createStep({ type: 'action', toolName: 'test' })], expectedOutcomes: ['x'] },
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      );
      expect((mockSend.mock.calls.at(-1)![0] as any).inferenceConfig.temperature).toBe(0.1);
    });

    // Regression for the judge-truncation bug — from the *provider entry
    // point* perspective: the same end-to-end flow that POST /api/judge
    // exercises (evaluateTrajectory → buildEvaluationPrompt → ConverseCommand)
    // must hand the full assistant content to the model. Pre-fix, every
    // ConverseCommand contained `[truncated 19500 chars]` in the user message
    // and the judge graded a 500-char slice. This locks the post-fix contract
    // at the boundary that customer requests actually traverse.
    it('should send full trajectory content to Bedrock for a 20KB step (judge-truncation regression)', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "accuracy": 1.0, "reasoning": "ok"}' }],
          },
        },
      });

      const big = 'q'.repeat(20_000);
      const request: JudgeRequest = {
        trajectory: [
          createStep({ type: 'response', content: big }),
        ],
        expectedOutcomes: ['identifies the cause'],
      };

      await evaluateTrajectory(request);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const calledWith = mockSend.mock.calls[0][0];
      // Model receives the trajectory in the user message text. Walk the
      // ConverseCommand input shape and assert the 20KB content is present
      // intact (not sliced, no truncation marker).
      const userText: string = calledWith.messages?.[0]?.content?.[0]?.text || '';
      expect(userText.length).toBeGreaterThan(20_000);
      expect(userText).toContain(big);
      expect(userText).not.toContain('[truncated 19500 chars]');
      expect(userText).not.toContain('[truncated 19,500 chars]');
    });

    it('should use provided model ID', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "accuracy": 0.9, "reasoning": "Good"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      await evaluateTrajectory(request, 'custom-model-id');

      const calledWith = mockSend.mock.calls[0][0];
      expect(calledWith.modelId).toBe('custom-model-id');
    });

    it('should return structured response', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "accuracy": 0.95, "reasoning": "Excellent work", "improvement_strategies": ["Try X"]}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
        expectedOutcomes: ['Test'],
      };

      const result = await evaluateTrajectory(request);

      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(0.95);
      expect(result.llmJudgeReasoning).toBe('Excellent work');
      expect(result.improvementStrategies).toContain('Try X');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle JSON in markdown code block', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '```json\n{"pass_fail_status": "failed", "accuracy": 0.5, "reasoning": "Needs work"}\n```' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      expect(result.passFailStatus).toBe('failed');
      expect(result.metrics.accuracy).toBe(0.5);
    });

    it('should handle metrics in nested object (legacy format)', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "metrics": {"accuracy": 0.8, "faithfulness": 0.9}, "reasoning": "OK"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      expect(result.metrics.accuracy).toBe(0.8);
      // faithfulness is not extracted because it's not in the default evaluator's scoringConfig
      expect(result.metrics.faithfulness).toBeUndefined();
    });

    it('should omit accuracy when missing from judge response', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "failed", "reasoning": "No data"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      // With dynamic metrics, missing metrics are omitted (not defaulted to 0)
      expect(result.metrics.accuracy).toBeUndefined();
    });

    it('should default passFailStatus to failed when missing', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"accuracy": 0.5, "reasoning": "OK"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      expect(result.passFailStatus).toBe('failed');
    });
  });

  describe('parseBedrockError', () => {
    it('should identify expired token error', () => {
      const error = new Error('ExpiredToken: The security token included in the request is expired');

      const result = parseBedrockError(error);

      expect(result).toContain('credentials expired');
    });

    it('should identify credentials provider error', () => {
      const error = new Error('CredentialsProviderError: Could not load credentials');

      const result = parseBedrockError(error);

      expect(result).toContain('credentials expired');
    });

    it('should identify throttling error', () => {
      const error = new Error('ThrottlingException: Rate exceeded');

      const result = parseBedrockError(error);

      expect(result).toContain('rate limit');
    });

    it('should identify validation error', () => {
      const error = new Error('ValidationException: Invalid model');

      const result = parseBedrockError(error);

      expect(result).toContain('Invalid request');
    });

    it('should identify JSON parse error', () => {
      const error = new Error('Unexpected token at position 0 in JSON');

      const result = parseBedrockError(error);

      expect(result).toContain('parse LLM judge response');
    });

    it('should return original message for unknown errors', () => {
      const error = new Error('Some unknown error');

      const result = parseBedrockError(error);

      expect(result).toBe('Some unknown error');
    });

    it('should return "Unknown error" for empty message', () => {
      const error = new Error('');

      const result = parseBedrockError(error);

      expect(result).toBe('Unknown error occurred');
    });
  });
});
