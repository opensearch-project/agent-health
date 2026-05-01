/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel TracerProvider management for evaluation telemetry.
 *
 * Manages a singleton TracerProvider that exports evaluation spans
 * via OTLP/HTTP to a collector, or directly to OpenSearch when an
 * observability data source is configured.
 */

import { trace, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { EVAL_TRACER_NAME } from './constants.js';
import { OpenSearchSpanExporter, type OpenSearchExporterConfig } from './opensearchExporter.js';

/**
 * Configuration for evaluation telemetry
 */
export interface EvalTelemetryConfig {
  /** Whether evaluation telemetry is enabled */
  enabled: boolean;
  /** OTLP exporter endpoint (e.g., http://localhost:4318/v1/traces) */
  exporterEndpoint: string;
  /** Optional headers for the OTLP exporter (e.g., auth) */
  exporterHeaders?: Record<string, string>;
  /** Service name for resource attributes */
  serviceName?: string;
  /** OpenSearch direct export config (derived from observability data source) */
  opensearch?: OpenSearchExporterConfig;
}

let provider: NodeTracerProvider | null = null;
let telemetryEnabled = false;

/**
 * Resolve telemetry config from environment variables and optional user config
 */
export function resolveEvalTelemetryConfig(userConfig?: Partial<EvalTelemetryConfig>): EvalTelemetryConfig {
  const enabled = userConfig?.enabled
    ?? process.env.OTEL_EVAL_ENABLED === 'true';

  const exporterEndpoint = userConfig?.exporterEndpoint
    ?? process.env.OTEL_EVAL_EXPORTER_ENDPOINT
    ?? 'http://localhost:4318/v1/traces';

  let exporterHeaders = userConfig?.exporterHeaders;
  if (!exporterHeaders && process.env.OTEL_EVAL_EXPORTER_HEADERS) {
    try {
      exporterHeaders = JSON.parse(process.env.OTEL_EVAL_EXPORTER_HEADERS);
    } catch {
      console.warn('[Telemetry] Failed to parse OTEL_EVAL_EXPORTER_HEADERS as JSON');
    }
  }

  // Use a dedicated env var for eval service name — do NOT fall back to
  // OTEL_SERVICE_NAME which belongs to the agent's own telemetry (e.g. claude-code-agent).
  const serviceName = userConfig?.serviceName
    ?? process.env.OTEL_EVAL_SERVICE_NAME
    ?? 'agent-health';

  return { enabled, exporterEndpoint, exporterHeaders, serviceName, opensearch: userConfig?.opensearch };
}

/**
 * Initialize the evaluation TracerProvider.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * When an OpenSearch config is provided (from observability data source),
 * spans are written directly to OpenSearch in OSIS-compatible format.
 * Otherwise, falls back to OTLP/HTTP exporter.
 */
export function initEvalTracerProvider(config: EvalTelemetryConfig): void {
  if (provider) {
    return; // Already initialized
  }

  if (!config.enabled) {
    telemetryEnabled = false;
    console.log('[Telemetry] Evaluation telemetry disabled (OTEL_EVAL_ENABLED != true)');
    return;
  }

  const resource = resourceFromAttributes({
    'service.name': config.serviceName ?? 'agent-health',
    'telemetry.sdk.name': 'agent-health',
    'telemetry.sdk.language': 'nodejs',
  });

  // Choose exporter priority:
  //   1. OTLP/HTTP when exporterEndpoint is explicitly configured (e.g., OSIS pipeline)
  //   2. OpenSearch direct when observability data source is configured
  //   3. OTLP/HTTP with default endpoint as last resort
  const spanProcessors = [];
  const hasExplicitOtlpEndpoint = config.exporterEndpoint !== 'http://localhost:4318/v1/traces';

  if (hasExplicitOtlpEndpoint) {
    // User explicitly configured an OTLP endpoint (e.g., OSIS pipeline) — prefer it
    const otlpExporter = new OTLPTraceExporter({
      url: config.exporterEndpoint,
      headers: config.exporterHeaders,
    });
    spanProcessors.push(new BatchSpanProcessor(otlpExporter));
    console.log(`[Telemetry] Evaluation telemetry enabled → OTLP (${config.exporterEndpoint})`);
  } else if (config.opensearch) {
    const osExporter = new OpenSearchSpanExporter(config.opensearch);
    // Use SimpleSpanProcessor for immediate export (eval spans are infrequent)
    spanProcessors.push(new SimpleSpanProcessor(osExporter));
    console.log(`[Telemetry] Evaluation telemetry enabled → OpenSearch direct (${config.opensearch.endpoint})`);
  } else {
    const otlpExporter = new OTLPTraceExporter({
      url: config.exporterEndpoint,
      headers: config.exporterHeaders,
    });
    spanProcessors.push(new BatchSpanProcessor(otlpExporter));
    console.log(`[Telemetry] Evaluation telemetry enabled → OTLP (${config.exporterEndpoint})`);
  }

  provider = new NodeTracerProvider({
    resource,
    spanProcessors,
  });
  provider.register();

  telemetryEnabled = true;
}

/**
 * Get the evaluation tracer. Returns a no-op tracer if telemetry is disabled.
 */
export function getEvalTracer(): Tracer {
  return trace.getTracer(EVAL_TRACER_NAME);
}

/**
 * Check if evaluation telemetry is enabled
 */
export function isEvalTelemetryEnabled(): boolean {
  return telemetryEnabled;
}

/**
 * Force-flush any buffered spans to the exporter.
 * Call after emitting spans to ensure they are exported promptly.
 */
export async function flushEvalTracer(): Promise<void> {
  if (provider) {
    try {
      await provider.forceFlush();
    } catch (err) {
      console.warn('[Telemetry] forceFlush failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Flush pending spans and shut down the TracerProvider.
 */
export async function shutdownEvalTracer(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    telemetryEnabled = false;
    console.log('[Telemetry] Evaluation telemetry shut down');
  }
}
