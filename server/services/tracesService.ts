/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Traces Service - Fetch and transform OpenSearch trace data
 *
 * Uses the OpenSearch SDK Client (instead of raw HTTP) so that
 * authentication (basic auth or AWS SigV4) is handled transparently.
 */

import { Client } from '@opensearch-project/opensearch';
import { debug } from '../../lib/debug.js';

// ============================================================================
// Types
// ============================================================================

export interface OpenSearchSpanSource {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  durationInNanos?: number;
  kind?: string;
  serviceName?: string;
  'status.code'?: number;
  'instrumentationScope.name'?: string;
  events?: Array<{
    name: string;
    time: string;
    attributes?: Record<string, any>;
  }>;
  [key: string]: any; // For span.attributes.* and resource.attributes.* fields
}

export interface NormalizedSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  duration: number | null;
  status: 'ERROR' | 'OK' | 'UNSET';
  attributes: Record<string, any>;
  events: Array<{
    name: string;
    time: string;
    attributes: Record<string, any>;
  }>;
}

export interface TracesQueryOptions {
  traceId?: string;
  runIds?: string[];
  sessionId?: string;  // Claude Code session.id — fetches all traces in a session
  startTime?: number;
  endTime?: number;
  size?: number;
  serviceName?: string;
  textSearch?: string;
  cursor?: string; // For pagination: encoded search_after values
}

export interface TracesResponse {
  spans: NormalizedSpan[];
  total: number;
  nextCursor?: string | null; // Next page cursor (null if no more pages)
  hasMore?: boolean; // Whether more results are available
}

export type ErrorCategory = 'auth' | 'connection' | 'index_not_found' | 'unknown';

export interface HealthStatus {
  status: 'ok' | 'error';
  error?: string;
  errorCategory?: ErrorCategory;
  suggestion?: string;
  index?: string;
}

/**
 * Classify an OpenSearch client error into a user-friendly category with actionable suggestion.
 */
export function classifyOpenSearchError(error: any): { category: ErrorCategory; message: string; suggestion: string } {
  const statusCode = error.meta?.statusCode;
  const message = error.message || 'Unknown error';

  if (statusCode === 401 || statusCode === 403) {
    return {
      category: 'auth',
      message: `Authentication failed (HTTP ${statusCode})`,
      suggestion: 'AWS credentials may be expired or invalid. Run `aws sts get-caller-identity` to verify, then refresh with `aws sso login` or update your credentials.',
    };
  }

  if (statusCode === 404) {
    return {
      category: 'index_not_found',
      message: 'Trace index not found',
      suggestion: 'The OpenSearch traces index does not exist yet. Ensure your agents are configured to emit OpenTelemetry spans.',
    };
  }

  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('getaddrinfo') || message.includes('Connection refused')) {
    return {
      category: 'connection',
      message: `Cannot connect to OpenSearch: ${message}`,
      suggestion: 'Check that the OpenSearch endpoint is correct and the cluster is reachable from your network.',
    };
  }

  return {
    category: 'unknown',
    message,
    suggestion: 'Check the server logs for more details.',
  };
}

// ============================================================================
// Transformation Functions
// ============================================================================

/**
 * Transform OpenSearch span document to normalized format
 * Handles both flattened (@ notation) and nested attribute structures
 */
export function transformSpan(source: OpenSearchSpanSource): NormalizedSpan {
  const attributes: Record<string, any> = {};

  // Handle flattened span.attributes.* fields (convert @ to . notation)
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('span.attributes.')) {
      const attrName = key.replace('span.attributes.', '').replace(/@/g, '.');
      attributes[attrName] = value;
    } else if (key.startsWith('resource.attributes.')) {
      const attrName = key.replace('resource.attributes.', '').replace(/@/g, '.');
      attributes[attrName] = value;
    }
  }

  // Handle nested attributes object (OTel standard format)
  const attrs = (source as any).attributes;
  if (attrs && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      attributes[key] = value;
    }
  }

  // Handle nested resource.attributes object (OTel standard format)
  const resource = (source as any).resource;
  if (resource?.attributes && typeof resource.attributes === 'object') {
    for (const [key, value] of Object.entries(resource.attributes)) {
      attributes[key] = value;
    }
  }

  attributes['spanKind'] = source.kind;
  attributes['serviceName'] = source.serviceName;

  // Process events
  const events = (source.events || []).map(event => ({
    name: event.name,
    time: event.time,
    attributes: Object.fromEntries(
      Object.entries(event.attributes || {}).map(([k, v]) => [k.replace(/@/g, '.'), v])
    )
  }));

  // Add instrumentation scope (handle both flattened and nested)
  if (source['instrumentationScope.name']) {
    attributes['instrumentation.scope.name'] = source['instrumentationScope.name'];
  }
  const instrScope = (source as any).instrumentationScope;
  if (instrScope?.name) {
    attributes['instrumentation.scope.name'] = instrScope.name;
  }

  // Get status code (handle both flattened and nested)
  const statusCode = source['status.code'] ?? (source as any).status?.code;

  return {
    traceId: source.traceId,
    spanId: source.spanId,
    parentSpanId: source.parentSpanId,
    name: source.name,
    startTime: source.startTime,
    endTime: source.endTime,
    duration: source.durationInNanos ? source.durationInNanos / 1000000 : null,
    status: statusCode === 2 ? 'ERROR' : (statusCode === 1 ? 'OK' : 'UNSET'),
    attributes,
    events
  };
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Fetch traces from OpenSearch by trace ID or run IDs.
 * Uses the SDK Client so authentication (basic / SigV4) is handled automatically.
 */
