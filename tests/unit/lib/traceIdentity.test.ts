/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isW3CTraceId, resolveReportTraceId } from '@/lib/traceIdentity';

const EVAL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('lib/traceIdentity', () => {
  describe('isW3CTraceId', () => {
    it('accepts 32 hex chars in either case', () => {
      expect(isW3CTraceId(EVAL)).toBe(true);
      expect(isW3CTraceId(EVAL.toUpperCase())).toBe(true);
    });

    it('rejects connector / hook run ids and other non-trace strings', () => {
      // The exact shapes that were mis-stamped as `traceId` on legacy reports.
      expect(isW3CTraceId('conv-33c29f9d5b8a')).toBe(false);
      expect(isW3CTraceId('subprocess-1790160583136')).toBe(false);
      expect(isW3CTraceId('run-1790160583136-nqs0ftd89')).toBe(false);
      expect(isW3CTraceId('report-1790160737173-pk36of6um')).toBe(false);
      expect(isW3CTraceId('trace-xyz')).toBe(false);
    });

    it('rejects wrong lengths, non-hex, the all-zero id and non-strings', () => {
      expect(isW3CTraceId(EVAL.slice(0, 31))).toBe(false);
      expect(isW3CTraceId(EVAL + '0')).toBe(false);
      expect(isW3CTraceId('g'.repeat(32))).toBe(false);
      expect(isW3CTraceId('0'.repeat(32))).toBe(false);
      expect(isW3CTraceId(undefined)).toBe(false);
      expect(isW3CTraceId(null)).toBe(false);
      expect(isW3CTraceId(12345678901234567890123456789012)).toBe(false);
      expect(isW3CTraceId('')).toBe(false);
    });
  });

  describe('resolveReportTraceId', () => {
    it('the eval span trace id always wins (lower-cased)', () => {
      expect(resolveReportTraceId(EVAL.toUpperCase(), '0f0e0d0c0b0a09080706050403020100')).toBe(EVAL);
      expect(resolveReportTraceId(EVAL, 'conv-123')).toBe(EVAL);
      expect(resolveReportTraceId(EVAL, undefined)).toBe(EVAL);
    });

    it('falls back to a W3C candidate when there is no eval span', () => {
      expect(resolveReportTraceId(undefined, '0F0E0D0C0B0A09080706050403020100')).toBe('0f0e0d0c0b0a09080706050403020100');
    });

    it('never lets a connector run id through as traceId', () => {
      expect(resolveReportTraceId(undefined, 'conv-33c29f9d5b8a')).toBeUndefined();
      expect(resolveReportTraceId('conv-33c29f9d5b8a', 'subprocess-1')).toBeUndefined();
      expect(resolveReportTraceId(undefined, undefined)).toBeUndefined();
      expect(resolveReportTraceId(undefined, null)).toBeUndefined();
    });
  });
});
