/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ONE verdict classifier for a code-SDK (`.eval.*`) matcher session.
 *
 * Both runners — `services/evaluationRunner.ts` (CLI / `POST
 * /api/storage/evaluation-runs`) and `services/benchmarkRunner.ts` (`POST
 * /api/storage/benchmarks/:id/execute`, `/api/evaluate`) — used to compute
 * these booleans inline, as two hand-mirrored copies. They drifted: #339 added
 * the "a recorded gate failure is a FAILED test, not an agent error" guard to
 * evaluationRunner only, so a body like
 *
 *     let err = '';
 *     try { await agent.run(); } catch (e) { err = String(e); }
 *     expect(err).to.equal('');          // records a failed code-assertion AND throws
 *
 * was a FAILED case from the CLI but an AGENT ERROR (`failureStage: 'agent'`,
 * `metricsStatus: 'error'`, `passFailStatus: null`, excluded from the pass
 * rate) from the benchmark runner for the very same agent reply. Deciding the
 * outcome here, and only here, is what stops the two paths drifting again.
 *
 * Decision table (first matching row wins):
 *
 * | errored matcher (judge/evaluator could not run) | → `judge_failed`  |
 * | body threw, agent never answered, NO gate ran+failed | → `agent_failed` |
 * | any gate failed OR the body threw                    | → `failed`       |
 * | otherwise                                            | → `passed`       |
 *
 * `agent_failed` keeps #496's semantics: a REAL agent failure (timeout,
 * connection refused, non-2xx that the body did NOT catch) produces no matcher
 * verdict at all — `agent.run()` rejected straight out of the body. The moment
 * the body has recorded a gate verdict (it caught the error and asserted on
 * it), the test ran to a decision and that decision is the result.
 */

import type { MatcherResult } from '@/lib/matchers/types';

export type CaseOutcomeKind = 'passed' | 'failed' | 'agent_failed' | 'judge_failed';

export interface ClassifyCaseOutcomeInput {
  /** Every verdict the matcher session recorded (hooks + body). */
  matcherResults: readonly MatcherResult[];
  /** What `runInSession` caught from the body, or `undefined` if it returned. */
  evalError: unknown;
  /** `true` once `agent.run()` resolved — the agent produced a trajectory. */
  agentResultCaptured: boolean;
}

export interface CaseOutcome {
  kind: CaseOutcomeKind;
  /** Matchers whose judge/evaluator could not run (`errored: true`); the first one's message becomes the `judge_failed` cause. */
  erroredMatchers: MatcherResult[];
}

/**
 * A matcher that gates the verdict: ran, is not observe-only, did not error.
 * The synthetic `notReached` marker (appendNotReachedMarker) is excluded so
 * the classification is the same whether it runs before or after the marker
 * is appended.
 */
const isGatingMatcher = (m: MatcherResult): boolean =>
  m.role !== 'observe' && !m.errored && !m.notReached;

export function classifyCaseOutcome(input: ClassifyCaseOutcomeInput): CaseOutcome {
  const { matcherResults, evalError, agentResultCaptured } = input;
  const bodyThrew = evalError !== undefined;
  const erroredMatchers = matcherResults.filter(m => m.errored);
  const anyGateFailed = matcherResults.some(m => !m.pass && isGatingMatcher(m));

  let kind: CaseOutcomeKind;
  if (erroredMatchers.length > 0) {
    kind = 'judge_failed';
  } else if (bodyThrew && !agentResultCaptured && !anyGateFailed) {
    kind = 'agent_failed';
  } else {
    kind = anyGateFailed || bodyThrew ? 'failed' : 'passed';
  }
  return { kind, erroredMatchers };
}
