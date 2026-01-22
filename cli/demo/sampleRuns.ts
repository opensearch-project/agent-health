/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Runs for Demo Mode
 *
 * Pre-completed evaluation runs with realistic trajectories.
 * Always visible alongside real runs - IDs prefixed with 'demo-'.
 */

import type { TestCaseRun, TrajectoryStep, ToolCallStatus } from '../../types/index.js';

// Helper to generate trajectory step IDs
let stepIdCounter = 0;
function stepId(): string {
  return `demo-step-${++stepIdCounter}`;
}

function createStep(
  type: TrajectoryStep['type'],
  content: string,
  extras?: Partial<TrajectoryStep>
): TrajectoryStep {
  return {
    id: stepId(),
    timestamp: Date.now(),
    type,
    content,
    ...extras,
  };
}

export const SAMPLE_RUNS: TestCaseRun[] = [
  // Demo Report 001 - Payment Service Latency Spike
  {
    id: 'demo-report-001',
    timestamp: '2024-01-15T10:05:00.000Z',
    testCaseId: 'demo-otel-001',
    testCaseVersion: 1,
    experimentId: 'demo-benchmark-001',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-001',
    trajectory: [
      createStep('thinking', 'The user is reporting a 5x latency increase in the payment service. P99 went from 200ms to 1000ms. I need to investigate the traces to identify the bottleneck.'),
      createStep('action', 'Querying traces for payment-service to analyze latency distribution', {
        toolName: 'QueryTraces',
        toolArgs: { service: 'payment-service', timeRange: '1h', metric: 'latency' },
      }),
      createStep('tool_result', 'Found 1,243 traces. Average latency: 950ms. P99: 1,050ms. Breakdown:\n- payment-service internal: 50ms (5%)\n- fraud-detection call: 120ms (12%)\n- stripe-gateway call: 780ms (82%)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'The trace data shows 82% of latency is coming from the Stripe gateway calls. Let me check if there were any recent deployments that might correlate with this.'),
      createStep('action', 'Checking recent deployments for payment-service and related services', {
        toolName: 'GetDeployments',
        toolArgs: { services: ['payment-service', 'fraud-detection'], timeRange: '24h' },
      }),
      createStep('tool_result', 'Recent deployments:\n- payment-service v2.3.1: 3 hours ago (connection pool config change)\n- fraud-detection v1.8.0: 6 hours ago (new ML model)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'The payment-service deployment 3 hours ago changed connection pool config. The latency spike timing correlates with this. However, the trace data shows the bottleneck is in external Stripe calls, not internal processing. Let me check Stripe status.'),
      createStep('action', 'Checking external service status for payment gateway', {
        toolName: 'CheckExternalStatus',
        toolArgs: { service: 'stripe', component: 'payment-api' },
      }),
      createStep('tool_result', 'Stripe Status Page: Degraded Performance\n- Payment API: Elevated latency since 2 hours ago\n- Estimated resolution: Under investigation', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Root Cause Analysis\n\n**Root Cause:** External payment gateway (Stripe) experiencing degraded performance.\n\n**Evidence:**\n1. Trace analysis shows 82% of latency (780ms) in Stripe gateway calls\n2. Stripe status page confirms "Elevated latency" starting 2 hours ago\n3. Internal payment-service processing remains fast (50ms)\n\n**Recent Deployment Correlation:**\n- payment-service v2.3.1 (3 hours ago) is NOT the cause\n- Latency increase started 2 hours ago, matching Stripe\'s incident timeline\n\n**Recommendations:**\n1. **Immediate:** Increase timeout for Stripe calls to prevent cascading failures\n2. **Short-term:** Implement circuit breaker for payment gateway\n3. **Long-term:** Consider backup payment provider for redundancy\n\n**Monitoring:** Continue monitoring Stripe status page for resolution updates.'),
    ],
    metrics: {
      accuracy: 92,
    },
    llmJudgeReasoning: 'The agent correctly identified the external payment gateway (Stripe) as the root cause of the latency spike. It systematically analyzed traces, checked deployments, and correlated timing with external service status. The recommendations are practical and address both immediate mitigation and long-term resilience.',
    improvementStrategies: [
      {
        category: 'Tool Usage',
        issue: 'Could check application metrics alongside traces',
        recommendation: 'Query application metrics (error rates, throughput) to get a more complete picture',
        priority: 'low',
      },
    ],
  },

  // Demo Report 002 - Cart Service Error Rate Spike
  {
    id: 'demo-report-002',
    timestamp: '2024-01-15T10:08:00.000Z',
    testCaseId: 'demo-otel-002',
    testCaseVersion: 1,
    experimentId: 'demo-benchmark-001',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-002',
    trajectory: [
      createStep('thinking', 'Error rate jumped from 0.1% to 15% in the cart service. Users are reporting failed checkouts. I need to identify which dependency is failing.'),
      createStep('action', 'Analyzing error traces for cart-service', {
        toolName: 'QueryTraces',
        toolArgs: { service: 'cart-service', status: 'error', timeRange: '30m' },
      }),
      createStep('tool_result', 'Found 450 error traces. Error breakdown:\n- inventory-service: 420 errors (93%)\n- pricing-service: 20 errors (4%)\n- redis-cache: 10 errors (2%)\n\nCommon error: "Connection refused: inventory-service:8080"', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', '93% of errors are from inventory-service. The error message "Connection refused" suggests the service is down or unreachable. Let me check recent deployments.'),
      createStep('action', 'Getting deployment history for inventory-service', {
        toolName: 'GetDeployments',
        toolArgs: { services: ['inventory-service'], timeRange: '4h' },
      }),
      createStep('tool_result', 'inventory-service v3.1.0 deployed 2 hours ago\nChanges: New inventory API, updated health check endpoint\nReplicas: 3/3 running (but 0/3 ready)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Root Cause Analysis\n\n**Root Cause:** inventory-service v3.1.0 deployment failure - pods running but not ready.\n\n**Evidence:**\n1. 93% of cart-service errors originate from inventory-service calls\n2. Error: "Connection refused: inventory-service:8080"\n3. inventory-service v3.1.0 deployed 2 hours ago\n4. Replicas show 3/3 running but 0/3 ready (health check failing)\n\n**Impact:**\n- Cart service error rate: 0.1% → 15%\n- Failed checkouts affecting user experience\n\n**Recommendations:**\n1. **Immediate:** Rollback inventory-service to v3.0.x\n2. **Investigation:** Check v3.1.0 health check endpoint changes\n3. **Prevention:** Add deployment validation gates for readiness'),
    ],
    metrics: {
      accuracy: 95,
    },
    llmJudgeReasoning: 'Excellent root cause identification. The agent correctly traced errors to inventory-service, identified the deployment correlation, and noticed the critical detail that pods were running but not ready. Rollback recommendation is appropriate.',
    improvementStrategies: [],
  },

  // Demo Report 003 - Database Connection Pool Exhaustion
  {
    id: 'demo-report-003',
    timestamp: '2024-01-15T10:12:00.000Z',
    testCaseId: 'demo-otel-003',
    testCaseVersion: 1,
    experimentId: 'demo-benchmark-001',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-003',
    trajectory: [
      createStep('thinking', 'Order-service is experiencing intermittent connection timeouts during a flash sale. This suggests resource exhaustion under load.'),
      createStep('action', 'Querying database metrics for order-service', {
        toolName: 'QueryMetrics',
        toolArgs: { service: 'order-service', metrics: ['db.pool.active', 'db.pool.pending', 'db.query.duration'] },
      }),
      createStep('tool_result', 'Database pool metrics:\n- Active connections: 20/20 (100% - maxed out)\n- Pending requests: 150+ (growing)\n- Avg query duration: 45ms (normal: 15ms)\n- Max query duration: 2,500ms', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'Connection pool is exhausted. Queries are taking 3x longer than normal. Let me identify the slow queries.'),
      createStep('action', 'Analyzing slow queries in database logs', {
        toolName: 'QueryLogs',
        toolArgs: { source: 'postgresql', filter: 'duration > 100ms', timeRange: '1h' },
      }),
      createStep('tool_result', 'Top slow queries:\n1. SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC (avg: 450ms, count: 5,000)\n   - Missing index on (user_id, created_at)\n2. SELECT * FROM order_items WHERE order_id IN (...) (avg: 120ms, count: 3,000)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Root Cause Analysis\n\n**Root Cause:** Database connection pool exhaustion caused by slow queries during flash sale traffic spike.\n\n**Evidence:**\n1. Connection pool at 100% capacity (20/20 active)\n2. 150+ pending requests in queue\n3. Slow query identified: user order history lookup (450ms avg, missing index)\n4. Traffic: 100 req/s → 2000 req/s (20x increase)\n\n**Slow Query:**\n```sql\nSELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC\n```\nMissing composite index on (user_id, created_at)\n\n**Recommendations:**\n1. **Immediate:** Increase connection pool size to 50\n2. **Short-term:** Add index: CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC)\n3. **Medium-term:** Implement read replicas for order history queries\n4. **Long-term:** Add query result caching for frequently accessed data'),
    ],
    metrics: {
      accuracy: 88,
    },
    llmJudgeReasoning: 'The agent correctly identified connection pool exhaustion and traced it to a slow query with a missing index. The multi-step recommendation from immediate to long-term shows good understanding of the problem layers.',
    improvementStrategies: [
      {
        category: 'Analysis Depth',
        issue: 'Could have checked if similar issues occurred in past flash sales',
        recommendation: 'Query historical data to identify recurring patterns',
        priority: 'medium',
      },
    ],
  },

  // Demo Report 004 - Recommendation Service Cold Start
  {
    id: 'demo-report-004',
    timestamp: '2024-01-15T10:16:00.000Z',
    testCaseId: 'demo-otel-004',
    testCaseVersion: 1,
    experimentId: 'demo-benchmark-001',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-004',
    trajectory: [
      createStep('thinking', 'First requests after pod scaling take 30+ seconds, subsequent requests are fast. This is a classic cold start pattern, likely related to initialization.'),
      createStep('action', 'Analyzing startup traces for recommendation-service', {
        toolName: 'QueryTraces',
        toolArgs: { service: 'recommendation-service', spanName: 'startup', timeRange: '2h' },
      }),
      createStep('tool_result', 'Startup trace breakdown:\n- Container start: 2s\n- Dependency injection: 1s\n- S3 model download: 8s\n- Model deserialization: 20s\n- Model warmup inference: 4s\n- Total cold start: 35s', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'The 2GB ML model loading takes 32 seconds (S3 download + deserialization + warmup). The readiness probe might be passing before the model is actually ready.'),
      createStep('action', 'Checking Kubernetes readiness probe configuration', {
        toolName: 'GetK8sConfig',
        toolArgs: { deployment: 'recommendation-service', field: 'readinessProbe' },
      }),
      createStep('tool_result', 'readinessProbe:\n  httpGet:\n    path: /health\n    port: 8080\n  initialDelaySeconds: 10\n  periodSeconds: 5\n  failureThreshold: 3\n\n/health endpoint: Returns 200 after HTTP server starts (before model loads)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Root Cause Analysis\n\n**Root Cause:** Readiness probe misconfiguration - health endpoint returns ready before ML model is loaded.\n\n**Evidence:**\n1. Cold start takes 35 seconds (model loading dominates)\n2. Readiness probe initialDelaySeconds=10, but model needs 35s\n3. /health returns 200 when HTTP server starts, not when model is ready\n4. Kubernetes routes traffic to pod before model can serve requests\n\n**Startup Breakdown:**\n- S3 model download: 8s\n- Model deserialization: 20s\n- Model warmup: 4s\n- Total: 32s for model, 35s overall\n\n**Recommendations:**\n1. **Immediate:** Increase initialDelaySeconds to 40\n2. **Better:** Update /health to check model.isReady() status\n3. **Optimal:** Use init container for model download, reduce startup to ~25s\n4. **Scaling:** Pre-warm pods during low traffic to handle spikes'),
    ],
    metrics: {
      accuracy: 90,
    },
    llmJudgeReasoning: 'The agent correctly identified the readiness probe misconfiguration as the root cause. It provided a clear breakdown of the cold start time and offered multiple solutions from quick fix to optimal architecture.',
    improvementStrategies: [
      {
        category: 'Completeness',
        issue: 'Could suggest model caching strategies',
        recommendation: 'Recommend persistent volume for model or model registry with caching',
        priority: 'low',
      },
    ],
  },

  // Demo Report 005 - Cascading Failure Investigation
  {
    id: 'demo-report-005',
    timestamp: '2024-01-15T10:20:00.000Z',
    testCaseId: 'demo-otel-005',
    testCaseVersion: 1,
    experimentId: 'demo-benchmark-001',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'failed',
    runId: 'demo-agent-run-005',
    trajectory: [
      createStep('thinking', 'Multiple services failing in sequence: notification → order → user. This looks like a cascading failure. I need to trace the failure propagation.'),
      createStep('action', 'Getting timeline of service errors', {
        toolName: 'QueryMetrics',
        toolArgs: { metrics: ['error_rate'], services: ['notification-service', 'order-service', 'user-service'], timeRange: '30m' },
      }),
      createStep('tool_result', 'Error timeline:\n- T+0: notification-service errors spike to 100%\n- T+5m: order-service error rate rises to 40%\n- T+10m: user-service error rate rises to 25%\n- Circuit breakers: Not triggering', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'notification-service failed first, then propagated to dependent services. Circuit breakers aren\'t working. Let me check the notification-service root cause.'),
      createStep('action', 'Checking notification-service dependencies and errors', {
        toolName: 'QueryTraces',
        toolArgs: { service: 'notification-service', status: 'error', timeRange: '30m' },
      }),
      createStep('tool_result', 'notification-service errors:\n- 100% of errors from Twilio SMS API calls\n- Error: "Service Unavailable - Twilio experiencing outage"\n- Retry attempts: 3 per request (each timing out at 30s)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'Twilio outage is the root cause. The 30s timeout with 3 retries means each notification takes 90s, blocking threads. This explains why circuit breakers didn\'t help - they\'re probably not wrapping the async notification calls.'),
      createStep('action', 'Checking circuit breaker configuration', {
        toolName: 'GetConfig',
        toolArgs: { service: 'notification-service', config: 'circuitBreaker' },
      }),
      createStep('tool_result', 'Circuit breaker config:\n- Enabled: true\n- Failure threshold: 50% in 10s\n- Applied to: sync HTTP calls only\n- Issue: Async notification calls NOT wrapped with circuit breaker', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Root Cause Analysis\n\n**Root Cause:** Twilio SMS provider outage caused cascading failures due to misconfigured circuit breakers.\n\n**Failure Chain:**\n1. Twilio SMS API outage (external)\n2. notification-service: 90s timeout per request (30s × 3 retries)\n3. order-service: Blocked waiting for notifications\n4. user-service: Blocked waiting for order confirmations\n\n**Why Circuit Breakers Failed:**\n- Circuit breakers only wrap synchronous HTTP calls\n- Async notification calls bypass circuit breaker protection\n- Result: No automatic failure isolation\n\n**Recommendations:**\n1. **Immediate:** Disable SMS notifications temporarily\n2. **Short-term:** Wrap async calls with circuit breaker\n3. **Medium-term:** Make notifications fire-and-forget (don\'t block order flow)\n4. **Long-term:** Implement fallback notification channels (email, push)'),
    ],
    metrics: {
      accuracy: 75,
    },
    llmJudgeReasoning: 'The agent correctly identified the Twilio outage as the root cause and traced the cascade. However, it missed checking if there were any retry storms or thread pool exhaustion that might have accelerated the cascade. The circuit breaker misconfiguration insight was valuable.',
    improvementStrategies: [
      {
        category: 'Analysis Depth',
        issue: 'Did not investigate thread pool metrics',
        recommendation: 'Check thread pool utilization to understand blocking behavior better',
        priority: 'high',
      },
      {
        category: 'Tool Usage',
        issue: 'Could have checked for retry storms',
        recommendation: 'Analyze retry patterns to see if exponential backoff was used',
        priority: 'medium',
      },
    ],
  },
];

/**
 * Get a sample run by ID
 */
export function getSampleRun(id: string): TestCaseRun | undefined {
  return SAMPLE_RUNS.find(run => run.id === id);
}

/**
 * Get all sample runs
 */
export function getAllSampleRuns(): TestCaseRun[] {
  return [...SAMPLE_RUNS];
}

/**
 * Get sample runs by test case ID
 */
export function getSampleRunsByTestCase(testCaseId: string): TestCaseRun[] {
  return SAMPLE_RUNS.filter(run => run.testCaseId === testCaseId);
}

/**
 * Get sample runs by benchmark ID
 */
export function getSampleRunsByBenchmark(benchmarkId: string): TestCaseRun[] {
  return SAMPLE_RUNS.filter(run => run.experimentId === benchmarkId);
}

/**
 * Get sample runs by benchmark run ID
 */
export function getSampleRunsByBenchmarkRun(benchmarkId: string, benchmarkRunId: string): TestCaseRun[] {
  return SAMPLE_RUNS.filter(run => run.experimentId === benchmarkId && run.experimentRunId === benchmarkRunId);
}

// Backwards compatibility aliases
/** @deprecated Use getSampleRunsByBenchmark instead */
export const getSampleRunsByExperiment = getSampleRunsByBenchmark;
/** @deprecated Use getSampleRunsByBenchmarkRun instead */
export const getSampleRunsByExperimentRun = getSampleRunsByBenchmarkRun;

/**
 * Check if an ID is a sample run
 */
export function isSampleRunId(id: string): boolean {
  return id.startsWith('demo-report-') || id.startsWith('demo-run-');
}
