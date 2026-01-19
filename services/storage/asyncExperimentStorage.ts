/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Async Experiment Storage
 *
 * Async wrapper around OpenSearch storage for experiments.
 * Maps between app's Experiment type and OpenSearch StorageExperiment.
 */

import { experimentStorage as opensearchExperiments, StorageExperiment, StorageExperimentRunConfig } from './opensearchClient';
import type { Experiment, ExperimentRun, RunResultStatus } from '@/types';

/**
 * Convert OpenSearch storage format to app Experiment format
 */
function toExperiment(stored: StorageExperiment): Experiment {
  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    createdAt: stored.createdAt,
    updatedAt: stored.createdAt, // Immutable, so updatedAt = createdAt
    testCaseIds: stored.testCaseIds,
    runs: (stored.runs || []).map(toExperimentRun),
  };
}

/**
 * Convert OpenSearch run config to app ExperimentRun format
 */
function toExperimentRun(stored: StorageExperimentRunConfig): ExperimentRun {
  // Convert results with proper typing for status field
  const results: Record<string, { reportId: string; status: RunResultStatus }> = {};
  if (stored.results) {
    Object.entries(stored.results).forEach(([key, value]) => {
      results[key] = {
        reportId: value.reportId,
        status: value.status as RunResultStatus,
      };
    });
  }

  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    createdAt: stored.createdAt,
    agentKey: stored.agentId,
    modelId: stored.modelId,
    headers: stored.headers,
    results,
  };
}

/**
 * Convert app Experiment format to OpenSearch storage format
 */
function toStorageFormat(experiment: Omit<Experiment, 'updatedAt'>): Omit<StorageExperiment, 'id' | 'createdAt'> {
  return {
    name: experiment.name,
    description: experiment.description,
    testCaseIds: experiment.testCaseIds,
    runs: (experiment.runs || []).map(run => ({
      id: run.id,
      name: run.name,
      description: run.description,
      agentId: run.agentKey,
      modelId: run.modelId,
      headers: run.headers,
      createdAt: run.createdAt,
      results: run.results,
    })),
  };
}

class AsyncExperimentStorage {
  // ==================== Experiment CRUD Operations ====================

  /**
   * Get all experiments, sorted by createdAt descending
   */
  async getAll(): Promise<Experiment[]> {
    const stored = await opensearchExperiments.getAll();
    const experiments = stored.map(toExperiment);
    // Sort by createdAt descending (most recent first)
    return experiments.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
  }

  /**
   * Get a single experiment by ID
   */
  async getById(id: string): Promise<Experiment | null> {
    const stored = await opensearchExperiments.getById(id);
    return stored ? toExperiment(stored) : null;
  }

  /**
   * Create a new experiment (immutable)
   */
  async create(experiment: Omit<Experiment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Experiment> {
    const storageData = toStorageFormat(experiment as Experiment);
    const created = await opensearchExperiments.create(storageData);
    return toExperiment(created);
  }

  /**
   * Save an experiment (create only - experiments are immutable)
   * For compatibility with existing code that calls save()
   */
  async save(experiment: Experiment): Promise<Experiment> {
    // Check if exists
    const existing = await this.getById(experiment.id);
    if (existing) {
      // Experiments are immutable - return existing
      console.warn('Experiment already exists and cannot be updated:', experiment.id);
      return existing;
    }

    const storageData = toStorageFormat(experiment);
    const created = await opensearchExperiments.create({
      ...storageData,
      id: experiment.id,
    } as StorageExperiment);
    return toExperiment(created);
  }

  /**
   * Delete an experiment
   */
  async delete(id: string): Promise<boolean> {
    const result = await opensearchExperiments.delete(id);
    return result.deleted;
  }

  /**
   * Get total count of experiments
   */
  async getCount(): Promise<number> {
    const experiments = await this.getAll();
    return experiments.length;
  }

  // ==================== Run Operations ====================
  // Note: In OpenSearch model, runs are embedded in experiment.
  // Actual execution results go to evals_runs index, not here.

  /**
   * Get all run configs for an experiment
   */
  async getRuns(experimentId: string): Promise<ExperimentRun[]> {
    const experiment = await this.getById(experimentId);
    if (!experiment) return [];
    return experiment.runs || [];
  }

  /**
   * Get a specific run config by ID from an experiment
   */
  async getRunById(experimentId: string, runId: string): Promise<ExperimentRun | null> {
    const experiment = await this.getById(experimentId);
    if (!experiment) return null;
    return experiment.runs?.find(r => r.id === runId) || null;
  }

  /**
   * Add or update a run in an experiment
   */
  async addRun(experimentId: string, run: ExperimentRun): Promise<boolean> {
    console.log('[asyncExperimentStorage] addRun called', { experimentId, runId: run.id });

    const experiment = await this.getById(experimentId);
    if (!experiment) {
      console.error('[asyncExperimentStorage] Experiment not found:', experimentId);
      return false;
    }
    console.log('[asyncExperimentStorage] Found experiment, current runs:', experiment.runs?.length || 0);

    const currentRuns = experiment.runs || [];
    const existingIndex = currentRuns.findIndex(r => r.id === run.id);

    let updatedRuns: ExperimentRun[];
    if (existingIndex >= 0) {
      // Update existing run
      console.log('[asyncExperimentStorage] Updating existing run at index:', existingIndex);
      updatedRuns = [...currentRuns];
      updatedRuns[existingIndex] = run;
    } else {
      // Add new run
      console.log('[asyncExperimentStorage] Adding new run');
      updatedRuns = [...currentRuns, run];
    }

    // Convert to storage format
    const storageRuns = updatedRuns.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      agentId: r.agentKey,
      modelId: r.modelId,
      headers: r.headers,
      createdAt: r.createdAt,
      results: r.results,
    }));

    console.log('[asyncExperimentStorage] Saving updated runs:', storageRuns.length);
    await opensearchExperiments.update(experimentId, { runs: storageRuns });
    console.log('[asyncExperimentStorage] Runs saved successfully');
    return true;
  }

  /**
   * Delete a run config from an experiment
   */
  async deleteRun(experimentId: string, runId: string): Promise<boolean> {
    const experiment = await this.getById(experimentId);
    if (!experiment) return false;

    const currentRuns = experiment.runs || [];
    const filteredRuns = currentRuns.filter(r => r.id !== runId);

    // If no run was removed, return false
    if (filteredRuns.length === currentRuns.length) return false;

    // Update the experiment with the filtered runs
    const updatedRuns = filteredRuns.map(run => ({
      id: run.id,
      name: run.name,
      description: run.description,
      agentId: run.agentKey,
      modelId: run.modelId,
      headers: run.headers,
      createdAt: run.createdAt,
      results: run.results,
    }));

    await opensearchExperiments.update(experimentId, { runs: updatedRuns });
    return true;
  }

  // ==================== Utility Functions ====================

  /**
   * Generate a unique experiment ID
   */
  generateExperimentId(): string {
    return `exp-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Generate a unique run ID
   */
  generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Bulk create experiments (for migration)
   */
  async bulkCreate(experiments: Experiment[]): Promise<{ created: number; errors: boolean }> {
    const storageData = experiments.map(exp => ({
      ...toStorageFormat(exp),
      id: exp.id,
      createdAt: exp.createdAt,
    }));
    return opensearchExperiments.bulkCreate(storageData);
  }
}

// Export singleton instance
export const asyncExperimentStorage = new AsyncExperimentStorage();
