/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage Services
 *
 * Re-exports all storage-related functionality for clean imports.
 */

// OpenSearch client (low-level API)
export {
  opensearchStorage,
  storageAdmin,
  testCaseStorage,
  benchmarkStorage,
  experimentStorage, // Backwards compatibility alias
  runStorage,
  analyticsStorage,
  type StorageTestCase,
  type StorageBenchmark,
  type StorageBenchmarkRunConfig,
  type StorageExperiment, // Backwards compatibility alias
  type StorageExperimentRunConfig, // Backwards compatibility alias
  type StorageRun,
  type StorageRunAnnotation,
  type StorageAnalyticsRecord,
} from './opensearchClient';

export { default } from './opensearchClient';

// Async storage wrappers (high-level API, matches app types)
export { asyncTestCaseStorage } from './asyncTestCaseStorage';
export type { CreateTestCaseInput, UpdateTestCaseInput } from './asyncTestCaseStorage';

export { asyncBenchmarkStorage, asyncExperimentStorage } from './asyncBenchmarkStorage';

export { asyncRunStorage, asyncReportStorage } from './asyncRunStorage';
export type { SearchQuery, GetReportsOptions } from './asyncRunStorage';

// Migration utilities (localStorage -> OpenSearch)
export {
  migrateToOpenSearch,
  hasLocalStorageData,
  getLocalStorageCounts,
  clearLocalStorageData,
  exportLocalStorageData,
  type MigrationStats,
  type MigrationOptions,
} from './migration';
