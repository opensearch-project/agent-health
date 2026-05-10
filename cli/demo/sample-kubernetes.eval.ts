/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Example: Suite with shared defaults using defineTestSuite()
 *
 * All test cases inherit category: 'Kubernetes' and difficulty: 'Hard'
 * unless they override with their own values.
 *
 * Usage:
 *   npx agent-health benchmark -f cli/demo/sample-kubernetes.eval.ts -a demo
 */

import { defineTestSuite } from '@opensearch-project/agent-health';

export default defineTestSuite({
  name: 'Kubernetes Diagnostics',
  defaults: {
    category: 'Kubernetes',
    difficulty: 'Hard',
    context: [
      { description: 'Cluster', value: 'production / us-east-1 / EKS 1.28' },
    ],
  },
  cases: [
    {
      name: 'Pod CrashLoopBackOff',
      prompt: 'Pod payment-service-7f8b9c is in CrashLoopBackOff after latest deploy',
      expect: [
        'Check container exit code and OOM kill status',
        'Review recent image changes',
        'Inspect resource limits vs actual usage',
      ],
    },
    {
      name: 'Node NotReady',
      prompt: 'Node ip-10-0-1-42 is reporting NotReady condition for 5 minutes',
      expect: [
        'Check kubelet status and logs',
        'Identify disk or memory pressure conditions',
        'Verify network connectivity to control plane',
      ],
    },
    {
      name: 'Service Unreachable',
      prompt: 'Service orders-api returning connection refused for all endpoints',
      context: [
        { description: 'Service Status', value: 'Endpoints: 0/3 ready' },
      ],
      expect: [
        'Verify pod selector labels match service selector',
        'Check endpoint objects for registered addresses',
        'Inspect pod readiness probe status',
      ],
    },
    {
      name: 'HPA Scaling Failure',
      difficulty: 'Medium',
      prompt: 'HPA for checkout-service stuck at 2 replicas despite 90% CPU',
      expect: [
        'Check HPA status conditions for errors',
        'Verify metrics-server is reporting current values',
        'Check if max replicas limit is reached',
      ],
    },
  ],
});
