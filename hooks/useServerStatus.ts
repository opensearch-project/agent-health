/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';

interface ServerStatus {
  status: 'online' | 'offline';
  version: string | null;
  loading: boolean;
  features: Record<string, boolean>;
}

const POLL_INTERVAL_MS = 10000;

export function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<'online' | 'offline'>('offline');
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const response = await fetch('/health');
        if (response.ok) {
          const data = await response.json();
          setStatus('online');
          setVersion(data.version || null);
          setFeatures(data.features || {});
        } else {
          setStatus('offline');
          setVersion(null);
          setFeatures({});
        }
      } catch {
        setStatus('offline');
        setVersion(null);
        setFeatures({});
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
