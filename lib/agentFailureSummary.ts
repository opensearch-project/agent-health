/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Presentation of a run's `agentFailureSummary` (see
 * `services/evaluation/agentReachability.ts` → `EndpointCircuitBreaker.summary()`).
 * Two shapes exist:
 *   - `Agent endpoint unreachable — N consecutive … (CODE, host); …` when the
 *     run's endpoint circuit breaker opened (connection failures and/or
 *     empty responses);
 *   - `N cases returned an empty response (no steps, no answer, no results) —
 *     not judged` when cases came back empty but the breaker never tripped.
 * The runs-list badge and the run-page banners word themselves accordingly;
 * a breaker that opened on empty responses alone is presented as "Empty
 * responses" (the endpoint answers, with nothing), not as unreachable. The
 * coupling to the summary wording is locked by tests on both ends
 * (`EndpointCircuitBreaker.summary()` and this helper).
 */

export interface AgentFailureSummaryPresentation {
  /** The endpoint breaker opened during the run. */
  unreachable: boolean;
  /** Short badge label for the runs list. */
  badge: string;
  /** Remedy sentence appended to the banner. */
  remedy: string;
}

export function presentAgentFailureSummary(summary: string): AgentFailureSummaryPresentation {
  const unreachable = summary.startsWith('Agent endpoint unreachable');
  if (!unreachable) {
    return {
      unreachable,
      badge: 'Empty responses',
      remedy: 'the agent answered with nothing to judge on these cases; check the agent and re-run them.',
    };
  }
  // The breaker opened on empty responses ALONE: the endpoint is reachable
  // but returns nothing — say that, not "unreachable" (codex_review).
  if (/consecutive empty responses?\b/.test(summary) && !/connection failure|agent failure/.test(summary)) {
    return {
      unreachable,
      badge: 'Empty responses',
      remedy: 'the endpoint answers but returns nothing to judge; check the agent and re-run — the remaining cases were not attempted.',
    };
  }
  return {
    unreachable,
    badge: 'Agent unreachable',
    remedy: 'check the agent endpoint and re-run; nothing was judged.',
  };
}
