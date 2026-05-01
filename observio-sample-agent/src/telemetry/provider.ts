/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel TracerProvider for the Observio sample agent.
 *
 * Exports spans via OTLP/HTTP to an OSIS pipeline endpoint, which routes
 * them to the same OpenSearch cluster that Agent Health reads traces from.
 *
 * Configuration (via .env):
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OSIS pipeline URL (required for telemetry)
 *   OTEL_SERVICE_NAME — service name (default: observio-sample-agent)
 *   OTEL_ENABLED — set to 'false' to disable (default: enabled)
 */

import { trace, context, type Tracer, type Context, type Span } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';

export const OBSERVIO_TRACER_NAME = 'observio-sample-agent';

let provider: NodeTracerProvider | null = null;

/**
 * Initialize OTel telemetry for the observio agent.
 * Exports spans via OTLP/HTTP to the configured OSIS pipeline endpoint.
 */
export function initTelemetry(): void {
  if (provider) return;

  const enabled = process.env.OTEL_ENABLED !== 'false'; // enabled by default
  if (!enabled) {
    console.log('[Telemetry] Observio telemetry disabled (OTEL_ENABLED=false)');
    return;
  }

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otlpEndpoint) {
    console.log('[Telemetry] Observio telemetry disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)');
    return;
  }

  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'observio-sample-agent',
    'telemetry.sdk.name': 'observio-sample-agent',
    'telemetry.sdk.language': 'nodejs',
  });

  const spanProcessors = [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: otlpEndpoint })),
  ];

  provider = new NodeTracerProvider({ resource, spanProcessors });
  provider.register();

  console.log(`[Telemetry] Observio telemetry enabled → OTLP (${otlpEndpoint})`);
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
