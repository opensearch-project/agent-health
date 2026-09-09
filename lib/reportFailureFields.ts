/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The report fields that describe a terminal FAILURE of a test-case run
 * (`failureStage` + the stage-specific detail). Every persistence seam that
 * hand-copies report fields into a storage doc (there are several: the
 * client-side `asyncRunStorage` write/update mappers, `saveReportWithClient`,
 * the benchmarkRunner placeholder-update path, the summary projection) must
 * carry these too — otherwise the runner records the real agent cause and
 * storage silently drops it, which is exactly how the owner's 5 timed-out
 * cases ended up with an empty `error` field. Keeping the list in ONE place
 * means adding a field later is a one-line change.
 */

/** Stored-doc field names carrying failure detail (same names app-side). */
export const REPORT_FAILURE_FIELDS = ['error', 'failureStage', 'agentError', 'judgeError'] as const;

export type ReportFailureField = (typeof REPORT_FAILURE_FIELDS)[number];

/**
 * Copy every defined failure field from `source` onto `target` (mutates and
 * returns `target`). `null` is copied as-is so a caller can clear a stale
 * value on a partial update.
 */
export function copyReportFailureFields<T extends Record<string, any>>(
  source: Record<string, any> | null | undefined,
  target: T,
): T {
  if (!source) return target;
  for (const field of REPORT_FAILURE_FIELDS) {
    if (source[field] !== undefined) (target as any)[field] = source[field];
  }
  return target;
}

/** Pick just the failure fields (for spreading into a doc). */
export function pickReportFailureFields(source: Record<string, any> | null | undefined): Partial<Record<ReportFailureField, unknown>> {
  return copyReportFailureFields(source, {} as Partial<Record<ReportFailureField, unknown>>);
}
