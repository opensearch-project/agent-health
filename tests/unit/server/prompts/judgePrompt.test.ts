/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { JUDGE_SYSTEM_PROMPT } from '@/server/prompts/judgePrompt';

describe('judgePrompt', () => {
  describe('JUDGE_SYSTEM_PROMPT', () => {
    it('should be a non-empty string', () => {
      expect(typeof JUDGE_SYSTEM_PROMPT).toBe('string');
      expect(JUDGE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    it('should contain evaluation guidelines', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Evaluation Guidelines');
    });

    it('should explain accuracy calculation', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Accuracy Calculation');
      expect(JUDGE_SYSTEM_PROMPT).toContain('accuracy');
    });

    it('should define pass/fail determination', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Pass/Fail Determination');
      expect(JUDGE_SYSTEM_PROMPT).toContain('PASS');
      expect(JUDGE_SYSTEM_PROMPT).toContain('FAIL');
    });

    it('should specify the output format', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Output Format');
      expect(JUDGE_SYSTEM_PROMPT).toContain('pass_fail_status');
      expect(JUDGE_SYSTEM_PROMPT).toContain('accuracy');
      expect(JUDGE_SYSTEM_PROMPT).toContain('reasoning');
    });

    it('should mention JSON output requirement', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('JSON');
    });

    it('should define critical failures', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Critical failures');
      expect(JUDGE_SYSTEM_PROMPT).toContain('wrong conclusions');
    });

    it('should describe achievement levels', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Fully achieved');
      expect(JUDGE_SYSTEM_PROMPT).toContain('Partially achieved');
      expect(JUDGE_SYSTEM_PROMPT).toContain('Did not achieve');
    });

    it('should include pass threshold of 70', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('70');
    });

    it('should specify required output fields', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('pass_fail_status');
      expect(JUDGE_SYSTEM_PROMPT).toContain('accuracy');
      expect(JUDGE_SYSTEM_PROMPT).toContain('reasoning');
      expect(JUDGE_SYSTEM_PROMPT).toContain('improvement_strategies');
    });

    it('should mention evaluator role for RCA agents', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Root Cause Analysis');
      expect(JUDGE_SYSTEM_PROMPT).toContain('RCA');
      expect(JUDGE_SYSTEM_PROMPT).toContain('observability');
    });
  });
});