export async function fetchTraces(
  options: TracesQueryOptions,
  client: Client,
  indexPattern: string = 'otel-v1-apm-span-*'
): Promise<TracesResponse> {
  const { traceId, runIds, sessionId, startTime, endTime, size = 100, serviceName, textSearch, cursor } = options;

  // For live tailing, we allow queries with just time range + optional filters
  const hasTimeRange = startTime || endTime;
  const hasIdFilter = traceId || (runIds && runIds.length > 0) || sessionId;

  if (!hasIdFilter && !hasTimeRange) {
    throw new Error('Either traceId, runIds, sessionId, or time range is required');
  }

  debug('TracesService', 'Fetching traces:', { traceId, runIds: runIds?.length, serviceName, textSearch, size, cursor: cursor ? 'present' : 'none' });

  // Build OpenSearch query
  const must: any[] = [];

  if (traceId) {
    must.push({ term: { 'traceId': traceId } });
  }

  if (runIds && runIds.length > 0) {
    must.push({
      terms: { 'span.attributes.gen_ai@request@id': runIds }
    });
  }

  if (sessionId) {
    must.push({ term: { 'span.attributes.session@id': sessionId } });
  }

  if (startTime || endTime) {
    const range: any = { 'startTime': {} };
    if (startTime) range['startTime'].gte = new Date(startTime).toISOString();
    if (endTime) range['startTime'].lte = new Date(endTime).toISOString();
    must.push({ range });
  }

  // Filter by service/agent name
  if (serviceName) {
    must.push({
      bool: {
        should: [
          { term: { 'serviceName': serviceName } },
          { term: { 'span.attributes.gen_ai@agent@name': serviceName } }
        ],
        minimum_should_match: 1
      }
    });
  }

  // Text search across span name and attributes
  if (textSearch) {
    must.push({
      query_string: {
        query: `*${textSearch}*`,
        fields: ['name', 'span.attributes.*'],
        default_operator: 'AND'
      }
    });
  }

  const body: any = {
    size,
    sort: [{ 'startTime': { order: 'desc' } }],  // Most recent first for live tailing
    query: { bool: { must } }
  };

  // Add cursor for pagination (search_after in OpenSearch)
  if (cursor) {
    try {
      body.search_after = JSON.parse(decodeURIComponent(cursor));
      debug('TracesService', 'Using cursor (search_after):', body.search_after);
    } catch (e) {
      console.error('[TracesService] Invalid cursor:', e);
      // Continue without cursor if invalid
    }
  }

  debug('TracesService', 'OpenSearch query:', JSON.stringify(body, null, 2));

  // Query OpenSearch traces index via SDK client
  const response = await client.search({
    index: indexPattern,
    body,
  });

  const data = response.body;

  // Transform spans
  const hits = data.hits?.hits || [];
  const spans = hits.map((hit: any) => transformSpan(hit._source));

  // Generate next cursor from last hit's sort values
  const lastHit = hits[hits.length - 1];
  const nextCursor = lastHit?.sort
    ? encodeURIComponent(JSON.stringify(lastHit.sort))
    : null;

  // Check if there are more results (when we get exactly 'size' results, assume there might be more)
  const hasMore = spans.length === size;

  debug('TracesService', 'Found', spans.length, 'spans', hasMore ? '(more available)' : '(end of results)');

  return {
    spans,
    total: (typeof data.hits?.total === 'object' ? data.hits.total.value : data.hits?.total) || spans.length,
    nextCursor,
    hasMore
  };
}

/**
 * Check traces index availability via SDK client
 */
export async function checkTracesHealth(
  client: Client,
  indexPattern: string = 'otel-v1-apm-span-*'
): Promise<HealthStatus> {
  try {
    const response = await client.cat.indices({
      index: indexPattern,
      format: 'json',
    });

    if (response.statusCode === 200) {
      return { status: 'ok', index: indexPattern };
    } else {
      return { status: 'error', index: indexPattern };
    }
  } catch (error: any) {
    const classified = classifyOpenSearchError(error);
    return {
      status: 'error',
      error: classified.message,
      errorCategory: classified.category,
      suggestion: classified.suggestion,
    };
  }
}
