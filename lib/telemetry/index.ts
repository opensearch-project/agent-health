/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluation Telemetry Module
 *
 * Emits OTel spans for benchmark evaluation data using semantic conventions.
 * Disabled by default — enable via OTEL_EVAL_ENABLED=true or config file.
 */

export {
  initEvalTracerProvider,
  getEvalTracer,
  isEvalTelemetryEnabled,
  flushEvalTracer,
  shutdownEvalTracer,
  resolveEvalTelemetryConfig,
  type EvalTelemetryConfig,
} from './provider.js';

export {
  startTestSuiteRunSpan,
  startTestCaseSpan,
  addEvaluationResultEvents,
  finalizeTestCaseSpan,
  finalizeTestSuiteRunSpan,
  emitDeferredTestCaseSpan,
} from './evalSpans.js';

export * from './constants.js';

export {
  OpenSearchSpanExporter,
  type OpenSearchExporterConfig,
} from './opensearchExporter.js';
