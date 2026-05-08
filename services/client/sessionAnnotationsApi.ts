/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @experimental Client API for session metadata.
 * Generic GET/PUT for any sidecar data on coding agent sessions.
 */

import type { SessionMetadata } from '@/types';
import { ENV_CONFIG } from '@/lib/config';

const BASE = () => `${ENV_CONFIG.backendUrl}/api/coding-agents/sessions`;

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Get session metadata (returns null if none exists) */
export function getSessionMetadata(agentKind: string, sessionId: string): Promise<SessionMetadata | null> {
  return fetchJson<SessionMetadata | null>(`${BASE()}/${agentKind}/${sessionId}/metadata`);
}

/** Upsert session metadata (merges with existing) */
export function putSessionMetadata(agentKind: string, sessionId: string, data: Record<string, unknown>): Promise<SessionMetadata> {
  return fetchJson<SessionMetadata>(`${BASE()}/${agentKind}/${sessionId}/metadata`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/** List all sessions that have metadata */
export function listSessionMetadata(options?: { size?: number; from?: number }): Promise<{ items: SessionMetadata[]; total: number }> {
  const params = new URLSearchParams();
  if (options?.size) params.set('size', String(options.size));
  if (options?.from) params.set('from', String(options.from));
  const qs = params.toString();
  return fetchJson(`${BASE()}/metadata${qs ? `?${qs}` : ''}`);
}
