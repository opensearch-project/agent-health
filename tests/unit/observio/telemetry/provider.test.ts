/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for observio-sample-agent telemetry provider.
 *
 * Verifies dual-mode export initialization behavior via console output,
 * since module-level state makes mocking individual constructors complex.
 */

describe('observio telemetry provider', () => {
  const originalEnv = process.env;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.OTEL_ENABLED;
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    delete process.env.OPENSEARCH_LOGS_USERNAME;
    delete process.env.OPENSEARCH_LOGS_PASSWORD;
    delete process.env.OPENSEARCH_LOGS_TRACES_INDEX;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    process.env = originalEnv;
  });

  describe('initTelemetry', () => {
    it('disables telemetry when OTEL_ENABLED=false', () => {
      process.env.OTEL_ENABLED = 'false';
      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Telemetry] Observio telemetry disabled (OTEL_ENABLED=false)'
      );
    });

    it('disables telemetry when no endpoint configured', () => {
      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Telemetry] Observio telemetry disabled (no OPENSEARCH_LOGS_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT)'
      );
    });

    it('prefers OpenSearch direct export when OPENSEARCH_LOGS_ENDPOINT is set', () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://my-cluster.example.com';
      process.env.OPENSEARCH_LOGS_USERNAME = 'admin';
      process.env.OPENSEARCH_LOGS_PASSWORD = 'secret';

      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Telemetry] Observio telemetry enabled → OpenSearch (https://my-cluster.example.com)'
      );
    });

    it('falls back to OTLP when only OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://api-gw.example.com/v1/traces';

      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Telemetry] Observio telemetry enabled → OTLP (https://api-gw.example.com/v1/traces)'
      );
    });

    it('prefers OpenSearch over OTLP when both are set', () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://my-cluster.example.com';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://api-gw.example.com';

      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('→ OpenSearch')
      );
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('→ OTLP')
      );
    });

    it('is idempotent - second call is a no-op', () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://my-cluster.example.com';

      const { initTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      initTelemetry();
      consoleSpy.mockClear();
      initTelemetry(); // second call

      // Should not log again (provider already initialized)
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Observio telemetry enabled')
      );
    });
  });

  describe('shutdownTelemetry', () => {
    it('is safe to call when not initialized', async () => {
      const { shutdownTelemetry } = require('@/observio-sample-agent/src/telemetry/provider');
      await expect(shutdownTelemetry()).resolves.toBeUndefined();
    });
  });

  describe('getTracer', () => {
    it('returns a tracer instance', () => {
      const { getTracer } = require('@/observio-sample-agent/src/telemetry/provider');
      const tracer = getTracer();
      expect(tracer).toBeDefined();
      expect(tracer.startSpan).toBeDefined();
    });
  });

  describe('OBSERVIO_TRACER_NAME', () => {
    it('exports the correct tracer name', () => {
      const { OBSERVIO_TRACER_NAME } = require('@/observio-sample-agent/src/telemetry/provider');
      expect(OBSERVIO_TRACER_NAME).toBe('observio-sample-agent');
    });
  });
});
