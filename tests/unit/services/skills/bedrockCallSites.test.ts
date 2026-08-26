/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Call-site wiring tests for issues #298/#299.
 *
 * bedrockCompat.test.ts proves the helpers work in isolation; these tests
 * prove each Bedrock Converse CALL SITE actually routes through them — the
 * exact regression the issues describe was a correct helper that only the
 * judge path used. Scenario modeled: an eu-central-1 user whose default
 * model is a new-generation Claude (deprecates temperature) and whose
 * registry id carries the `us.` prefix. Every call site must (a) re-home
 * the prefix to `eu.` and (b) omit temperature.
 */

import { generateEvals } from '@/services/skills/evalGenerator';
import { proposeImprovement } from '@/services/skills/improver';
import type { Skill, SkillBenchmarkResult } from '@/types';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  ConverseCommand: jest.fn((input: any) => input),
  ConverseStreamCommand: jest.fn((input: any) => input),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

const VALID_EVALS_JSON = JSON.stringify({
  evals: [
    {
      id: 'e1',
      prompt: 'Test prompt',
      assertions: [{ text: 'does the thing' }],
    },
  ],
});

function makeSkill(): Skill {
  return {
    metadata: { name: 'test-skill', description: 'A test skill' },
    instructions: 'Do the thing carefully.',
    path: '/tmp/fake-skill',
  } as unknown as Skill;
}

function makeBenchmark(): SkillBenchmarkResult {
  return {
    skillName: 'test-skill',
    run_summary: {
      with_skill: { pass_rate: { mean: 0.5 } },
      without_skill: { pass_rate: { mean: 0.5 } },
      delta: { pass_rate: 0 },
    },
  } as unknown as SkillBenchmarkResult;
}

describe('Bedrock call-site wiring (#298 region prefix, #299 temperature)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('evalGenerator.generateEvals', () => {
    it('re-homes a us. inference profile to eu. when running in an EU region', async () => {
      process.env.AWS_REGION = 'eu-central-1';
      mockSend.mockResolvedValue({
        output: { message: { content: [{ text: `<EVALS_JSON>${VALID_EVALS_JSON}</EVALS_JSON>` }] } },
      });

      await generateEvals(makeSkill(), 'http://localhost:4001', 'us.anthropic.claude-sonnet-4-6').catch(() => {});

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.modelId).toBe('eu.anthropic.claude-sonnet-4-6');
    });

    it('omits temperature for a model that deprecated it, keeps it for one that accepts it', async () => {
      process.env.AWS_REGION = 'us-east-1';
      mockSend.mockResolvedValue({
        output: { message: { content: [{ text: `<EVALS_JSON>${VALID_EVALS_JSON}</EVALS_JSON>` }] } },
      });

      await generateEvals(makeSkill(), 'http://localhost:4001', 'us.anthropic.claude-sonnet-4-6').catch(() => {});
      expect(mockSend.mock.calls[0][0].inferenceConfig.temperature).toBeUndefined();
      expect(mockSend.mock.calls[0][0].inferenceConfig.maxTokens).toBe(4096);

      await generateEvals(makeSkill(), 'http://localhost:4001', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0').catch(() => {});
      expect(mockSend.mock.calls[1][0].inferenceConfig.temperature).toBe(0.7);
    });
  });

  describe('improver.proposeImprovement', () => {
    it('applies region re-homing and temperature omission to the improvement call', async () => {
      process.env.AWS_REGION = 'ap-southeast-2';
      mockSend.mockResolvedValue({
        output: { message: { content: [{ text: 'no markers' }] } },
      });

      await proposeImprovement({
        skill: makeSkill(),
        withSkillGradings: [],
        withoutSkillGradings: [],
        benchmark: makeBenchmark(),
        serverBaseUrl: 'http://localhost:4001',
        modelId: 'us.anthropic.claude-opus-4-8',
      }).catch(() => {});

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.modelId).toBe('apac.anthropic.claude-opus-4-8');
      expect(cmd.inferenceConfig.temperature).toBeUndefined();
      expect(cmd.inferenceConfig.maxTokens).toBe(8192);
    });

    it('keeps temperature 0.3 for a model that still accepts it', async () => {
      process.env.AWS_REGION = 'us-west-2';
      mockSend.mockResolvedValue({
        output: { message: { content: [{ text: 'no markers' }] } },
      });

      await proposeImprovement({
        skill: makeSkill(),
        withSkillGradings: [],
        withoutSkillGradings: [],
        benchmark: makeBenchmark(),
        serverBaseUrl: 'http://localhost:4001',
        modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      }).catch(() => {});

      expect(mockSend.mock.calls[0][0].inferenceConfig.temperature).toBe(0.3);
    });
  });
});
