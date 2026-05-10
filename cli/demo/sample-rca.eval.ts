/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Example: Flat test case definitions using defineTestCases() + testCase()
 *
 * Usage:
 *   npx agent-health benchmark -f cli/demo/sample-rca.eval.ts -a demo
 */

import { defineTestCases, testCase } from '@opensearch-project/agent-health';

export default defineTestCases([
  testCase('High CPU Investigation', {
    prompt: 'Web server CPU is at 95%, investigate root cause',
    category: 'RCA',
    difficulty: 'Medium',
    context: [
      { description: 'Server Metrics', value: 'CPU: 95%, Memory: 45%, Disk: 70%' },
      { description: 'Recent Deployments', value: 'v2.3.1 deployed 2 hours ago' },
    ],
    expect: [
      'Identify the process or service causing high CPU utilization',
      'Correlate with recent deployment if applicable',
      'Suggest remediation steps',
    ],
  }),

  testCase('Database Connection Timeout', {
    prompt: 'Application getting connection timeout errors to PostgreSQL database',
    category: 'Database',
    difficulty: 'Hard',
    context: [
      { description: 'Error Logs', value: 'FATAL: too many connections for role "app_user"' },
      { description: 'Connection Pool', value: 'Max: 20, Active: 20, Waiting: 15' },
    ],
    expect: [
      'Check connection pool exhaustion',
      'Identify slow queries holding connections',
      'Suggest pool configuration changes',
    ],
  }),

  testCase('Memory Leak Detection', {
    prompt: 'Java service memory usage growing linearly over 24 hours, approaching OOM',
    category: 'RCA',
    difficulty: 'Hard',
    context: [
      { description: 'Heap Usage', value: 'Initial: 512MB, Current: 3.8GB, Max: 4GB' },
      { description: 'GC Logs', value: 'Full GC frequency increased from 1/hour to 5/minute' },
    ],
    expect: [
      'Identify likely memory leak pattern',
      'Suggest heap dump analysis',
      'Recommend immediate mitigation (restart, increase heap)',
    ],
  }),
]);
