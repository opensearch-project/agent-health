/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure logic behind `scripts/backfill-report-run-ids.ts`: decide which
 * persisted reports are missing a `runId` and what value they should get,
 * from the id the agent echoed in its own response body. Kept free of I/O so
 * it is unit-testable and so the rule stays GENERIC — nothing here knows any
 * agent, service name, id prefix, run or date.
 *
 * Two sources, in order:
 *   1. the agent's own `afterResponse` hook (when the caller can load the
 *      config) — authoritative, because it is how the live path derives
 *      `runId` once the hook maps the echoed field;
 *   2. a configurable candidate-field list read from the response top level
 *      (`DEFAULT_ID_FIELDS`), first non-empty string wins.
 */

/** Default response-body fields that commonly carry an agent's per-request id. */
export const DEFAULT_ID_FIELDS = [
  'runId',
  'run_id',
  'session_id',
  'sessionId',
  'conversation_id',
  'conversationId',
  'id',
] as const;

export interface ReportLike {
  id: string;
  runId?: string | null;
  connectorProtocol?: string | null;
  agentKey?: string | null;
  agentId?: string | null;
  rawEvents?: unknown[] | null;
}

export type AfterResponseHook = (ctx: {
  response: unknown;
  trajectory: unknown[];
  runId?: string;
  rawEvents: unknown[];
  metadata?: unknown;
}) => Promise<{ runId?: unknown } | undefined | null> | { runId?: unknown } | undefined | null;

/** The raw agent response for a REST report: the last raw event, if it is an object. */
export function rawResponseOf(report: ReportLike): Record<string, unknown> | undefined {
  const events = Array.isArray(report.rawEvents) ? report.rawEvents : [];
  const last = events.length > 0 ? events[events.length - 1] : undefined;
  return last && typeof last === 'object' && !Array.isArray(last) ? (last as Record<string, unknown>) : undefined;
}

/** First non-empty string under one of `fields` at the response's top level. */
export function pickIdField(
  response: Record<string, unknown> | undefined,
  fields: readonly string[] = DEFAULT_ID_FIELDS
): { field: string; value: string } | undefined {
  if (!response) return undefined;
  for (const field of fields) {
    const v = response[field];
    if (typeof v === 'string' && v.trim()) return { field, value: v };
  }
  return undefined;
}

/** Is this a REST-connector report that is missing its runId? */
export function isCandidate(report: ReportLike): boolean {
  if (report.connectorProtocol !== 'rest') return false;
  return !(typeof report.runId === 'string' && report.runId.length > 0);
}

export interface Resolution {
  reportId: string;
  runId?: string;
  source?: 'hook' | `field:${string}`;
  reason?: string;
}

/**
 * Resolve the runId one report should get. Hook first (authoritative), then
 * the candidate-field rule. Never throws: a hook failure degrades to the
 * field rule with the error recorded in `reason`.
 */
export async function resolveRunId(
  report: ReportLike,
  opts: { idFields?: readonly string[]; hook?: AfterResponseHook } = {}
): Promise<Resolution> {
  const response = rawResponseOf(report);
  if (!response) return { reportId: report.id, reason: 'no raw response body on report' };

  let hookNote = '';
  if (opts.hook) {
    try {
      const out = await opts.hook({ response, trajectory: [], rawEvents: report.rawEvents as unknown[], metadata: undefined });
      const rid = out && typeof out === 'object' ? (out as { runId?: unknown }).runId : undefined;
      if (typeof rid === 'string' && rid.trim()) return { reportId: report.id, runId: rid, source: 'hook' };
      hookNote = 'afterResponse hook returned no runId; ';
    } catch (e) {
      hookNote = `afterResponse hook threw (${e instanceof Error ? e.message : String(e)}); `;
    }
  }

  const picked = pickIdField(response, opts.idFields ?? DEFAULT_ID_FIELDS);
  if (picked) return { reportId: report.id, runId: picked.value, source: `field:${picked.field}` };
  return {
    reportId: report.id,
    reason: `${hookNote}no string id under [${(opts.idFields ?? DEFAULT_ID_FIELDS).join(', ')}] in response (keys: ${Object.keys(response).join(', ') || 'none'})`,
  };
}
