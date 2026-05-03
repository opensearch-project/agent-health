/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  resolveEvalTelemetryConfig,
  initEvalTracerProvider,
  isEvalTelemetryEnabled,
  shutdownEvalTracer,
  getEvalTracer,
} from '@/lib/telemetry/provider';

// Mock OTel SDK to avoid actual network connections
jest.mock('@opentelemetry/sdk-trace-node', () => {
  const mockRegister = jest.fn();
  const mockShutdown = jest.fn().mockResolvedValue(undefined);
  return {
    NodeTracerProvider: jest.fn().mockImplementation(() => ({
      register: mockRegister,
      shutdown: mockShutdown,
    })),
    BatchSpanProcessor: jest.fn(),
  };
});

jest.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: jest.fn(),
}));

jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: jest.fn((attrs: Record<string, string>) => attrs),
}));

describe('Telemetry Provider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    process.env = originalEnv;
    // Clean up provider state between tests
    await shutdownEvalTracer();
  });

  describe('resolveEvalTelemetryConfig', () => {
    it('should return defaults when no config or env vars provided', () => {
      delete process.env.OTEL_EVAL_ENABLED;
      delete process.env.OTEL_EVAL_EXPORTER_ENDPOINT;
      delete process.env.OTEL_EVAL_SERVICE_NAME;

      const config = resolveEvalTelemetryConfig();

      expect(config.enabled).toBe(false);
      expect(config.exporterEndpoint).toBe('http://localhost:4318/v1/traces');
      expect(config.serviceName).toBe('agent-health');
      expect(config.exporterHeaders).toBeUndefined();
    });

    it('should respect OTEL_EVAL_ENABLED env var', () => {
      process.env.OTEL_EVAL_ENABLED = 'true';

      const config = resolveEvalTelemetryConfig();

      expect(config.enabled).toBe(true);
    });

    it('should respect OTEL_EVAL_EXPORTER_ENDPOINT env var', () => {
      process.env.OTEL_EVAL_EXPORTER_ENDPOINT = 'http://custom:4318/v1/traces';

      const config = resolveEvalTelemetryConfig();

      expect(config.exporterEndpoint).toBe('http://custom:4318/v1/traces');
    });

    it('should respect OTEL_EVAL_SERVICE_NAME env var', () => {
      process.env.OTEL_EVAL_SERVICE_NAME = 'my-service';

      const config = resolveEvalTelemetryConfig();

      expect(config.serviceName).toBe('my-service');
    });

    it('should parse OTEL_EVAL_EXPORTER_HEADERS as JSON', () => {
      process.env.OTEL_EVAL_EXPORTER_HEADERS = '{"Authorization": "Bearer token"}';

      const config = resolveEvalTelemetryConfig();

      expect(config.exporterHeaders).toEqual({ Authorization: 'Bearer token' });
    });

    it('should handle invalid JSON in OTEL_EVAL_EXPORTER_HEADERS gracefully', () => {
      process.env.OTEL_EVAL_EXPORTER_HEADERS = 'not-json';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const config = resolveEvalTelemetryConfig();

      expect(config.exporterHeaders).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
      warnSpy.mockRestore();
    });

    it('should prefer user config over env vars', () => {
      process.env.OTEL_EVAL_ENABLED = 'true';
      process.env.OTEL_EVAL_EXPORTER_ENDPOINT = 'http://env:4318';

      const config = resolveEvalTelemetryConfig({
        enabled: false,
        exporterEndpoint: 'http://user:4318',
      });

      expect(config.enabled).toBe(false);
      expect(config.exporterEndpoint).toBe('http://user:4318');
    });
  });

  describe('initEvalTracerProvider', () => {
    it('should not enable telemetry when config.enabled is false', () => {
      initEvalTracerProvider({
        enabled: false,
        exporterEndpoint: 'http://localhost:4318/v1/traces',
      });

      expect(isEvalTelemetryEnabled()).toBe(false);
    });

    it('should enable telemetry when config.enabled is true', () => {
      initEvalTracerProvider({
        enabled: true,
        exporterEndpoint: 'http://localhost:4318/v1/traces',
      });

      expect(isEvalTelemetryEnabled()).toBe(true);
    });

    it('should be idempotent — second call is a no-op', () => {
      initEvalTracerProvider({
        enabled: true,
        exporterEndpoint: 'http://localhost:4318/v1/traces',
      });

      // Second call should be a no-op (provider already exists)
      initEvalTracerProvider({
        enabled: true,
        exporterEndpoint: 'http://other:4318/v1/traces',
      });

      // Still enabled from first call
      expect(isEvalTelemetryEnabled()).toBe(true);
    });
  });

  describe('getEvalTracer', () => {
    it('should return a tracer', () => {
      const tracer = getEvalTracer();

      expect(tracer).toBeDefined();
      expect(tracer.startSpan).toBeDefined();
    });
  });

  describe('shutdownEvalTracer', () => {
    it('should disable telemetry after shutdown', async () => {
      initEvalTracerProvider({
        enabled: true,
        exporterEndpoint: 'http://localhost:4318/v1/traces',
      });

      expect(isEvalTelemetryEnabled()).toBe(true);

      await shutdownEvalTracer();

      expect(isEvalTelemetryEnabled()).toBe(false);
    });

    it('should be safe to call when not initialized', async () => {
      await expect(shutdownEvalTracer()).resolves.not.toThrow();
    });
  });
});
