/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Migration utility for migrating data from localStorage to OpenSearch
 *
 * This utility helps users migrate their existing evaluation data
 * (test cases, experiments, reports) from browser localStorage to OpenSearch.
 */

import type { TestCase, Benchmark, Experiment, EvaluationReport } from '@/types';
import { asyncTestCaseStorage } from './asyncTestCaseStorage';
import { asyncBenchmarkStorage } from './asyncBenchmarkStorage';
import { asyncRunStorage } from './asyncRunStorage';

// localStorage keys used by the old storage system
const STORAGE_KEYS = {
  TEST_CASES: 'test_cases',
  EXPERIMENTS: 'experiments',
  REPORTS: 'test_case_runs',
  LEGACY_REPORTS: 'eval_reports_by_testcase',
  ANNOTATIONS: 'eval_annotations',
};

export interface MigrationStats {
  testCases: { total: number; migrated: number; skipped: number; errors: string[] };
  experiments: { total: number; migrated: number; skipped: number; errors: string[] };
  reports: { total: number; migrated: number; skipped: number; errors: string[] };
}

export interface MigrationOptions {
  /** Skip items that already exist in OpenSearch */
  skipExisting?: boolean;
  /** Dry run - don't actually write to OpenSearch */
  dryRun?: boolean;
  /** Callback for progress updates */
  onProgress?: (message: string, stats: MigrationStats) => void;
}

/**
 * Read test cases from localStorage
 */
function readLocalTestCases(): TestCase[] {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.TEST_CASES);
    if (!data) return [];
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading test cases from localStorage:', error);
    return [];
  }
}

/**
 * Read experiments from localStorage
 */
function readLocalExperiments(): Experiment[] {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.EXPERIMENTS);
    if (!data) return [];
    const experimentsMap = JSON.parse(data);
    return Object.values(experimentsMap) as Experiment[];
  } catch (error) {
    console.error('Error reading experiments from localStorage:', error);
    return [];
  }
}

/**
 * Read reports from localStorage
 */
function readLocalReports(): EvaluationReport[] {
  try {
    // Try new key first
    let data = localStorage.getItem(STORAGE_KEYS.REPORTS);

    // Fall back to legacy key
    if (!data) {
      data = localStorage.getItem(STORAGE_KEYS.LEGACY_REPORTS);
    }

    if (!data) return [];

    const reportsByTestCase = JSON.parse(data);
    const allReports: EvaluationReport[] = [];

    for (const reports of Object.values(reportsByTestCase)) {
      allReports.push(...(reports as EvaluationReport[]));
    }

    return allReports;
  } catch (error) {
    console.error('Error reading reports from localStorage:', error);
    return [];
  }
}

/**
 * Get counts of data in localStorage without reading full content
 */
export function getLocalStorageCounts(): { testCases: number; experiments: number; reports: number } {
  const testCases = readLocalTestCases();
  const experiments = readLocalExperiments();
  const reports = readLocalReports();

  return {
    testCases: testCases.length,
    experiments: experiments.length,
    reports: reports.length,
  };
}

/**
 * Check if there's any data in localStorage to migrate
 */
export function hasLocalStorageData(): boolean {
  const counts = getLocalStorageCounts();
  return counts.testCases > 0 || counts.experiments > 0 || counts.reports > 0;
}

/**
 * Migrate all data from localStorage to OpenSearch
 */
