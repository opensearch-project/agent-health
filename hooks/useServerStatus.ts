/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';

export interface FeatureFlags {
  codingAgentAnalytics: boolean;
}

interface ServerStatus {
  status: 'online' | 'offline';
  version: string | null;
  loading: boolean;
  features: FeatureFlags;
}

const POLL_INTERVAL_MS = 10000;

const DEFAULT_FEATURES: FeatureFlags = { codingAgentAnalytics: true };

export function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<'online' | 'offline'>('offline');
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const response = await fetch('/health');
        if (response.ok) {
          const data = await response.json();
          setStatus('online');
          setVersion(data.version || null);
          if (data.features) {
            setFeatures(data.features);
          }
        } else {
          setStatus('offline');
          setVersion(null);
          setFeatures(DEFAULT_FEATURES);
        }
      } catch {
        setStatus('offline');
        setVersion(null);
        setFeatures(DEFAULT_FEATURES);
      } finally {
        setLoading(false);
      }
    };

    // Initial check
    checkHealth();

    // Set up polling
    intervalRef.current = setInterval(checkHealth, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return { status, version, loading, features };
}
