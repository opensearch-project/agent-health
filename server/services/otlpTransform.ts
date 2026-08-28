/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTLP/JSON → internal Span transform.
 *
 * Parses an OTLP/HTTP **JSON** ExportTraceServiceRequest (`{ resourceSpans: [...] }`)
 * into the internal `Span[]` shape used across the traces pipeline. JSON is the
 * format Claude Code and the other connectors already export (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
 * protobuf support can be layered on later.
 *
 * Span/trace IDs in OTLP/JSON are hex-encoded per the spec; we accept hex and
 * fall back to base64→hex for lenient clients. Resource attributes (e.g.
 * `service.name`) are merged onto each span so service-name correlation works.
 */

import type { Span, SpanEvent } from '../../types/index.js';

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: string;
}
interface OtlpKeyValue { key: string; value?: OtlpAnyValue; }

function unwrapValue(v?: OtlpAnyValue): any {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(unwrapValue);
  if (v.kvlistValue) return attrsToObject(v.kvlistValue.values);
  if (v.bytesValue !== undefined) return v.bytesValue;
  return undefined;
}

function attrsToObject(attrs?: OtlpKeyValue[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const kv of attrs || []) {
    if (kv && typeof kv.key === 'string') out[kv.key] = unwrapValue(kv.value);
  }
  return out;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Normalize an OTLP/JSON id to lowercase hex. Accepts hex (any even length) or
 * strictly-valid base64; returns '' for anything else so malformed ids never
 * enter the store (which would corrupt filenames / spanId-keyed correlation).
 */
export function normalizeId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) return '';
  if (HEX_RE.test(id) && id.length % 2 === 0) return id.toLowerCase();
  // Otherwise only accept base64 that round-trips exactly, mapped to hex.
  try {
    const buf = Buffer.from(id, 'base64');
    if (buf.length > 0 && buf.toString('base64').replace(/=+$/, '') === id.replace(/=+$/, '')) {
      return buf.toString('hex');
    }
  } catch {
    /* fall through */
  }
  return '';
}

/** Nanoseconds (string|number) → ISO timestamp. */
function nanosToIso(nanos: unknown): string {
  const n = typeof nanos === 'string' ? Number(nanos) : (nanos as number);
  if (!n || Number.isNaN(n)) return new Date(0).toISOString();
  return new Date(n / 1e6).toISOString();
}

function statusFromCode(code: unknown): Span['status'] {
  // OTLP status code: 0 UNSET, 1 OK, 2 ERROR
  if (code === 2 || code === 'STATUS_CODE_ERROR') return 'ERROR';
  if (code === 1 || code === 'STATUS_CODE_OK') return 'OK';
  return 'UNSET';
}

/**
 * Convert an OTLP/JSON ExportTraceServiceRequest body into internal Spans.
 * Tolerant of both `scopeSpans` (current) and `instrumentationLibrarySpans` (legacy).
 */
export function otlpToSpans(body: any): Span[] {
  const out: Span[] = [];
  const resourceSpans: any[] = body?.resourceSpans || [];

  for (const rs of resourceSpans) {
    const resourceAttrs = attrsToObject(rs?.resource?.attributes);
    const serviceName = resourceAttrs['service.name'];
    const scopeGroups: any[] = rs?.scopeSpans || rs?.instrumentationLibrarySpans || [];

    for (const sg of scopeGroups) {
      const scopeName = sg?.scope?.name || sg?.instrumentationLibrary?.name;
      const spans: any[] = sg?.spans || [];

      for (const sp of spans) {
        const attributes: Record<string, any> = { ...resourceAttrs, ...attrsToObject(sp?.attributes) };
        // Make service-name correlation work for both `service.name` and `serviceName`.
        if (serviceName !== undefined) {
          attributes['service.name'] = serviceName;
          attributes['serviceName'] = serviceName;
        }
        if (scopeName) attributes['instrumentation.scope.name'] = scopeName;

        const startTime = nanosToIso(sp?.startTimeUnixNano);
        const endTime = nanosToIso(sp?.endTimeUnixNano);
        const startMs = Date.parse(startTime);
        const endMs = Date.parse(endTime);

        const events: SpanEvent[] = (sp?.events || []).map((e: any) => ({
          name: e?.name || '',
          time: nanosToIso(e?.timeUnixNano),
          attributes: attrsToObject(e?.attributes),
        }));

        const traceId = normalizeId(sp?.traceId);
        const spanId = normalizeId(sp?.spanId);
        // Skip spans missing valid ids: an empty spanId would collide in the
        // spanId-keyed store and silently drop unrelated spans.
        if (!traceId || !spanId) continue;
        const parentSpanId = normalizeId(sp?.parentSpanId);

        out.push({
          traceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name: sp?.name || '',
          ...(sp?.kind !== undefined ? { kind: sp.kind } : {}),
          startTime,
          endTime,
          duration: endMs >= startMs ? endMs - startMs : undefined,
          status: statusFromCode(sp?.status?.code),
          attributes,
          events,
        });
      }
    }
  }

  return out;
}
