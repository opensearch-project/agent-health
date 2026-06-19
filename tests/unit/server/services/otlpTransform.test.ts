/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { otlpToSpans, normalizeId } from '@/server/services/otlpTransform';

describe('otlpTransform', () => {
  describe('normalizeId', () => {
    it('lowercases hex ids as-is', () => {
      expect(normalizeId('ABCDEF0123')).toBe('abcdef0123');
    });
    it('decodes base64 ids to hex', () => {
      const hex = '00112233445566778899aabbccddeeff';
      const b64 = Buffer.from(hex, 'hex').toString('base64');
      expect(normalizeId(b64)).toBe(hex);
    });
    it('returns empty string for missing or invalid id', () => {
      expect(normalizeId(undefined)).toBe('');
      expect(normalizeId('')).toBe('');
      expect(normalizeId('xyz!@#')).toBe('');
    });
  });

  describe('otlpToSpans', () => {
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'my-agent' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'my.tracer' },
              spans: [
                {
                  traceId: 'aaaa0000bbbb1111cccc2222dddd3333',
                  spanId: '1111222233334444',
                  parentSpanId: '5555666677778888',
                  name: 'chat',
                  kind: 3,
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000001500000000',
                  attributes: [
                    { key: 'gen_ai.request.id', value: { stringValue: 'run-42' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '123' } },
                    { key: 'ok', value: { boolValue: true } },
                  ],
                  status: { code: 2 },
                  events: [
                    { name: 'exception', timeUnixNano: '1700000001000000000', attributes: [{ key: 'msg', value: { stringValue: 'boom' } }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    it('maps a resource/scope/span tree into internal Spans', () => {
      const spans = otlpToSpans(body);
      expect(spans).toHaveLength(1);
      const s = spans[0];
      expect(s.traceId).toBe('aaaa0000bbbb1111cccc2222dddd3333');
      expect(s.spanId).toBe('1111222233334444');
      expect(s.parentSpanId).toBe('5555666677778888');
      expect(s.name).toBe('chat');
      expect(s.status).toBe('ERROR'); // code 2
    });

    it('merges resource attributes onto the span (service.name + serviceName)', () => {
      const s = otlpToSpans(body)[0];
      expect(s.attributes!['service.name']).toBe('my-agent');
      expect(s.attributes!['serviceName']).toBe('my-agent');
      expect(s.attributes!['instrumentation.scope.name']).toBe('my.tracer');
    });

    it('unwraps typed attribute values and the runId correlation key', () => {
      const s = otlpToSpans(body)[0];
      expect(s.attributes!['gen_ai.request.id']).toBe('run-42');
      expect(s.attributes!['gen_ai.usage.input_tokens']).toBe(123);
      expect(s.attributes!['ok']).toBe(true);
    });

    it('converts nanosecond timestamps to ISO and computes duration (ms)', () => {
      const s = otlpToSpans(body)[0];
      expect(s.startTime).toBe(new Date(1700000000000).toISOString());
      expect(s.endTime).toBe(new Date(1700000001500).toISOString());
      expect(s.duration).toBe(1500);
    });

    it('maps span events', () => {
      const s = otlpToSpans(body)[0];
      expect(s.events).toHaveLength(1);
      expect(s.events![0].name).toBe('exception');
      expect(s.events![0].attributes).toEqual({ msg: 'boom' });
    });

    it('maps status codes 1→OK, 0/absent→UNSET', () => {
      const ok = otlpToSpans({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'aa', spanId: 'bb', name: 'x', status: { code: 1 } }] }] }] })[0];
      expect(ok.status).toBe('OK');
      const unset = otlpToSpans({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'aa', spanId: 'bb', name: 'x' }] }] }] })[0];
      expect(unset.status).toBe('UNSET');
    });

    it('supports legacy instrumentationLibrarySpans', () => {
      const spans = otlpToSpans({
        resourceSpans: [{ instrumentationLibrarySpans: [{ spans: [{ traceId: 'aa', spanId: 'bb', name: 'legacy' }] }] }],
      });
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('legacy');
    });

    it('skips spans with missing/invalid ids (they would collide in the store)', () => {
      const spans = otlpToSpans({
        resourceSpans: [{ scopeSpans: [{ spans: [
          { spanId: 'bb', name: 'no-trace' },          // missing traceId
          { traceId: 'aa', name: 'no-span' },          // missing spanId
          { traceId: 'a', spanId: 'b', name: 'odd-hex' }, // invalid (odd-length, not base64)
          { traceId: 'aa', spanId: 'bb', name: 'good' },
        ] }] }],
      });
      expect(spans.map((s) => s.name)).toEqual(['good']);
    });

    it('returns [] for empty / malformed bodies', () => {
      expect(otlpToSpans({})).toEqual([]);
      expect(otlpToSpans({ resourceSpans: [] })).toEqual([]);
      expect(otlpToSpans(null)).toEqual([]);
    });
  });
});
