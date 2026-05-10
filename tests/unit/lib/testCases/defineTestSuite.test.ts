/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineTestSuite } from '@/lib/testCases/defineTestSuite';

describe('defineTestSuite()', () => {
  it('applies shared category default to all cases', () => {
    const result = defineTestSuite({
      defaults: { category: 'Kubernetes' },
      cases: [
        { name: 'Test A', prompt: 'Prompt A', expect: ['outcome A'] },
        { name: 'Test B', prompt: 'Prompt B', expect: ['outcome B'] },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0].category).toBe('Kubernetes');
    expect(result[1].category).toBe('Kubernetes');
  });

  it('applies shared difficulty default to all cases', () => {
    const result = defineTestSuite({
      defaults: { category: 'RCA', difficulty: 'Hard' },
      cases: [
        { name: 'Test A', prompt: 'Prompt A', expect: ['outcome'] },
        { name: 'Test B', prompt: 'Prompt B', expect: ['outcome'] },
      ],
    });

    expect(result[0].difficulty).toBe('Hard');
    expect(result[1].difficulty).toBe('Hard');
  });

  it('allows individual cases to override defaults', () => {
    const result = defineTestSuite({
      defaults: { category: 'Kubernetes', difficulty: 'Hard' },
      cases: [
        { name: 'Easy one', prompt: 'Simple', difficulty: 'Easy', expect: ['outcome'] },
        { name: 'Hard one', prompt: 'Complex', expect: ['outcome'] },
      ],
    });

    expect(result[0].difficulty).toBe('Easy');
    expect(result[1].difficulty).toBe('Hard');
  });

  it('applies shared context to cases without their own context', () => {
    const sharedContext = [{ description: 'Cluster', value: 'prod-us-east-1' }];
    const result = defineTestSuite({
      defaults: { category: 'K8s', context: sharedContext },
      cases: [
        { name: 'Test A', prompt: 'Prompt A', expect: ['outcome'] },
        { name: 'Test B', prompt: 'Prompt B', context: [{ description: 'Override', value: 'val' }], expect: ['outcome'] },
      ],
    });

    expect(result[0].context).toEqual(sharedContext);
    expect(result[1].context).toEqual([{ description: 'Override', value: 'val' }]);
  });

  it('uses General category when no default and no case category', () => {
    const result = defineTestSuite({
      cases: [
        { name: 'Test', prompt: 'Prompt', expect: ['outcome'] },
      ],
    });

    expect(result[0].category).toBe('General');
  });

  it('uses Medium difficulty when no default and no case difficulty', () => {
    const result = defineTestSuite({
      cases: [
        { name: 'Test', prompt: 'Prompt', expect: ['outcome'] },
      ],
    });

    expect(result[0].difficulty).toBe('Medium');
  });

  it('applies subcategory default', () => {
    const result = defineTestSuite({
      defaults: { category: 'Database', subcategory: 'Connection Issues' },
      cases: [
        { name: 'Test', prompt: 'Prompt', expect: ['outcome'] },
      ],
    });

    expect(result[0].subcategory).toBe('Connection Issues');
  });

  it('maps prompt and expect fields correctly', () => {
    const result = defineTestSuite({
      defaults: { category: 'RCA' },
      cases: [
        { name: 'CPU Test', prompt: 'High CPU on server', expect: ['Find process', 'Suggest fix'] },
      ],
    });

    expect(result[0].name).toBe('CPU Test');
    expect(result[0].initialPrompt).toBe('High CPU on server');
    expect(result[0].expectedOutcomes).toEqual(['Find process', 'Suggest fix']);
  });

  it('handles empty defaults object', () => {
    const result = defineTestSuite({
      defaults: {},
      cases: [
        { name: 'Test', prompt: 'Prompt', expect: ['outcome'] },
      ],
    });

    expect(result[0].category).toBe('General');
    expect(result[0].difficulty).toBe('Medium');
  });

  it('includes optional suite name without affecting output', () => {
    const result = defineTestSuite({
      name: 'My Suite',
      defaults: { category: 'RCA' },
      cases: [
        { name: 'Test', prompt: 'Prompt', expect: ['outcome'] },
      ],
    });

    // Suite name is metadata only, doesn't appear in test case output
    expect(result[0].name).toBe('Test');
    expect(result).toHaveLength(1);
  });
});
