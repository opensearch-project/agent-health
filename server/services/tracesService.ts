/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Traces Service - Fetch and transform OpenSearch trace data
 */

import https from 'https';
import http from 'http';
import { debug } from '../../lib/debug.js';

/**
 * Make HTTP/HTTPS request with configurable TLS verification
 */
function makeRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; tlsSkipVerify?: boolean }): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers,
      rejectUnauthorized: !options.tlsSkipVerify,
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode! >= 200 && res.statusCode! < 300,
          status: res.statusCode!,
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data),
        });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

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
  startTime?: number;
  endTime?: number;
  size?: number;
  serviceName?: string;
  textSearch?: string;
}

export interface TracesResponse {
  spans: NormalizedSpan[];
  total: number;
}

export interface HealthStatus {
  status: 'ok' | 'error';
  error?: string;
  index?: string;
}

export interface OpenSearchConfig {
  endpoint: string;
  username: string;
  password: string;
  indexPattern?: string;
  tlsSkipVerify?: boolean;
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
 * Fetch traces from OpenSearch by trace ID or run IDs
 */
export async function fetchTraces(
  options: TracesQueryOptions,
  config: OpenSearchConfig
): Promise<TracesResponse> {
  const { traceId, runIds, startTime, endTime, size = 500, serviceName, textSearch } = options;
  const { endpoint, username, password, indexPattern = 'otel-v1-apm-span-*', tlsSkipVerify } = config;

  // For live tailing, we allow queries with just time range + optional filters
  const hasTimeRange = startTime || endTime;
  const hasIdFilter = traceId || (runIds && runIds.length > 0);

  if (!hasIdFilter && !hasTimeRange) {
    throw new Error('Either traceId, runIds, or time range is required');
  }

  debug('TracesService', 'Fetching traces:', { traceId, runIds: runIds?.length, serviceName, textSearch, size });

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

  // Text search across span name, service name, and attributes
  if (textSearch) {
    must.push({
      query_string: {
        query: `*${textSearch}*`,
        fields: ['name', 'serviceName', 'span.attributes.*'],
        default_operator: 'AND'
      }
    });
  }

  const query = {
    size,
    sort: [{ 'startTime': { order: 'desc' } }],  // Most recent first for live tailing
    query: { bool: { must } }
  };

  debug('TracesService', 'OpenSearch query:', JSON.stringify(query, null, 2));

  // Query OpenSearch traces index
  const response = await makeRequest(`${endpoint}/${indexPattern}/_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    },
    body: JSON.stringify(query),
    tlsSkipVerify
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[TracesService] OpenSearch error:', response.status, errorText);
    throw new Error(`OpenSearch error: ${errorText}`);
  }

  const data = await response.json();

  // Transform spans
  const spans = (data.hits?.hits || []).map((hit: any) => transformSpan(hit._source));

  debug('TracesService', 'Found', spans.length, 'spans');

  return {
    spans,
    total: data.hits?.total?.value || spans.length
  };
}

/**
 * Check traces index availability
 */
export async function checkTracesHealth(config: OpenSearchConfig): Promise<HealthStatus> {
  const { endpoint, username, password, indexPattern = 'otel-v1-apm-span-*', tlsSkipVerify } = config;

  if (!endpoint || !username || !password) {
    return { status: 'error', error: 'OpenSearch not configured' };
  }

  try {
    const response = await makeRequest(
      `${endpoint}/_cat/indices/${indexPattern}?format=json`,
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        },
        tlsSkipVerify
      }
    );

    if (response.ok) {
      return { status: 'ok', index: indexPattern };
    } else {
      return { status: 'error', index: indexPattern };
    }
  } catch (error: any) {
    return { status: 'error', error: error.message };
  }
}
