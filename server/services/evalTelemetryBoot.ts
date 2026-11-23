/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluation-telemetry bootstrap shared by every process that EXECUTES runs:
 * the server (`createApp`) and the CLI executor (`cli/utils/localExecutor.ts`,
 * #612). Both derive the exporter from the same project configuration —
 * `config.telemetry` plus, when an observability cluster is configured, a
 * direct OpenSearch exporter so eval spans land next to the agent's spans.
 */

import type { ResolvedConfig } from '@/lib/config/index';
import { initEvalTracerProvider, resolveEvalTelemetryConfig, type OpenSearchExporterConfig } from '@/lib/telemetry';
import { getObservabilityConfigFromFile, getObservabilityConfigFromTs, setTsClusterConfig } from './configService.js';
import { getObservabilityConfigFromEnv } from '../middleware/dataSourceConfig.js';

/**
 * Initialise the eval tracer provider for this process from `config`.
 * Resolution of the observability cluster is code-first `.ts` → runtime state
 * file → `OPENSEARCH_*` env, exactly as the server's data-source chain.
 */
export function initEvalTelemetryFromConfig(config: Pick<ResolvedConfig, 'telemetry' | 'storage' | 'observability' | 'observabilitySources'>): void {
  // Bridge the authored cluster config (if any) into the runtime chain first,
  // so `getObservabilityConfigFromTs()` below can see it.
  setTsClusterConfig({
    storage: config.storage ?? null,
    observability: config.observability ?? null,
    observabilitySources: config.observabilitySources ?? null,
  });
  const obsConfig = getObservabilityConfigFromFile() ?? getObservabilityConfigFromTs() ?? getObservabilityConfigFromEnv();
  let opensearchExporterConfig: OpenSearchExporterConfig | undefined;
  if (obsConfig?.endpoint) {
    opensearchExporterConfig = {
      endpoint: obsConfig.endpoint,
      username: obsConfig.username,
      password: obsConfig.password,
      tlsSkipVerify: obsConfig.tlsSkipVerify,
      indexName: 'otel-v1-apm-span',
    };
  }
  initEvalTracerProvider(resolveEvalTelemetryConfig({
    ...config.telemetry,
    opensearch: opensearchExporterConfig,
  }));
}
