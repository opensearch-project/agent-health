/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useClusterContext
 *
 * Receiving pages (Skills, Settings, TestCases, QuickRun) call this to
 * read the cluster context the comparison page navigated with.
 *
 * Resolution order:
 *   1. router location.state.fromCluster — present when the strip used
 *      route-with-state (avoids any extra fetch).
 *   2. ?clusterId=<id> query — fetches /api/comparison/clusters/:id.
 *
 * Returns { context, loading, error }. When neither source is present
 * (the user landed on the page directly), context is null and the page
 * renders normally with no banner.
 */

import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { fetchClusterById, type ClusterContextRecord } from '@/services/client/comparisonClusterApi';

export interface UseClusterContextResult {
  context: ClusterContextRecord | null;
  loading: boolean;
  error: string | null;
}

interface RouterStateShape {
  fromCluster?: {
    clusterId?: string;
    clusterName?: string;
    clusterSummary?: string;
    clusterType?: ClusterContextRecord['clusterType'];
    caseIds?: string[];
  };
}

export function useClusterContext(): UseClusterContextResult {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [context, setContext] = useState<ClusterContextRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stateCluster = (location.state as RouterStateShape | null)?.fromCluster;
  const queryId = searchParams.get('clusterId');

  useEffect(() => {
    let cancelled = false;

    // Fast path: state already has the full cluster shape.
    if (stateCluster?.clusterId && stateCluster.clusterName && stateCluster.clusterSummary && stateCluster.clusterType && stateCluster.caseIds) {
      setContext({
        id: stateCluster.clusterId,
        name: stateCluster.clusterName,
        summary: stateCluster.clusterSummary,
        clusterType: stateCluster.clusterType,
        caseIds: stateCluster.caseIds,
        loserLabel: '',
        winnerLabel: '',
      });
      setLoading(false);
      setError(null);
      return;
    }

    // Slow path: id-only — fetch from server.
    const id = stateCluster?.clusterId ?? queryId;
    if (!id) {
      setContext(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetchClusterById(id)
      .then(record => {
        if (cancelled) return;
        setContext(record);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [stateCluster?.clusterId, queryId]);

  return { context, loading, error };
}
