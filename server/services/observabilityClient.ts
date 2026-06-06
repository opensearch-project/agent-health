/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observability Client Pool
 *
 * Shared OpenSearch client for traces, metrics, and logs queries.
 * Supports Basic auth, SigV4, and no-auth via agent-health config.
 * Clients are cached by config fingerprint and auto-cleaned after 5 min idle.
 */

import { Request } from 'express';
import { Client } from '@opensearch-project/opensearch';
import { resolveObservabilityConfig, DEFAULT_OTEL_INDEXES } from '../middleware/dataSourceConfig.js';
import { createOpenSearchClient, configToCacheKey } from './opensearchClientFactory.js';
import type { ClusterConfig } from '../../types/index.js';

interface CachedClient {
  client: Client;
  lastUsed: number;
}

const clientCache = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clientCache.entries()) {
    if (now - entry.lastUsed > CLIENT_TTL_MS) {
      entry.client.close().catch(() => {});
      clientCache.delete(key);
    }
  }
}, 60 * 1000);

function getOrCreateClient(config: ClusterConfig): Client {
  const key = configToCacheKey(config);
  const cached = clientCache.get(key);

  if (cached) {
    cached.lastUsed = Date.now();
    return cached.client;
  }

  const client = createOpenSearchClient(config);
  clientCache.set(key, { client, lastUsed: Date.now() });
  return client;
}

export interface ObservabilityClientResult {
  client: Client;
  indexes: {
    traces: string;
    logs: string;
    metrics: string;
  };
}

/**
 * Get a pooled OpenSearch client for observability queries.
 * Returns null if observability is not configured.
 *
 * Usage:
 *   const obs = getObservabilityClient(req);
 *   if (!obs) return res.status(503).json({ error: 'Not configured' });
 *   const result = await obs.client.search({ index: obs.indexes.traces, body });
 */
export function getObservabilityClient(req: Request): ObservabilityClientResult | null {
  const config = resolveObservabilityConfig(req);
  if (!config) return null;

  const client = getOrCreateClient(config);
  return {
    client,
    indexes: {
      traces: config.indexes?.traces || DEFAULT_OTEL_INDEXES.traces,
      logs: config.indexes?.logs || DEFAULT_OTEL_INDEXES.logs,
      metrics: config.indexes?.metrics || DEFAULT_OTEL_INDEXES.metrics,
    },
  };
}
