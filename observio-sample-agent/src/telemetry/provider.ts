/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel TracerProvider for the Observio sample agent.
 *
 * Supports two export modes:
 *   1. Direct OpenSearch — writes spans directly to the Agent Health cluster
 *      (preferred, uses OPENSEARCH_LOGS_ENDPOINT)
 *   2. OTLP/HTTP — exports via OTLP to an OSI pipeline endpoint
 *      (fallback, uses OTEL_EXPORTER_OTLP_ENDPOINT)
 *
 * Configuration (via .env):
 *   OPENSEARCH_LOGS_ENDPOINT — OpenSearch cluster URL (preferred)
 *   OPENSEARCH_LOGS_USERNAME / OPENSEARCH_LOGS_PASSWORD — basic auth
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP pipeline URL (fallback)
 *   OTEL_SERVICE_NAME — service name (default: observio-sample-agent)
 *   OTEL_ENABLED — set to 'false' to disable (default: enabled)
 */

import { trace, context, type Tracer, type Context, type Span } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OpenSearchSpanExporter } from './opensearchExporter';

export const OBSERVIO_TRACER_NAME = 'observio-sample-agent';

let provider: NodeTracerProvider | null = null;

/**
 * Initialize OTel telemetry for the observio agent.
 * Prefers direct OpenSearch export; falls back to OTLP/HTTP.
 */
export function initTelemetry(): void {
  if (provider) return;

  const enabled = process.env.OTEL_ENABLED !== 'false'; // enabled by default
  if (!enabled) {
    console.log('[Telemetry] Observio telemetry disabled (OTEL_ENABLED=false)');
    return;
  }

  // Determine exporter: prefer direct OpenSearch, fallback to OTLP
  let exporter: SpanExporter;
  const osEndpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (osEndpoint) {
    exporter = new OpenSearchSpanExporter({
      endpoint: osEndpoint,
      username: process.env.OPENSEARCH_LOGS_USERNAME,
      password: process.env.OPENSEARCH_LOGS_PASSWORD,
      indexName: process.env.OPENSEARCH_LOGS_TRACES_INDEX?.replace('*', '000001') || 'otel-v1-apm-span-000001',
      tlsSkipVerify: true,
    });
    console.log(`[Telemetry] Observio telemetry enabled → OpenSearch (${osEndpoint})`);
  } else if (otlpEndpoint) {
    exporter = new OTLPTraceExporter({ url: otlpEndpoint });
    console.log(`[Telemetry] Observio telemetry enabled → OTLP (${otlpEndpoint})`);
  } else {
    console.log('[Telemetry] Observio telemetry disabled (no OPENSEARCH_LOGS_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT)');
    return;
  }

  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'observio-sample-agent',
    'telemetry.sdk.name': 'observio-sample-agent',
    'telemetry.sdk.language': 'nodejs',
  });

  const spanProcessors = [
    new BatchSpanProcessor(exporter),
  ];

  provider = new NodeTracerProvider({ resource, spanProcessors });
  provider.register();
}

/**
 * Get the observio tracer instance.
 */
export function getTracer(): Tracer {
  return trace.getTracer(OBSERVIO_TRACER_NAME);
}

/**
 * Shut down the tracer provider (flush pending spans).
 */
export async function shutdownTelemetry(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    console.log('[Telemetry] Observio telemetry shut down');
  }
}

// Re-export for convenience
export { trace, context, type Context, type Span };
