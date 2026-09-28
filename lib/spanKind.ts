/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span-kind normalisation shared by every trace reader.
 *
 * The OTel `SpanKind` reaches us in several shapes depending on the pipeline
 * that wrote the span document:
 *   - OTLP/JSON (`POST /v1/traces`, file backend): numeric enum `0..5`
 *     (`0 UNSPECIFIED, 1 INTERNAL, 2 SERVER, 3 CLIENT, 4 PRODUCER, 5 CONSUMER`),
 *     or the protobuf enum name `SPAN_KIND_SERVER`.
 *   - Data Prepper / OpenSearch Ingestion (`otel-v1-apm-span-*`): the protobuf
 *     enum name string `SPAN_KIND_SERVER` in the top-level `kind` field.
 *   - Our own exporter and some collectors: plain `SERVER` / `Server`.
 *
 * Every reader funnels through {@link normalizeSpanKind} so the API and UI
 * only ever see the canonical uppercase names.
 */

export const SPAN_KIND_NAMES = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'] as const;

export type SpanKindName = (typeof SPAN_KIND_NAMES)[number];

/** OTLP numeric enum → canonical name. `0` (UNSPECIFIED) has no name. */
const NUMERIC_SPAN_KINDS: Record<number, SpanKindName> = {
  1: 'INTERNAL',
  2: 'SERVER',
  3: 'CLIENT',
  4: 'PRODUCER',
  5: 'CONSUMER',
};

/**
 * Normalise any known span-kind representation to `INTERNAL | SERVER |
 * CLIENT | PRODUCER | CONSUMER`. Returns `undefined` for unknown / unset input
 * (including OTLP `0` = UNSPECIFIED) so callers can fall through to another
 * source.
 */
export function normalizeSpanKind(raw: unknown): SpanKindName | undefined {
  if (raw === null || raw === undefined) return undefined;

  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? NUMERIC_SPAN_KINDS[raw] : undefined;
  }

  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  // Numeric strings ("2") — some JSON pipelines stringify the enum.
  if (/^\d+$/.test(trimmed)) return NUMERIC_SPAN_KINDS[Number(trimmed)];

  // `SPAN_KIND_SERVER` → `SERVER`; `Server` → `SERVER`.
  const upper = trimmed.toUpperCase().replace(/^SPAN_KIND_/, '');
  return (SPAN_KIND_NAMES as readonly string[]).includes(upper) ? (upper as SpanKindName) : undefined;
}

/**
 * Resolve a span's kind from the first source that yields a known value:
 * the document's top-level `kind`, then the `span.kind` / `spanKind`
 * attributes some pipelines copy it into.
 */
export function resolveSpanKind(
  topLevelKind: unknown,
  attributes?: Record<string, unknown> | null,
): SpanKindName | undefined {
  return (
    normalizeSpanKind(topLevelKind) ??
    normalizeSpanKind(attributes?.['span.kind']) ??
    normalizeSpanKind(attributes?.['spanKind'])
  );
}