export async function migrateToOpenSearch(
  options: MigrationOptions = {}
): Promise<MigrationStats> {
  const { skipExisting = true, dryRun = false, onProgress } = options;

  const stats: MigrationStats = {
    testCases: { total: 0, migrated: 0, skipped: 0, errors: [] },
    experiments: { total: 0, migrated: 0, skipped: 0, errors: [] },
    reports: { total: 0, migrated: 0, skipped: 0, errors: [] },
  };

  const log = (message: string) => {
    console.log(`[Migration] ${message}`);
    onProgress?.(message, stats);
  };

  // ID mapping: old localStorage ID -> new OpenSearch ID
  const testCaseIdMap = new Map<string, string>();

  // Step 1: Migrate test cases
  log('Starting test case migration...');
  const localTestCases = readLocalTestCases();
  stats.testCases.total = localTestCases.length;

  if (localTestCases.length > 0) {
    // Get existing test cases if skipExisting is enabled
    let existingByName = new Map<string, string>();
    if (skipExisting && !dryRun) {
      try {
        const existing = await asyncTestCaseStorage.getAll();
        // Map by name for matching since IDs will be different
        existing.forEach(tc => existingByName.set(tc.name, tc.id));
      } catch {
        // If we can't fetch existing, continue anyway
      }
    }

    for (const testCase of localTestCases) {
      try {
        // Check if test case with same name already exists
        const existingId = existingByName.get(testCase.name);
        if (skipExisting && existingId) {
          stats.testCases.skipped++;
          // Map old ID to existing ID for experiment references
          testCaseIdMap.set(testCase.id, existingId);
          continue;
        }

        if (!dryRun) {
          // Create test case in OpenSearch
          const created = await asyncTestCaseStorage.create({
            name: testCase.name,
            description: testCase.description,
            category: testCase.category,
            subcategory: testCase.subcategory,
            difficulty: testCase.difficulty,
            initialPrompt: testCase.initialPrompt,
            context: testCase.context,
            tools: testCase.tools,
            expectedPPL: testCase.expectedPPL,
            expectedTrajectory: testCase.expectedTrajectory,
            followUpQuestions: testCase.followUpQuestions,
            isPromoted: testCase.isPromoted,
          });

          // Map old ID to new ID
          testCaseIdMap.set(testCase.id, created.id);
        } else {
          // For dry run, assume ID would stay the same
          testCaseIdMap.set(testCase.id, testCase.id);
        }

        stats.testCases.migrated++;
      } catch (error) {
        const errorMsg = `Failed to migrate test case ${testCase.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        stats.testCases.errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    log(`Test cases: ${stats.testCases.migrated} migrated, ${stats.testCases.skipped} skipped, ${stats.testCases.errors.length} errors`);
  }

  // Step 2: Migrate experiments (with embedded runs)
  log('Starting experiment migration...');
  const localExperiments = readLocalExperiments();
  stats.experiments.total = localExperiments.length;

  if (localExperiments.length > 0) {
    // Get existing experiments if skipExisting is enabled
    let existingByName = new Map<string, string>();
    if (skipExisting && !dryRun) {
      try {
        const existing = await asyncBenchmarkStorage.getAll();
        existing.forEach(e => existingByName.set(e.name, e.id));
      } catch {
        // If we can't fetch existing, continue anyway
      }
    }

    for (const experiment of localExperiments) {
      try {
        // Check if experiment with same name already exists
        if (skipExisting && existingByName.has(experiment.name)) {
          stats.experiments.skipped++;
          continue;
        }

        if (!dryRun) {
          // Remap testCaseIds to new test case IDs
          const remappedTestCaseIds = experiment.testCaseIds.map(oldId => {
            const newId = testCaseIdMap.get(oldId);
            if (!newId) {
              console.warn(`Test case ID mapping not found for ${oldId}, keeping original`);
              return oldId;
            }
            return newId;
          });

          // Create experiment with remapped IDs
          const migratedExperiment: Experiment = {
            ...experiment,
            testCaseIds: remappedTestCaseIds,
          };

          // Save experiment with its embedded runs
          await asyncBenchmarkStorage.save(migratedExperiment);
        }

        stats.experiments.migrated++;
      } catch (error) {
        const errorMsg = `Failed to migrate experiment ${experiment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        stats.experiments.errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    log(`Experiments: ${stats.experiments.migrated} migrated, ${stats.experiments.skipped} skipped, ${stats.experiments.errors.length} errors`);
  }

  // Step 3: Migrate reports
  log('Starting report migration...');
  const localReports = readLocalReports();
  stats.reports.total = localReports.length;

  if (localReports.length > 0) {
    // Get existing reports if skipExisting is enabled
    let existingIds = new Set<string>();
    if (skipExisting && !dryRun) {
      try {
        const existing = await asyncRunStorage.getAllReports({});
        existingIds = new Set(existing.map(r => r.id));
      } catch {
        // If we can't fetch existing, continue anyway
      }
    }

    for (const report of localReports) {
      try {
        if (skipExisting && existingIds.has(report.id)) {
          stats.reports.skipped++;
          continue;
        }

        if (!dryRun) {
          // Remap testCaseId to new ID if mapping exists
          const newTestCaseId = testCaseIdMap.get(report.testCaseId);
          const migratedReport: EvaluationReport = {
            ...report,
            testCaseId: newTestCaseId || report.testCaseId,
          };

          // Save report to OpenSearch
          await asyncRunStorage.saveReport(migratedReport);
        }

        stats.reports.migrated++;
      } catch (error) {
        const errorMsg = `Failed to migrate report ${report.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        stats.reports.errors.push(errorMsg);
        console.error(errorMsg);
      }
    }

    log(`Reports: ${stats.reports.migrated} migrated, ${stats.reports.skipped} skipped, ${stats.reports.errors.length} errors`);
  }

  log('Migration complete!');
  return stats;
}

/**
 * Clear localStorage data after successful migration
 * WARNING: This is destructive and should only be called after verifying migration success
 */
export function clearLocalStorageData(): void {
  const keys = Object.values(STORAGE_KEYS);

  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error(`Error removing localStorage key ${key}:`, error);
    }
  }

  // Also clear migration flags
  localStorage.removeItem('test_cases_seeded');
  localStorage.removeItem('test_cases_migration_v1');

  console.log('[Migration] localStorage data cleared');
}

/**
 * Export localStorage data as JSON for backup
 */
export function exportLocalStorageData(): string {
  const data = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    testCases: readLocalTestCases(),
    experiments: readLocalExperiments(),
    reports: readLocalReports(),
  };

  return JSON.stringify(data, null, 2);
}
