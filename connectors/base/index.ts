/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';
import { debug as centralDebug } from '@/lib/debug';
import { trace, context as otelContext, propagation } from '@opentelemetry/api';
import type {
  AgentConnector,
  ConnectorAuth,
  ConnectorProtocol,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
  TraceContextStrategy,
} from '@/connectors/types';

/**
 * Abstract base class for connectors
 * Provides common functionality like auth header building and error handling
 */
export abstract class BaseConnector implements AgentConnector {
  abstract readonly type: ConnectorProtocol;
  abstract readonly name: string;
  abstract readonly supportsStreaming: boolean;

  /**
   * Trace-context propagation strategy. Subclasses set defaults; users can
   * override per-agent via `connectorConfig.traceContext` (merged in execute()).
   */
  traceContext?: TraceContextStrategy;

  /**
   * Build payload for the agent request
   * Subclasses must implement this to transform standard format to agent-specific format
   */
  abstract buildPayload(request: ConnectorRequest): any;

  /**
   * Execute the request
   * Subclasses must implement the actual execution logic
   */
  abstract execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse>;

  /**
   * Parse raw response into TrajectoryStep array
   * Subclasses must implement protocol-specific parsing
   */
  abstract parseResponse(rawResponse: any): TrajectoryStep[];

  /**
   * Build HTTP headers from auth configuration
   * @param auth Authentication configuration
   * @returns Headers object ready for fetch/axios
   */
  protected buildAuthHeaders(auth: ConnectorAuth): Record<string, string> {
    const headers: Record<string, string> = {};

    switch (auth.type) {
      case 'basic':
        if (auth.username && auth.password) {
          const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
          headers['Authorization'] = `Basic ${credentials}`;
        }
        break;

      case 'bearer':
        if (auth.token) {
          headers['Authorization'] = `Bearer ${auth.token}`;
        }
        break;

      case 'api-key':
        if (auth.token) {
          // Common API key header patterns
          headers['X-API-Key'] = auth.token;
          headers['x-api-key'] = auth.token; // Some APIs use lowercase
        }
        break;

      case 'aws-sigv4':
        // AWS SigV4 signing would be handled separately
        // This is a placeholder - actual implementation would use aws4 or @aws-sdk/signature-v4
        console.warn('[BaseConnector] AWS SigV4 auth requires runtime signing');
        break;

      case 'none':
      default:
        // No auth headers needed
        break;
    }

    // Always apply custom headers (can override auth headers if needed)
    if (auth.headers) {
      Object.assign(headers, auth.headers);
    }

    return headers;
  }

  /**
   * Build environment variables from auth configuration
   * Used by subprocess connectors
   */
  protected buildAuthEnv(auth: ConnectorAuth): Record<string, string> {
    const env: Record<string, string> = {};

    if (auth.type === 'aws-sigv4') {
      if (auth.awsRegion) env['AWS_REGION'] = auth.awsRegion;
      if (auth.awsAccessKeyId) env['AWS_ACCESS_KEY_ID'] = auth.awsAccessKeyId;
      if (auth.awsSecretAccessKey) env['AWS_SECRET_ACCESS_KEY'] = auth.awsSecretAccessKey;
      if (auth.awsSessionToken) env['AWS_SESSION_TOKEN'] = auth.awsSessionToken;
    }

    return env;
  }

  /**
   * Generate a unique ID for trajectory steps
   */
  protected generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Create a trajectory step with common fields
   */
  protected createStep(
    type: TrajectoryStep['type'],
    content: string,
    extra?: Partial<TrajectoryStep>
  ): TrajectoryStep {
    return {
      id: this.generateId(),
      timestamp: Date.now(),
      type,
      content,
      ...extra,
    };
  }

  /**
   * Default health check implementation
   * Subclasses can override for protocol-specific checks
   */
  async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    try {
      // Default: try a simple fetch with HEAD method
      const headers = this.buildAuthHeaders(auth);
      const response = await fetch(endpoint, {
        method: 'HEAD',
        headers,
      });
      return response.ok;
    } catch (error) {
      console.error(`[${this.type}] Health check failed:`, error);
      return false;
    }
  }

  /**
   * Log debug message with connector type prefix
   */
  protected debug(message: string, ...args: any[]): void {
    centralDebug(this.type, message, ...args);
  }

  /**
   * Log error message with connector type prefix
   */
  protected error(message: string, ...args: any[]): void {
    console.error(`[${this.type}] ${message}`, ...args);
  }

  /**
   * Build a W3C `TRACEPARENT` env var string from the active OTel span,
   * if any. Returns an env-fragment object (empty if no active span or
   * propagation is disabled for this connector).
   *
   * Used by subprocess connectors to make the child's OTel SDK adopt the
   * eval `test_case` span as parent context (Strategy A).
   */
  protected buildTraceparentEnv(): Record<string, string> {
    if (!this.traceContext?.propagateEnv) return {};
    const span = trace.getSpan(otelContext.active());
    if (!span) return {};
    const ctx = span.spanContext();
    if (!ctx.traceId || !ctx.spanId) return {};
    // Both trace-id and parent-id must be non-zero per W3C trace context spec
    // (https://www.w3.org/TR/trace-context/#trace-id). Emitting an all-zero
    // value would produce an invalid traceparent that downstream SDKs
    // typically reject silently — the agent's root span won't adopt our
    // context as parent and we'd get back to two unrelated trace trees.
    if (ctx.traceId === '0'.repeat(32) || ctx.spanId === '0'.repeat(16)) return {};
    // 00 = W3C version; flags=01 means SAMPLED so the agent's exporter forwards.
    const flags = (ctx.traceFlags ?? 1).toString(16).padStart(2, '0');
    const env: Record<string, string> = {
      TRACEPARENT: `00-${ctx.traceId}-${ctx.spanId}-${flags}`,
    };
    if (ctx.traceState) {
      const ts = ctx.traceState.serialize();
      if (ts) env.TRACESTATE = ts;
    }
    return env;
  }

  /**
   * Inject W3C `traceparent` (and `tracestate`) headers into an outgoing
   * HTTP request, if a span is active and propagation is enabled.
   *
   * Used by REST/SSE connectors so the remote agent's OTel SDK adopts the
   * eval `test_case` span as parent context (Strategy A).
   */
  protected injectTraceparentHeaders(headers: Record<string, string>): void {
    if (!this.traceContext?.propagateHeader) return;
    propagation.inject(otelContext.active(), headers);
  }
}
