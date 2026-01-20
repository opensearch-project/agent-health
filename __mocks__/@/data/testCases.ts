/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { TestCase } from '@/types';

/**
 * Mock test cases for testing
 */
export const TEST_CASES: TestCase[] = [
  {
    id: 'tc-1',
    name: 'Mock Test Case 1',
    description: 'Mock test case for RCA',
    initialPrompt: 'Find errors in logs',
    expectedOutcomes: ['Identify error patterns'],
    category: 'RCA',
    context: [],
    versions: [{
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      initialPrompt: 'Find errors in logs',
      context: [],
      expectedOutcomes: ['Identify error patterns'],
    }],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    labels: ['difficulty:Medium', 'category:RCA'],
    currentVersion: 1,
    difficulty: 'Medium',
    isPromoted: true,
  },
  {
    id: 'tc-2',
    name: 'Mock Test Case 2',
    description: 'Mock test case for Alerts',
    initialPrompt: 'Check cluster health',
    expectedOutcomes: ['Report cluster status'],
    category: 'Alerts',
    context: [],
    versions: [{
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      initialPrompt: 'Check cluster health',
      context: [],
      expectedOutcomes: ['Report cluster status'],
    }],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    labels: ['difficulty:Easy', 'category:Alerts'],
    currentVersion: 1,
    difficulty: 'Easy',
    isPromoted: true,
  },
];

export const USE_CASES = TEST_CASES;

export default TEST_CASES;
