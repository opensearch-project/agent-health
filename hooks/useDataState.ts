/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { getConfigStatus } from '@/lib/dataSourceConfig';

export interface DataState {
  hasStorageConfigured: boolean;
  hasData: boolean; // Same as hasStorageConfigured for now
}

interface UseDataStateReturn {
  dataState: DataState;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook to detect whether the user has configured a storage cluster.
 * 
 * This hook checks:
 * - If storage cluster is configured (via getConfigStatus API)
 * - Returns hasData = hasStorageConfigured
 * 
 * Used to determine whether to show FirstRunExperience or standard dashboard.
 * FirstRunExperience is shown when no storage cluster is configured.
 */
export function useDataState(): UseDataStateReturn {
  const [dataState, setDataState] = useState<DataState>({
    hasStorageConfigured: false,
    hasData: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkDataState = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Check if storage cluster is configured
        const configStatus = await getConfigStatus();
        const hasStorageConfigured = configStatus.storage.configured;

        setDataState({
          hasStorageConfigured,
          hasData: hasStorageConfigured,
        });
      } catch (err) {
        // On error, default to unconfigured state (show FirstRunExperience)
        // This is a fail-safe: better to show onboarding than a broken dashboard
        console.error('[useDataState] Failed to load config status:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        setDataState({
          hasStorageConfigured: false,
          hasData: false,
        });
      } finally {
        setIsLoading(false);
      }
    };

    checkDataState();
  }, []);

  return { dataState, isLoading, error };
}
