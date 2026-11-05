/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Truthful judge labels for SDK (deterministic) reports.
 *
 * The runners bind the `judge` fixture to the run-level evaluator + judge
 * model with `bindJudge(defaults, { authoritative: true })`. After the test
 * body finishes, this helper copies what the binding ACTUALLY sent to
 * `/api/judge` onto the report:
 *
 *   - `judgeApplied`             — per-field value + source ('run' | 'body' | 'default')
 *   - `judgeSelectionConflicts`  — body pins the run selection overrode
 *   - `evaluatorId` / `judgeModelId` — re-stamped so the LABEL names the
 *     judge that produced the verdict (pre-fix: verdict from the body's pin,
 *     label from the run's choice)
 *
 * and emits ONE structured warning per conflicting field through the
 * runner's own logging. Never throws — the run must complete.
 *
 * Shared by services/evaluationRunner.ts and services/benchmarkRunner.ts.
 */

import type { JudgeSelectionSnapshot } from '@/lib/testCases/judge';
import type { JudgeSelectionConflict } from '@/types';

export interface StampJudgeSelectionContext {
  testCaseId: string;
  testCaseName?: string;
  /** Prefix for the warn line, e.g. `[EvaluationRunner]`. */
  logPrefix: string;
  /** Injectable for tests; defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * Stamp `judgeApplied` / `judgeSelectionConflicts` and truthful
 * `evaluatorId` / `judgeModelId` labels onto `report`.
 *
 * No-op when the body made no judge calls through the bound fixture — there
 * is nothing "applied" to record, and the run-level labels the runner stamps
 * elsewhere remain the only (honest) statement of intent.
 */
export function stampJudgeSelection(
  report: Record<string, any>,
  selection: JudgeSelectionSnapshot | undefined,
  run: { evaluatorId?: string; judgeModelId?: string },
  ctx: StampJudgeSelectionContext,
): void {
  if (!selection || selection.judgeCalls === 0) return;

  report.judgeApplied = selection.applied;

  // Labels follow what applied. When the run selected the field, applied ==
  // run value (authoritative) so this is a no-op; when the run did NOT select
  // it and the body pinned one value on every call, the label now names that
  // value instead of being blank; divergent body pins leave it undefined
  // (per-call truth is on matcherResults[].evaluatorId / .model).
  report.evaluatorId = selection.applied.evaluatorId ?? run.evaluatorId;
  report.judgeModelId = selection.applied.modelId ?? run.judgeModelId;

  if (selection.conflicts.length > 0) {
    report.judgeSelectionConflicts = selection.conflicts;
    const warn = ctx.warn ?? ((m: string) => console.warn(m));
    for (const line of formatJudgeSelectionConflictWarnings(selection.conflicts, ctx)) warn(line);
  }
}

/**
 * One line per conflicting FIELD (body values joined) so a body that pins
 * several different evaluators still yields a single warning per field.
 */
export function formatJudgeSelectionConflictWarnings(
  conflicts: JudgeSelectionConflict[],
  ctx: Pick<StampJudgeSelectionContext, 'testCaseId' | 'testCaseName' | 'logPrefix'>,
): string[] {
  const byField = new Map<string, { runValue: string; bodyValues: string[] }>();
  for (const c of conflicts) {
    const entry = byField.get(c.field) ?? { runValue: c.runValue, bodyValues: [] };
    if (!entry.bodyValues.includes(c.bodyValue)) entry.bodyValues.push(c.bodyValue);
    byField.set(c.field, entry);
  }
  const label = ctx.testCaseName ? `"${ctx.testCaseName}" (${ctx.testCaseId})` : ctx.testCaseId;
  return Array.from(byField.entries()).map(([field, { runValue, bodyValues }]) =>
    `${ctx.logPrefix} judge selection conflict on test case ${label}: the eval body pinned ` +
    `${field}=${bodyValues.map(v => JSON.stringify(v)).join(', ')} but the run selected ${JSON.stringify(runValue)} — ` +
    `run selection applied (body pins only apply when the run does not select a ${field}).`
  );
}
