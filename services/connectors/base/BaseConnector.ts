/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';
import type {
  AgentConnector,
  ConnectorAuth,
  ConnectorProtocol,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/services/connectors/types';

/**
 * Abstract base class for connectors
 * Provides common functionality like auth header building and error handling
 */
export abstract class BaseConnector implements AgentConnector {
  abstract readonly type: ConnectorProtocol;
  abstract readonly name: string;
  abstract readonly supportsStreaming: boolean;

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
    console.log(`[${this.type}] ${message}`, ...args);
  }

  /**
   * Log error message with connector type prefix
   */
  protected error(message: string, ...args: any[]): void {
    console.error(`[${this.type}] ${message}`, ...args);
  }
}
