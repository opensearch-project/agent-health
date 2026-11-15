/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory matching of normalized spans against a TracesQueryOptions.
 *
 * Mirrors the OpenSearch DSL in server/services/tracesService.ts (strategies
 * A/B/C/D + must-filters) so backends that fetch a candidate set and filter
 * locally (file store, CloudWatch) return exactly what the cluster would.
 *
 * `sessionId` (Strategy D) is a CORRELATION clause, unioned like traceId /
 * runIds / agents — NOT a must-filter — exactly as tracesService.ts pushes it
 * to `sink`: a stale report session id (e.g. Claude Code's span `session.id`
 * differing from the `session_id` captured on the report) must not zero out
 * spans that traceId / runIds already matched.
 */

import type { TracesQueryOptions } from '../types.js';
import type { Span } from '../../../types/index.js';

export function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== '') return n; // numeric string = epoch ms
    const p = Date.parse(v);
    return Number.isNaN(p) ? 0 : p;
  }
  return 0;
}

export function spanMs(s: Span): number {
  return Date.parse(s.startTime);
}

/** Whether a span's service identity matches `name` (service.name / serviceName / gen_ai.agent.name). */
export function serviceMatches(s: Span, name: string): boolean {
  const a = s.attributes || {};
  return a['service.name'] === name || a['serviceName'] === name || a['gen_ai.agent.name'] === name;
}

/** Mirrors tracesService.ts: 2+ correlation clauses (traceId, runIds, sessionId, each agents entry) → OR semantics. */
export function computeUseUnion(options: TracesQueryOptions): boolean {
  const { traceId, runIds, sessionId, agents } = options;
  return (
    [!!traceId, !!(runIds && runIds.length > 0), !!sessionId].filter(Boolean).length + (agents?.length ?? 0) > 1
  );
}

/** Replicates the OpenSearch bool query (must filters + must/should correlation). */
export function matchesQuery(s: Span, options: TracesQueryOptions, useUnion: boolean): boolean {
  const { traceId, runIds, sessionId, startTime, endTime, serviceName, textSearch, agents } = options;
  const a = s.attributes || {};

  // ---- must-filters (always required) ----
  if (startTime !== undefined && spanMs(s) < toMs(startTime)) return false;
  if (endTime !== undefined && spanMs(s) > toMs(endTime)) return false;
  if (serviceName && !serviceMatches(s, serviceName)) return false;
  if (textSearch) {
    // Parity with the OpenSearch DSL: span name, attribute values, and the
    // ids a user pastes into the search box (trace id / span id).
    const q = textSearch.trim().toLowerCase();
    const hit =
      (s.name || '').toLowerCase().includes(q) ||
      (s.traceId || '').toLowerCase().includes(q) ||
      (s.spanId || '').toLowerCase().includes(q) ||
      Object.values(a).some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
    if (!hit) return false;
  }

  // ---- correlation clauses (A/B/C/D) ----
  const clauses: boolean[] = [];
  if (traceId) clauses.push(s.traceId === traceId);
  if (runIds && runIds.length > 0) {
    const valid = runIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    // Strategy B: agent_health.run.id OR the OTEL-standard gen_ai.conversation.id.
    clauses.push(valid.includes(a['agent_health.run.id']) || valid.includes(a['gen_ai.conversation.id']));
  }
  if (agents && agents.length > 0) {
    for (const ag of agents) {
      // Strategy C: service.name within the run window.
      const strategyC = serviceMatches(s, ag.serviceName) && spanMs(s) >= ag.startedAt && spanMs(s) <= ag.endedAt;
      // Strategy D: precise per-run session.id (e.g. Claude Code).
      const strategyD = ag.sessionId !== undefined && a['session.id'] === ag.sessionId;
      clauses.push(strategyC || strategyD);
    }
  }
  // Strategy D (request-level): the report's session.id, unioned with the rest.
  if (sessionId) clauses.push(a['session.id'] === sessionId);

  // useUnion → at least one correlation clause (should); else → all clauses (must).
  // No correlation clauses (pure time-range browse) → matches on must-filters alone.
  return useUnion ? clauses.some(Boolean) : clauses.every(Boolean);
}
