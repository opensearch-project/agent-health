/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage Client Middleware
 *
 * Resolves storage configuration from request headers or environment variables
 * and attaches an OpenSearch client to the request object.
 *
 * This enables dynamic data source configuration from the UI while
 * maintaining efficient client pooling.
 */

import { Request, Response, NextFunction } from 'express';
import { Client } from '@opensearch-project/opensearch';
import { resolveStorageConfig } from './dataSourceConfig.js';
import type { StorageClusterConfig } from '../../types/index.js';

// Client cache keyed by endpoint+credentials (avoids creating new clients per request)
interface CachedClient {
  client: Client;
  lastUsed: number;
}

const clientCache = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a cache key from storage configuration
 */
function configToKey(config: StorageClusterConfig): string {
  return `${config.endpoint}|${config.username || ''}|${config.password || ''}`;
}

/**
 * Get an existing client from cache or create a new one
 */
function getOrCreateClient(config: StorageClusterConfig): Client {
  const key = configToKey(config);
  const cached = clientCache.get(key);

  if (cached) {
    cached.lastUsed = Date.now();
    return cached.client;
  }

  const clientConfig: any = {
    node: config.endpoint,
    ssl: { rejectUnauthorized: false },
  };

  // Add auth only if credentials provided
  if (config.username && config.password) {
    clientConfig.auth = {
      username: config.username,
      password: config.password,
    };
  }

  const client = new Client(clientConfig);
  clientCache.set(key, { client, lastUsed: Date.now() });

  return client;
}

/**
 * Cleanup expired clients every minute
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clientCache.entries()) {
    if (now - entry.lastUsed > CLIENT_TTL_MS) {
      entry.client.close().catch(() => {
        // Ignore close errors
      });
      clientCache.delete(key);
    }
  }
}, 60 * 1000);

/**
 * Storage client middleware
 *
 * Attaches req.storageClient and req.storageConfig to the request object.
 * These are null if storage is not configured.
 */
export function storageClientMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const config = resolveStorageConfig(req);

  if (config) {
    req.storageClient = getOrCreateClient(config);
    req.storageConfig = config;
  } else {
    req.storageClient = null;
    req.storageConfig = null;
  }

  next();
}

/**
 * Check if storage is available for the current request
 */
export function isStorageAvailable(req: Request): boolean {
  return req.storageClient !== null;
}

/**
 * Get the storage client from the request, throwing if not configured
 */
export function requireStorageClient(req: Request): Client {
  if (!req.storageClient) {
    throw new Error('Storage not configured');
  }
  return req.storageClient;
}

/**
 * Get the storage client from the request, returning null if not configured
 */
export function getStorageClient(req: Request): Client | null {
  return req.storageClient;
}

/**
 * Index names for storage (same as opensearchClient.ts for consistency)
 * Note: benchmarks key uses old index name 'evals_experiments' for data compatibility
 */
export const INDEXES = {
  testCases: 'evals_test_cases',
  benchmarks: 'evals_experiments',
  runs: 'evals_runs',
  analytics: 'evals_analytics',
} as const;

export type IndexName = (typeof INDEXES)[keyof typeof INDEXES];
