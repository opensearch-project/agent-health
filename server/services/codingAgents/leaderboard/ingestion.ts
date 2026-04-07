/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 1: Ingestion pipeline.
 * Transforms local AgentSession[] into UsageEvent[] and indexes them
 * into the OpenSearch `ai_usage_events` index.
 */

import { createHash } from 'crypto';
import type { Client } from '@opensearch-project/opensearch';
import type { AgentSession } from '../types';
import type { UsageEvent, SyncResult, SyncStatus, LeaderboardConfig } from './types';
import { categorizeTool } from '../toolCategories';

export const USAGE_EVENTS_INDEX = 'ai_usage_events';

/** Hash a project path for privacy */
function hashProjectPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

/** Extract display name from project path (last segment only) */
function projectDisplayName(path: string): string {
  return path.split('/').pop() || path;
}

/** Convert an AgentSession to a UsageEvent */
export function sessionToEvent(session: AgentSession, config: LeaderboardConfig): UsageEvent {
  const toolCalls = Object.values(session.tool_counts).reduce((a, b) => a + b, 0);
  const toolErrors = session.total_tool_errors;

  // Get top 5 tools by call count
  const topTools = Object.entries(session.tool_counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  // Get unique tool categories
  const toolCategories = [...new Set(
    Object.keys(session.tool_counts).map(t => categorizeTool(t))
  )];

  // Cache hit rate
  const totalCacheTokens = session.cache_creation_input_tokens + session.cache_read_input_tokens;
  const cacheHitRate = totalCacheTokens > 0
    ? session.cache_read_input_tokens / totalCacheTokens
    : 0;

  return {
    user_id: config.userId,
    team_id: config.teamId,
    session_id: session.session_id,
    agent: session.agent,
    model: session.model ?? 'default',
    project_hash: hashProjectPath(session.project_path),
    project_display: projectDisplayName(session.project_path),
    start_time: session.start_time,
    duration_minutes: session.duration_minutes,
    user_message_count: session.user_message_count,
    assistant_message_count: session.assistant_message_count,
    input_tokens: session.input_tokens,
    output_tokens: session.output_tokens,
    cache_creation_tokens: session.cache_creation_input_tokens,
    cache_read_tokens: session.cache_read_input_tokens,
    estimated_cost: session.estimated_cost,
    total_tool_calls: toolCalls,
    total_tool_errors: toolErrors,
    tool_success_rate: toolCalls > 0 ? (toolCalls - toolErrors) / toolCalls : 1,
    top_tools: topTools,
    tool_categories: toolCategories,
    uses_mcp: session.uses_mcp,
    session_completed: session.session_completed,
    synced_at: new Date().toISOString(),
    source_server: session.server_name ?? 'local',
  };
}

/** Ensure the ai_usage_events index exists with proper mappings */
export async function ensureIndex(client: Client): Promise<void> {
  try {
    const exists = await client.indices.exists({ index: USAGE_EVENTS_INDEX });
    if (exists.body) return;
  } catch {
    // Index check failed — try to create
  }

  try {
    await client.indices.create({
      index: USAGE_EVENTS_INDEX,
      body: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
        },
        mappings: {
          properties: {
            user_id: { type: 'keyword' },
            team_id: { type: 'keyword' },
            session_id: { type: 'keyword' },
            agent: { type: 'keyword' },
            model: { type: 'keyword' },
            project_hash: { type: 'keyword' },
            project_display: { type: 'keyword' },
            start_time: { type: 'date' },
            duration_minutes: { type: 'float' },
            user_message_count: { type: 'integer' },
            assistant_message_count: { type: 'integer' },
            input_tokens: { type: 'long' },
            output_tokens: { type: 'long' },
            cache_creation_tokens: { type: 'long' },
            cache_read_tokens: { type: 'long' },
            estimated_cost: { type: 'float' },
            total_tool_calls: { type: 'integer' },
            total_tool_errors: { type: 'integer' },
            tool_success_rate: { type: 'float' },
            top_tools: { type: 'keyword' },
            tool_categories: { type: 'keyword' },
            uses_mcp: { type: 'boolean' },
            session_completed: { type: 'boolean' },
            synced_at: { type: 'date' },
            source_server: { type: 'keyword' },
          },
        },
      },
    });
  } catch (err: any) {
    // Index may already exist from a concurrent request
    if (err?.meta?.statusCode !== 400) throw err;
  }
}

/**
 * Sync sessions to OpenSearch.
 * Uses session_id as doc ID for deduplication — re-syncing is safe.
 */
export async function syncSessions(
  client: Client,
  sessions: AgentSession[],
  config: LeaderboardConfig,
): Promise<SyncResult> {
  if (sessions.length === 0) return { synced: 0, skipped: 0, errors: 0 };

  await ensureIndex(client);

  const events = sessions.map(s => sessionToEvent(s, config));

  // Bulk index with session_id as doc ID (idempotent)
  const body: any[] = [];
  for (const event of events) {
    body.push({ index: { _index: USAGE_EVENTS_INDEX, _id: event.session_id } });
    body.push(event);
  }

  const result = await client.bulk({ body, refresh: false });

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  if (result.body.items) {
    for (const item of result.body.items) {
      const action = item.index;
      if (action?.status === 200 || action?.status === 201) {
        synced++;
      } else if (action?.status === 409) {
        skipped++; // already exists
      } else {
        errors++;
      }
    }
  }

  return { synced, skipped, errors };
}

/** Get the current sync status (last sync time, total events) */
export async function getSyncStatus(
  client: Client,
  config: LeaderboardConfig,
): Promise<SyncStatus> {
  try {
    const exists = await client.indices.exists({ index: USAGE_EVENTS_INDEX });
    if (!exists.body) {
      return { last_sync_at: null, total_events: 0, user_id: config.userId, team_id: config.teamId };
    }

    const countResult = await client.count({
      index: USAGE_EVENTS_INDEX,
      body: {
        query: {
          bool: {
            filter: [
              { term: { team_id: config.teamId } },
            ],
          },
        },
      },
    });

    // Get latest synced_at
    const latestResult = await client.search({
      index: USAGE_EVENTS_INDEX,
      body: {
        size: 1,
        sort: [{ synced_at: { order: 'desc' } }],
        query: {
          bool: {
            filter: [
              { term: { team_id: config.teamId } },
            ],
          },
        },
        _source: ['synced_at'],
      },
    });

    const lastSync = latestResult.body.hits.hits[0]?._source?.synced_at ?? null;

    return {
      last_sync_at: lastSync,
      total_events: countResult.body.count ?? 0,
      user_id: config.userId,
      team_id: config.teamId,
    };
  } catch {
    return { last_sync_at: null, total_events: 0, user_id: config.userId, team_id: config.teamId };
  }
}
