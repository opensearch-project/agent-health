/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export { expect } from './expect.js';
export type { TracesAccessor } from './traces.js';
export { buildTracesAccessor, emptyTracesAccessor, unavailableTracesAccessor } from './traces.js';
export type { MatcherResult, MatcherMethod } from './types.js';
export {
  getJudgeMatcherResults,
  getJudgeReasoningText,
  recordJudgeMatcherResult,
  buildJudgeMatcherEntry,
  formatExpectedOutcomesAsClaim,
} from './judgeAccessor.js';
export type { JudgeAccessReport, JudgeResultLike } from './judgeAccessor.js';
export {
  startSession,
  endSession,
  isSessionActive,
  recordVerdict,
  recordWithTiming,
  runInSession,
} from './session.js';
