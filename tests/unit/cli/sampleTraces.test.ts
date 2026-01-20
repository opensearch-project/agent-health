/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for Sample Traces module
 */

import {
  SAMPLE_TRACE_SPANS,
  getSampleSpansForRunId,
  getSampleSpansForRunIds,
  getSampleSpansByTraceId,
  getAllSampleTraceSpans,
  isSampleTraceId,
  getSampleTraceIds,
} from '@/cli/demo/sampleTraces';

describe('Sample Traces', () => {
  describe('SAMPLE_TRACE_SPANS', () => {
    it('should have multiple trace spans', () => {
      expect(SAMPLE_TRACE_SPANS.length).toBeGreaterThan(0);
    });

    it('should have demo- prefix for all trace IDs', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(span.traceId).toMatch(/^demo-trace-/);
      });
    });

    it('should have required span fields', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(span.traceId).toBeDefined();
        expect(span.spanId).toBeDefined();
        expect(span.name).toBeDefined();
        expect(span.startTime).toBeDefined();
        expect(span.endTime).toBeDefined();
        expect(span.duration).toBeDefined();
        expect(span.status).toBeDefined();
        expect(span.attributes).toBeDefined();
      });
    });

    it('should have valid ISO timestamps', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(() => new Date(span.startTime)).not.toThrow();
        expect(() => new Date(span.endTime)).not.toThrow();
      });
    });

    it('should have positive durations', () => {
      SAMPLE_TRACE_SPANS.forEach((span) => {
        expect(span.duration).toBeGreaterThan(0);
      });
    });
  });

  describe('getSampleSpansForRunId', () => {
    it('should return spans for specific run ID', () => {
      const spans = getSampleSpansForRunId('demo-agent-run-001');
      expect(spans.length).toBeGreaterThan(0);
      spans.forEach((span) => {
        expect(span.attributes['run.id']).toBe('demo-agent-run-001');
      });
    });

    it('should return empty array for unknown run ID', () => {
      const spans = getSampleSpansForRunId('unknown-run');
      expect(spans).toEqual([]);
    });

    it('should find spans for all demo agent runs', () => {
      const runIds = ['demo-agent-run-001', 'demo-agent-run-002', 'demo-agent-run-003', 'demo-agent-run-004', 'demo-agent-run-005'];
      runIds.forEach((runId) => {
        const spans = getSampleSpansForRunId(runId);
        expect(spans.length).toBeGreaterThan(0);
      });
    });
  });

  describe('getSampleSpansForRunIds', () => {
    it('should return spans for multiple run IDs', () => {
      const spans = getSampleSpansForRunIds(['demo-agent-run-001', 'demo-agent-run-002']);
      expect(spans.length).toBeGreaterThan(0);
    });

    it('should return empty array for empty input', () => {
      const spans = getSampleSpansForRunIds([]);
      expect(spans).toEqual([]);
    });

    it('should return empty array for null/undefined input', () => {
      const spans = getSampleSpansForRunIds(null as any);
      expect(spans).toEqual([]);
    });

    it('should return spans from different traces', () => {
      const spans = getSampleSpansForRunIds(['demo-agent-run-001', 'demo-agent-run-002']);
      const traceIds = new Set(spans.map((s) => s.traceId));
      expect(traceIds.size).toBe(2);
    });
  });

  describe('getSampleSpansByTraceId', () => {
    it('should return spans for specific trace ID', () => {
      const spans = getSampleSpansByTraceId('demo-trace-001');
      expect(spans.length).toBeGreaterThan(0);
      spans.forEach((span) => {
        expect(span.traceId).toBe('demo-trace-001');
      });
    });

    it('should return empty array for unknown trace ID', () => {
      const spans = getSampleSpansByTraceId('unknown-trace');
      expect(spans).toEqual([]);
    });
  });

  describe('getAllSampleTraceSpans', () => {
    it('should return a copy of all spans', () => {
      const spans = getAllSampleTraceSpans();
      expect(spans.length).toBe(SAMPLE_TRACE_SPANS.length);

      // Verify it's a copy
      const originalLength = SAMPLE_TRACE_SPANS.length;
      spans.push({
        traceId: 'new-trace',
        spanId: 'new-span',
        name: 'test',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
        duration: 1000,
        status: 'OK',
        attributes: {},
      });
      expect(SAMPLE_TRACE_SPANS.length).toBe(originalLength);
    });
  });

  describe('isSampleTraceId', () => {
    it('should return true for demo-trace- prefix', () => {
      expect(isSampleTraceId('demo-trace-001')).toBe(true);
      expect(isSampleTraceId('demo-trace-anything')).toBe(true);
    });

    it('should return false for non-demo trace IDs', () => {
      expect(isSampleTraceId('trace-001')).toBe(false);
      expect(isSampleTraceId('random-id')).toBe(false);
      expect(isSampleTraceId('')).toBe(false);
    });
  });

  describe('getSampleTraceIds', () => {
    it('should return unique trace IDs', () => {
      const traceIds = getSampleTraceIds();
      expect(traceIds.length).toBe(5);
      expect(new Set(traceIds).size).toBe(traceIds.length);
    });

    it('should contain demo trace IDs', () => {
      const traceIds = getSampleTraceIds();
      traceIds.forEach((id) => {
        expect(id).toMatch(/^demo-trace-/);
      });
    });
  });

  describe('Trace Scenarios', () => {
    describe('Payment Service Latency (demo-trace-001)', () => {
      it('should have payment-related spans', () => {
        const spans = getSampleSpansByTraceId('demo-trace-001');
        expect(spans.some((s) => s.name.includes('checkout'))).toBe(true);
        expect(spans.some((s) => s.name.includes('payment') || s.attributes['service.name'] === 'payment-service')).toBe(true);
      });

      it('should show stripe as external service', () => {
        const spans = getSampleSpansByTraceId('demo-trace-001');
        const stripeSpan = spans.find((s) => s.name.includes('stripe'));
        expect(stripeSpan).toBeDefined();
        expect(stripeSpan?.duration).toBeGreaterThan(500); // Should be slow
      });
    });

    describe('Cart Error (demo-trace-002)', () => {
      it('should have error status', () => {
        const spans = getSampleSpansByTraceId('demo-trace-002');
        const errorSpans = spans.filter((s) => s.status === 'ERROR');
        expect(errorSpans.length).toBeGreaterThan(0);
      });

      it('should have inventory service error', () => {
        const spans = getSampleSpansByTraceId('demo-trace-002');
        const inventorySpan = spans.find((s) => s.name.includes('inventory'));
        expect(inventorySpan?.status).toBe('ERROR');
      });
    });

    describe('Database Pool Exhaustion (demo-trace-003)', () => {
      it('should have database span', () => {
        const spans = getSampleSpansByTraceId('demo-trace-003');
        const dbSpan = spans.find((s) => s.name.includes('postgresql'));
        expect(dbSpan).toBeDefined();
        expect(dbSpan?.attributes['db.system']).toBe('postgresql');
      });

      it('should show pool exhaustion in attributes', () => {
        const spans = getSampleSpansByTraceId('demo-trace-003');
        const dbSpan = spans.find((s) => s.name.includes('postgresql'));
        expect(dbSpan?.attributes['db.pool.active_connections']).toBe(20);
        expect(dbSpan?.attributes['db.pool.max_connections']).toBe(20);
      });
    });

    describe('Cold Start (demo-trace-004)', () => {
      it('should have cold_start attribute', () => {
        const spans = getSampleSpansByTraceId('demo-trace-004');
        const rootSpan = spans.find((s) => s.attributes['cold_start'] === true);
        expect(rootSpan).toBeDefined();
      });

      it('should have model loading spans', () => {
        const spans = getSampleSpansByTraceId('demo-trace-004');
        expect(spans.some((s) => s.name.includes('s3') || s.name.includes('model'))).toBe(true);
      });
    });

    describe('Cascading Failure (demo-trace-005)', () => {
      it('should have twilio error', () => {
        const spans = getSampleSpansByTraceId('demo-trace-005');
        const twilioSpan = spans.find((s) => s.name.includes('twilio'));
        expect(twilioSpan).toBeDefined();
        expect(twilioSpan?.status).toBe('ERROR');
      });

      it('should show retry count', () => {
        const spans = getSampleSpansByTraceId('demo-trace-005');
        const notifySpan = spans.find((s) => s.name.includes('notification'));
        expect(notifySpan?.attributes['retry.count']).toBe(3);
      });
    });
  });

  describe('Span Relationships', () => {
    it('should have parent-child relationships', () => {
      const spans = getSampleSpansByTraceId('demo-trace-001');
      const childSpans = spans.filter((s) => s.parentSpanId);
      expect(childSpans.length).toBeGreaterThan(0);
    });

    it('should have root spans without parent', () => {
      const spans = getSampleSpansByTraceId('demo-trace-001');
      const rootSpans = spans.filter((s) => !s.parentSpanId);
      expect(rootSpans.length).toBe(1);
    });

    it('should have consistent parent references', () => {
      const allSpans = getAllSampleTraceSpans();
      const spanIds = new Set(allSpans.map((s) => s.spanId));

      allSpans.forEach((span) => {
        if (span.parentSpanId) {
          expect(spanIds.has(span.parentSpanId)).toBe(true);
        }
      });
    });
  });
});
