/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side services
 *
 * Services that run in the browser and communicate with the backend API.
 */

export {
  executeBenchmarkRun,
  cancelBenchmarkRun,
  // Backwards compatibility aliases
  executeExperimentRun,
  cancelExperimentRun,
} from './benchmarkApi';
