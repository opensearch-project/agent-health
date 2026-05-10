/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { testCase } from '@/lib/testCases/testCase';

describe('testCase()', () => {
  it('maps SDK fields to internal schema fields', () => {
    const result = testCase('My Test', {
      prompt: 'Investigate the error',
      category: 'RCA',
      difficulty: 'Medium',
      expect: ['Find root cause', 'Suggest fix'],
    });

    expect(result).toEqual({
      name: 'My Test',
      description: '',
      category: 'RCA',
      subcategory: undefined,
      difficulty: 'Medium',
      initialPrompt: 'Investigate the error',
      context: [],
      expectedOutcomes: ['Find root cause', 'Suggest fix'],
    });
  });

  it('includes optional description', () => {
    const result = testCase('Test', {
      prompt: 'Prompt',
      category: 'General',
      difficulty: 'Easy',
      description: 'This tests error handling',
      expect: ['outcome'],
    });

    expect(result.description).toBe('This tests error handling');
  });

  it('includes optional subcategory', () => {
    const result = testCase('Test', {
      prompt: 'Prompt',
      category: 'Kubernetes',
      subcategory: 'Pod Issues',
      difficulty: 'Hard',
      expect: ['outcome'],
    });

    expect(result.subcategory).toBe('Pod Issues');
  });

  it('includes context items', () => {
    const context = [
      { description: 'Logs', value: 'ERROR: connection refused' },
      { description: 'Metrics', value: 'CPU: 95%' },
    ];

    const result = testCase('Test', {
      prompt: 'Prompt',
      category: 'RCA',
      difficulty: 'Medium',
      context,
      expect: ['outcome'],
    });

    expect(result.context).toEqual(context);
  });

  it('defaults context to empty array when not provided', () => {
    const result = testCase('Test', {
      prompt: 'Prompt',
      category: 'RCA',
      difficulty: 'Easy',
      expect: ['outcome'],
    });

    expect(result.context).toEqual([]);
  });

  it('defaults description to empty string when not provided', () => {
    const result = testCase('Test', {
      prompt: 'Prompt',
      category: 'RCA',
      difficulty: 'Easy',
      expect: ['outcome'],
    });

    expect(result.description).toBe('');
  });

  it('preserves multiple expected outcomes', () => {
    const result = testCase('Test', {
      prompt: 'Prompt',
      category: 'RCA',
      difficulty: 'Medium',
      expect: ['first', 'second', 'third'],
    });

    expect(result.expectedOutcomes).toEqual(['first', 'second', 'third']);
  });
});
