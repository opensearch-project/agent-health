/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span ordering + absolute-time formatting shared by every trace row surface
 * (tree table, timeline chart, span drawers).
 *
 * Ordering: every list of spans the UI shows — roots, children, and the
 * flattened visible list — is sorted by `startTime`, ascending, with ties
 * broken by `spanId` so the order is total and identical across renders and
 * across the different views. `Array.prototype.sort` is stable in every
 * supported runtime, but the explicit tie-break means two spans that start on
 * the same millisecond never swap places between the tree and the timeline.
 * Spans with an unparseable `startTime` sort last.
 *
 * Time: rows show the span's wall-clock start (`HH:MM:SS.mmm`, local time) and
 * its offset from the trace root (`+1.234 s`) so a reader can line spans up
 * against external logs without converting relative durations by hand.
 */

import { Span } from '@/types';

/** Start in epoch ms; an unparseable startTime sorts LAST (+Infinity), not at the epoch. */
export function spanStartMs(span: Pick<Span, 'startTime'>): number {
  const ms = new Date(span.startTime).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Total order: startTime ascending, then spanId (code-point order). */
export function compareSpansByStartTime(a: Span, b: Span): number {
  const diff = spanStartMs(a) - spanStartMs(b);
  if (diff !== 0) return diff;
  if (a.spanId < b.spanId) return -1;
  if (a.spanId > b.spanId) return 1;
  return 0;
}

/** Returns a NEW array sorted with `compareSpansByStartTime` (input untouched). */
export function sortSpansByStartTime<T extends Span>(spans: readonly T[]): T[] {
  return [...spans].sort(compareSpansByStartTime);
}

/**
 * t=0 for offsets: the start of the trace ROOT — the earliest of the
 * top-level spans when the tree has several roots (e.g. a time-window fetch
 * that pulled in sibling traces). Children are not consulted: a child whose
 * clock ran ahead of its root shows a negative offset rather than silently
 * moving t=0. `null` when there are no roots with a parseable start.
 */
export function getTraceAnchorMs(roots: readonly Span[]): number | null {
  let min = Infinity;
  for (const s of roots) {
    const ms = new Date(s.startTime).getTime();
    if (Number.isFinite(ms) && ms < min) min = ms;
  }
  return min === Infinity ? null : min;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/**
 * `HH:MM:SS.mmm` in the viewer's local time zone. Returns `''` for an
 * unparseable input so callers can hide the cell instead of showing `NaN`.
 */
export function formatClockTime(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return '';
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Full ISO-8601 (UTC) for tooltips — the row shows local wall-clock time,
 * the tooltip disambiguates the date and zone. `''` when unparseable.
 */
export function formatIsoTime(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

/**
 * Offset from the trace root as `+1.234 s` (always seconds, three decimals,
 * so a monospace column lines up). Negative offsets — a child whose clock
 * ran ahead of the root — keep their sign (`-0.002 s`) rather than being
 * clamped, because that skew is itself worth seeing.
 */
export function formatTraceOffset(offsetMs: number): string {
  if (!Number.isFinite(offsetMs)) return '';
  const sign = offsetMs < 0 ? '-' : '+';
  return `${sign}${(Math.abs(offsetMs) / 1000).toFixed(3)} s`;
}

export interface SpanTimeLabels {
  /** Local `HH:MM:SS.mmm` start time. */
  clock: string;
  /** Full ISO start time for the tooltip. */
  iso: string;
  /** `+1.234 s` from the trace anchor; `''` when the anchor is unknown. */
  offset: string;
}

/** Labels for one row. `anchorMs` is the trace root's start (see getTraceAnchorMs). */
export function getSpanTimeLabels(span: Pick<Span, 'startTime'>, anchorMs: number | null): SpanTimeLabels {
  const startMs = new Date(span.startTime).getTime();
  return {
    clock: formatClockTime(span.startTime),
    iso: formatIsoTime(span.startTime),
    offset: anchorMs === null || !Number.isFinite(startMs) ? '' : formatTraceOffset(startMs - anchorMs),
  };
}
