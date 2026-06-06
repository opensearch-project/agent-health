/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Assertion Grader
 * Grades individual assertions against agent trajectory
 * by calling the existing /api/judge endpoint.
 */

import type { TrajectoryStep, SkillAssertionResult, SkillGradingResult } from '@/types';
import { debug } from '@/lib/debug';
import { getJudgeReasoningText } from '@/lib/matchers/judgeAccessor';

interface GradeOptions {
  trajectory: TrajectoryStep[];
  assertions: string[];
  serverBaseUrl: string;
  modelId?: string;
  evaluatorId?: string;
}

/**
 * Grade a list of assertions against a trajectory.
 * Each assertion is evaluated independently via the judge API.
 */
export async function gradeAssertions(options: GradeOptions): Promise<SkillGradingResult> {
  const { trajectory, assertions, serverBaseUrl, modelId, evaluatorId } = options;
  const results: SkillAssertionResult[] = [];

  for (const assertion of assertions) {
    debug('SkillGrader', `Grading assertion: "${assertion.substring(0, 60)}..."`);

    try {
      const result = await gradeOneAssertion(trajectory, assertion, serverBaseUrl, modelId, evaluatorId);
      results.push(result);
    } catch (err) {
      debug('SkillGrader', `Grading failed for assertion: ${err}`);
      results.push({
        text: assertion,
        passed: false,
        evidence: `Grading error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  return {
    assertion_results: results,
    summary: {
      passed,
      failed: total - passed,
      total,
      pass_rate: total > 0 ? Math.round((passed / total) * 100) / 100 : 0,
    },
  };
}

async function gradeOneAssertion(
  trajectory: TrajectoryStep[],
  assertion: string,
  serverBaseUrl: string,
  modelId?: string,
  evaluatorId?: string,
): Promise<SkillAssertionResult> {
  const response = await fetch(`${serverBaseUrl}/api/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trajectory,
      expectedOutcomes: [assertion],
      ...(modelId ? { modelId } : {}),
      ...(evaluatorId ? { evaluatorId } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Judge API returned ${response.status}: ${body}`);
  }

  const result = await response.json();

  return {
    text: assertion,
    passed: result.passFailStatus === 'passed',
    evidence: getJudgeReasoningText(result) || 'No reasoning provided',
  };
}
