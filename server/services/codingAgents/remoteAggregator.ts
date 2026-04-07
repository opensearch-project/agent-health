/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Remote Aggregator — fetches session data from remote agent-health servers
 * and merges it with local data. All computation methods in CodingAgentRegistry
 * call getAllSessions() internally, so overriding that single method
 * transparently enables multi-server aggregation.
 */

import type { AgentSession, AgentKind, DateRange, SessionDetail } from './types';
import type { RemoteServerConfig } from '@/lib/config/types';
import { CodingAgentRegistry } from './registry';

interface RemoteCache {
  sessions: AgentSession[];
  fetchedAt: number;
}

const REMOTE_CACHE_TTL = 30_000; // 30 seconds
const REMOTE_TIMEOUT = 10_000;   // 10 seconds

export class RemoteAggregator extends CodingAgentRegistry {
  private remoteServers: RemoteServerConfig[];
  private remoteCache = new Map<string, RemoteCache>();

  constructor(remoteServers: RemoteServerConfig[]) {
    super();
    this.remoteServers = remoteServers;
  }

  override async getAllSessions(range?: DateRange): Promise<AgentSession[]> {
    // Use Promise.allSettled so one failing remote doesn't block local data
    const results = await Promise.allSettled([
      super.getAllSessions(range),
      ...this.remoteServers.map(s => this.fetchRemoteSessions(s, range)),
    ]);

    const localSessions = results[0].status === 'fulfilled' ? results[0].value : [];
    if (results[0].status === 'rejected') {
      console.warn('[RemoteAggregator] Local session fetch failed:', results[0].reason);
    }

    const remoteSessions = results.slice(1)
      .filter((r): r is PromiseFulfilledResult<AgentSession[]> => r.status === 'fulfilled')
      .map(r => r.value);

    // Tag local sessions
    const tagged = localSessions.map(s => ({ ...s, server_name: 'local' }));

    // Merge all
    const all = [...tagged, ...remoteSessions.flat()];
    return all.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  }

  override async getSessionDetail(agent: AgentKind, sessionId: string, serverName?: string): Promise<SessionDetail | null> {
    // Route to specific remote server if specified
    if (serverName && serverName !== 'local') {
      const remote = this.remoteServers.find(s => s.name === serverName);
      if (!remote) return null;
      return this.fetchRemoteSessionDetail(remote, agent, sessionId);
    }
    return super.getSessionDetail(agent, sessionId);
  }

  private async fetchRemoteSessions(server: RemoteServerConfig, range?: DateRange): Promise<AgentSession[]> {
    // Check cache
    const cached = this.remoteCache.get(server.name);
    if (cached && Date.now() - cached.fetchedAt < REMOTE_CACHE_TTL) {
      return this.filterByRange(cached.sessions, range);
    }

    try {
      const url = new URL('/api/coding-agents/sessions', server.url);
      url.searchParams.set('limit', '10000');

      const response = await fetchWithTimeout(url.toString(), server.apiKey);
      const data = await response.json() as { sessions: AgentSession[] };

      // Tag with server_name
      const sessions = (data.sessions || []).map(s => ({
        ...s,
        server_name: server.name,
      }));

      // Update cache (unfiltered)
      this.remoteCache.set(server.name, { sessions, fetchedAt: Date.now() });

      return this.filterByRange(sessions, range);
    } catch (error) {
      console.warn(`[RemoteAggregator] Failed to fetch from ${server.name} (${server.url}):`, error instanceof Error ? error.message : error);
      // Return cached data if available, even if stale
      if (cached) return this.filterByRange(cached.sessions, range);
      return [];
    }
  }

  private async fetchRemoteSessionDetail(server: RemoteServerConfig, agent: AgentKind, sessionId: string): Promise<SessionDetail | null> {
    try {
      const url = new URL(`/api/coding-agents/sessions/${agent}/${sessionId}`, server.url);
      const response = await fetchWithTimeout(url.toString(), server.apiKey);
      if (!response.ok) return null;
      return await response.json() as SessionDetail;
    } catch {
      return null;
    }
  }

  private filterByRange(sessions: AgentSession[], range?: DateRange): AgentSession[] {
    if (!range?.from && !range?.to) return sessions;
    return sessions.filter(s => {
      const t = s.start_time;
      if (range.from && t < range.from) return false;
      if (range.to && t > range.to + 'T23:59:59') return false;
      return true;
    });
  }

  getRemoteServerNames(): string[] {
    return this.remoteServers.map(s => s.name);
  }
}

async function fetchWithTimeout(url: string, apiKey?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT);

  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}
