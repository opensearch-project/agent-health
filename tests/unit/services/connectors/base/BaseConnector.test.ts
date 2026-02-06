/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseConnector } from '@/services/connectors/base/BaseConnector';
import type {
  ConnectorAuth,
  ConnectorProtocol,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/services/connectors/types';
import type { TrajectoryStep } from '@/types';

// Concrete implementation for testing abstract BaseConnector
class TestConnector extends BaseConnector {
  readonly type: ConnectorProtocol = 'mock';
  readonly name = 'Test Connector';
  readonly supportsStreaming = true;

  buildPayload(request: ConnectorRequest): any {
    return { prompt: request.testCase.initialPrompt };
  }

  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    return {
      trajectory: [],
      runId: 'test-run',
    };
  }

  parseResponse(rawResponse: any): TrajectoryStep[] {
    return [];
  }

  // Expose protected methods for testing
  public testBuildAuthHeaders(auth: ConnectorAuth): Record<string, string> {
    return this.buildAuthHeaders(auth);
  }

  public testBuildAuthEnv(auth: ConnectorAuth): Record<string, string> {
    return this.buildAuthEnv(auth);
  }

  public testGenerateId(): string {
    return this.generateId();
  }

  public testCreateStep(
    type: TrajectoryStep['type'],
    content: string,
    extra?: Partial<TrajectoryStep>
  ): TrajectoryStep {
    return this.createStep(type, content, extra);
  }
}

describe('BaseConnector', () => {
  let connector: TestConnector;

  beforeEach(() => {
    connector = new TestConnector();
  });

  describe('buildAuthHeaders', () => {
    it('should return empty headers for none auth', () => {
      const headers = connector.testBuildAuthHeaders({ type: 'none' });
      expect(headers).toEqual({});
    });

    it('should build basic auth header', () => {
      const headers = connector.testBuildAuthHeaders({
        type: 'basic',
        username: 'user',
        password: 'pass',
      });

      expect(headers['Authorization']).toBe('Basic dXNlcjpwYXNz');
    });

    it('should skip basic auth if username/password missing', () => {
      const headers = connector.testBuildAuthHeaders({ type: 'basic' });
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should build bearer token header', () => {
      const headers = connector.testBuildAuthHeaders({
        type: 'bearer',
        token: 'my-token',
      });

      expect(headers['Authorization']).toBe('Bearer my-token');
    });

    it('should skip bearer auth if token missing', () => {
      const headers = connector.testBuildAuthHeaders({ type: 'bearer' });
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should build api-key headers', () => {
      const headers = connector.testBuildAuthHeaders({
        type: 'api-key',
        token: 'my-api-key',
      });

      expect(headers['X-API-Key']).toBe('my-api-key');
      expect(headers['x-api-key']).toBe('my-api-key');
    });

    it('should apply custom headers', () => {
      const headers = connector.testBuildAuthHeaders({
        type: 'none',
        headers: {
          'X-Custom': 'value',
          'Content-Type': 'application/json',
        },
      });

      expect(headers['X-Custom']).toBe('value');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should allow custom headers to override auth headers', () => {
      const headers = connector.testBuildAuthHeaders({
        type: 'bearer',
        token: 'original-token',
        headers: {
          'Authorization': 'Custom override',
        },
      });

      expect(headers['Authorization']).toBe('Custom override');
    });
  });

  describe('buildAuthEnv', () => {
    it('should return empty env for non-aws auth', () => {
      const env = connector.testBuildAuthEnv({ type: 'none' });
      expect(env).toEqual({});
    });

    it('should build AWS SigV4 environment variables', () => {
      const env = connector.testBuildAuthEnv({
        type: 'aws-sigv4',
        awsRegion: 'us-west-2',
        awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        awsSessionToken: 'session-token',
      });

      expect(env['AWS_REGION']).toBe('us-west-2');
      expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAIOSFODNN7EXAMPLE');
      expect(env['AWS_SECRET_ACCESS_KEY']).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(env['AWS_SESSION_TOKEN']).toBe('session-token');
    });

    it('should only include provided AWS credentials', () => {
      const env = connector.testBuildAuthEnv({
        type: 'aws-sigv4',
        awsRegion: 'us-east-1',
      });

      expect(env['AWS_REGION']).toBe('us-east-1');
      expect(env['AWS_ACCESS_KEY_ID']).toBeUndefined();
      expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
      expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = connector.testGenerateId();
      const id2 = connector.testGenerateId();

      expect(id1).not.toBe(id2);
    });

    it('should generate IDs with expected format', () => {
      const id = connector.testGenerateId();

      // Format: timestamp-randomString
      expect(id).toMatch(/^\d+-[a-z0-9]+$/);
    });
  });

  describe('createStep', () => {
    it('should create a trajectory step with required fields', () => {
      const step = connector.testCreateStep('thinking', 'Test content');

      expect(step.id).toBeDefined();
      expect(step.timestamp).toBeDefined();
      expect(step.type).toBe('thinking');
      expect(step.content).toBe('Test content');
    });

    it('should merge extra fields', () => {
      const step = connector.testCreateStep('action', 'Tool call', {
        toolName: 'test_tool',
        toolArgs: { arg1: 'value' },
      });

      expect(step.type).toBe('action');
      expect(step.toolName).toBe('test_tool');
      expect(step.toolArgs).toEqual({ arg1: 'value' });
    });

    it('should allow overriding default fields', () => {
      const customId = 'custom-id';
      const customTimestamp = 1234567890;

      const step = connector.testCreateStep('response', 'Response', {
        id: customId,
        timestamp: customTimestamp,
      });

      expect(step.id).toBe(customId);
      expect(step.timestamp).toBe(customTimestamp);
    });
  });

  describe('healthCheck', () => {
    beforeEach(() => {
      jest.spyOn(global, 'fetch').mockImplementation();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return true when endpoint is reachable', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

      const result = await connector.healthCheck('http://localhost:8080', { type: 'none' });

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080', {
        method: 'HEAD',
        headers: {},
      });
    });

    it('should return false when endpoint returns error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false });

      const result = await connector.healthCheck('http://localhost:8080', { type: 'none' });

      expect(result).toBe(false);
    });

    it('should return false when fetch throws', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const result = await connector.healthCheck('http://localhost:8080', { type: 'none' });

      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should include auth headers in health check', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

      await connector.healthCheck('http://localhost:8080', {
        type: 'bearer',
        token: 'test-token',
      });

      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080', {
        method: 'HEAD',
        headers: { 'Authorization': 'Bearer test-token' },
      });
    });
  });
});
