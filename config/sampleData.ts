/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Data Configuration
 * 
 * Defines the sample cluster used for first-run experience.
 * This configuration can be easily updated to point to a different
 * sample dataset in the future (e.g., public-facing demo data).
 */

export interface SampleDataConfig {
  clusterId: string;
  clusterName: string;
  description: string;
}

/**
 * Sample cluster configuration
 * 
 * Currently points to the internal trial cluster.
 * Future: Replace with public-facing sample dataset.
 */
export const SAMPLE_DATA_CONFIG: SampleDataConfig = {
  clusterId: 'internal-trial-cluster',
  clusterName: 'Sample Agent Benchmarks',
  description: 'Pre-configured benchmarks and traces for exploration',
};

/**
 * Load sample data by setting the active cluster to the sample cluster.
 * 
 * This function will:
 * 1. Set the active cluster to the sample cluster ID
 * 2. Trigger a data refresh to load sample benchmarks and reports
 * 
 * @throws Error if sample data loading fails
 */
export async function loadSampleData(): Promise<void> {
  try {
    // TODO: Implement actual cluster switching logic
    // This will depend on how cluster selection is implemented in the app
    // For now, this is a placeholder that logs the action
    
    console.log('[SampleData] Loading sample cluster:', SAMPLE_DATA_CONFIG.clusterId);
    
    // Future implementation:
    // 1. Call cluster service to set active cluster
    // 2. Trigger data refresh
    // 3. Navigate to dashboard
    
    // Placeholder: Store sample cluster ID in localStorage
    localStorage.setItem('active-cluster-id', SAMPLE_DATA_CONFIG.clusterId);
    
    // Simulate async operation
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('[SampleData] Sample data loaded successfully');
  } catch (error) {
    console.error('[SampleData] Failed to load sample data:', error);
    throw new Error(
      `Failed to load sample data: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Check if the current cluster is the sample cluster
 * 
 * @returns true if the active cluster is the sample cluster
 */
export function isSampleDataActive(): boolean {
  const activeClusterId = localStorage.getItem('active-cluster-id');
  return activeClusterId === SAMPLE_DATA_CONFIG.clusterId;
}
