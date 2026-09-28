/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeSpanKind, resolveSpanKind, SPAN_KIND_NAMES } from '@/lib/spanKind';

describe('normalizeSpanKind', () => {
  it('maps the OTLP numeric enum 1-5 to canonical names', () => {
    expect(normalizeSpanKind(1)).toBe('INTERNAL');
    expect(normalizeSpanKind(2)).toBe('SERVER');
    expect(normalizeSpanKind(3)).toBe('CLIENT');
    expect(normalizeSpanKind(4)).toBe('PRODUCER');
    expect(normalizeSpanKind(5)).toBe('CONSUMER');
  });

  it('treats 0 (UNSPECIFIED) and out-of-range numbers as unknown', () => {
    expect(normalizeSpanKind(0)).toBeUndefined();
    expect(normalizeSpanKind(6)).toBeUndefined();
    expect(normalizeSpanKind(-1)).toBeUndefined();
    expect(normalizeSpanKind(2.5)).toBeUndefined();
  });

  it('accepts numeric strings', () => {
    expect(normalizeSpanKind('2')).toBe('SERVER');
    expect(normalizeSpanKind('0')).toBeUndefined();
  });

  it('strips the protobuf SPAN_KIND_ prefix (Data Prepper / OpenSearch Ingestion form)', () => {
    expect(normalizeSpanKind('SPAN_KIND_SERVER')).toBe('SERVER');
    expect(normalizeSpanKind('SPAN_KIND_INTERNAL')).toBe('INTERNAL');
    expect(normalizeSpanKind('SPAN_KIND_CONSUMER')).toBe('CONSUMER');
  });

  it('accepts bare names in any case', () => {
    expect(normalizeSpanKind('SERVER')).toBe('SERVER');
    expect(normalizeSpanKind('Server')).toBe('SERVER');
    expect(normalizeSpanKind('client')).toBe('CLIENT');
    expect(normalizeSpanKind(' producer ')).toBe('PRODUCER');
  });

  it('returns undefined for unknown, empty, null and non-string input', () => {
    expect(normalizeSpanKind('SPAN_KIND_UNSPECIFIED')).toBeUndefined();
    expect(normalizeSpanKind('banana')).toBeUndefined();
    expect(normalizeSpanKind('')).toBeUndefined();
    expect(normalizeSpanKind(null)).toBeUndefined();
    expect(normalizeSpanKind(undefined)).toBeUndefined();
    expect(normalizeSpanKind({})).toBeUndefined();
    expect(normalizeSpanKind(true)).toBeUndefined();
  });

  it('only ever returns one of the canonical names', () => {
    for (const input of [1, 2, 3, 4, 5, 'SPAN_KIND_CLIENT', 'Server', 'consumer']) {
      expect(SPAN_KIND_NAMES).toContain(normalizeSpanKind(input));
    }
  });
});

describe('resolveSpanKind', () => {
  it('prefers the top-level kind', () => {
    expect(resolveSpanKind('SPAN_KIND_SERVER', { 'span.kind': 'CLIENT', spanKind: 'INTERNAL' })).toBe('SERVER');
  });

  it('falls back to attributes["span.kind"] then attributes.spanKind', () => {
    expect(resolveSpanKind(undefined, { 'span.kind': 3 })).toBe('CLIENT');
    expect(resolveSpanKind(null, { spanKind: 'SPAN_KIND_PRODUCER' })).toBe('PRODUCER');
    expect(resolveSpanKind(undefined, { 'span.kind': 'garbage', spanKind: 'Consumer' })).toBe('CONSUMER');
  });

  it('returns undefined when nothing usable is present', () => {
    expect(resolveSpanKind(undefined, undefined)).toBeUndefined();
    expect(resolveSpanKind(undefined, {})).toBeUndefined();
    expect(resolveSpanKind(0, null)).toBeUndefined();
  });
});
