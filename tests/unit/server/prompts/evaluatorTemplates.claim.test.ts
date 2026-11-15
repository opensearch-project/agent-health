/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The neutral `system-claim` evaluator (#619): the id the SDK `judge()` sends
 * when nothing else names an evaluator must resolve on the server, be a
 * domain-neutral LLM evaluator with the RCA-compatible output contract, and
 * be the evaluator `/api/judge`'s dispatch actually applies.
 */

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import {
  CLAIM_EVALUATOR_ID as SERVER_CLAIM_EVALUATOR_ID,
  DEFAULT_EVALUATOR_ID,
  getDefaultEvaluator,
  getSystemEvaluatorById,
  getSystemEvaluators,
  isSystemEvaluatorId,
} from '@/server/prompts/evaluatorTemplates';
import { CLAIM_EVALUATOR_ID } from '@/lib/testCases/judge';
import { runJudge, type JudgeConfig } from '@/services/judge/runJudge';

describe('system-claim evaluator (#619)', () => {
  it('the id the SDK sends is the id the server defines, and it resolves as a system evaluator', () => {
    expect(CLAIM_EVALUATOR_ID).toBe(SERVER_CLAIM_EVALUATOR_ID);
    expect(isSystemEvaluatorId(CLAIM_EVALUATOR_ID)).toBe(true);
    const ev = getSystemEvaluatorById(CLAIM_EVALUATOR_ID);
    expect(ev).toBeDefined();
    expect(ev!.isSystem).toBe(true);
    expect(ev!.name).toBe('Claim');
    expect(getSystemEvaluators().map(e => e.id)).toContain(CLAIM_EVALUATOR_ID);
  });

  it('is NOT the server default — explicit -e and legacy classic runs keep the RCA default', () => {
    expect(DEFAULT_EVALUATOR_ID).toBe('system-rca-default');
    expect(getDefaultEvaluator().id).toBe('system-rca-default');
    expect(CLAIM_EVALUATOR_ID).not.toBe(DEFAULT_EVALUATOR_ID);
  });

  it('is an LLM evaluator with the RCA-compatible contract (single accuracy metric, llm-verdict policy), all-claims pass threshold', () => {
    const ev = getSystemEvaluatorById(CLAIM_EVALUATOR_ID)!;
    expect(ev.kind).toBeUndefined(); // not deterministic — /api/judge serves it
    expect(ev.systemPrompt.length).toBeGreaterThan(200);
    expect(ev.scoringConfig.metrics.map(m => m.name)).toEqual(['accuracy']);
    expect(ev.scoringConfig.passPolicy).toEqual({ kind: 'llm-verdict' });
    expect(ev.scoringConfig.passThreshold).toBe(100);
    // Domain-neutral: the prompt must not steer the judge towards RCA.
    expect(ev.systemPrompt).not.toMatch(/root cause|RCA|observability/i);
    expect(getDefaultEvaluator().systemPrompt).toMatch(/Root Cause Analysis/);
  });

  it('/api/judge dispatch applies it: the verdict is frozen with scoringSnapshot.evaluatorId = system-claim (demo provider, no network)', async () => {
    const config: JudgeConfig = {
      models: { 'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo', provider: 'demo' } as any },
    };
    const result: any = await runJudge(
      {
        trajectory: [{ type: 'response', content: 'Here are three running shoes under $100.' }],
        expectedOutcomes: ['every returned item is a running shoe under $100'],
        evaluatorId: CLAIM_EVALUATOR_ID,
        modelId: 'demo-model',
      },
      { getEvaluator: jest.fn(async () => null), config },
    );
    expect(result.scoringSnapshot).toMatchObject({ evaluatorId: 'system-claim', evaluatorName: 'Claim' });
    expect(['passed', 'failed']).toContain(result.passFailStatus);
  });
});
