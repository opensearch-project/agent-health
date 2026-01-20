/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

describe('server/config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('PORT', () => {
    it('should default to 4001', async () => {
      delete process.env.VITE_BACKEND_PORT;
      const config = await import('@/server/config');
      expect(config.PORT).toBe(4001);
    });

    it('should use VITE_BACKEND_PORT when set', async () => {
      process.env.VITE_BACKEND_PORT = '8080';
      const config = await import('@/server/config');
      expect(config.PORT).toBe(8080);
    });
  });

  describe('AWS_REGION', () => {
    it('should default to us-west-2', async () => {
      delete process.env.AWS_REGION;
      const config = await import('@/server/config');
      expect(config.AWS_REGION).toBe('us-west-2');
    });

    it('should use AWS_REGION when set', async () => {
      process.env.AWS_REGION = 'eu-west-1';
      const config = await import('@/server/config');
      expect(config.AWS_REGION).toBe('eu-west-1');
    });
  });

  describe('BEDROCK_MODEL_ID', () => {
    it('should have a default model ID', async () => {
      delete process.env.BEDROCK_MODEL_ID;
      const config = await import('@/server/config');
      expect(config.BEDROCK_MODEL_ID).toContain('anthropic');
    });

    it('should use BEDROCK_MODEL_ID when set', async () => {
      process.env.BEDROCK_MODEL_ID = 'custom-model-id';
      const config = await import('@/server/config');
      expect(config.BEDROCK_MODEL_ID).toBe('custom-model-id');
    });
  });

  describe('OPENSEARCH_LOGS', () => {
    it('should have default index patterns', async () => {
      const config = await import('@/server/config');
      expect(config.OPENSEARCH_LOGS.index).toBe('ml-commons-logs-*');
      expect(config.OPENSEARCH_LOGS.tracesIndex).toBe('otel-v1-apm-span-*');
    });

    it('should read environment variables', async () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://logs.example.com';
      process.env.OPENSEARCH_LOGS_USERNAME = 'loguser';
      process.env.OPENSEARCH_LOGS_PASSWORD = 'logpass';
      process.env.OPENSEARCH_LOGS_INDEX = 'custom-logs-*';

      const config = await import('@/server/config');
      expect(config.OPENSEARCH_LOGS.endpoint).toBe('https://logs.example.com');
      expect(config.OPENSEARCH_LOGS.username).toBe('loguser');
      expect(config.OPENSEARCH_LOGS.password).toBe('logpass');
      expect(config.OPENSEARCH_LOGS.index).toBe('custom-logs-*');
    });
  });

  describe('STORAGE_CONFIG', () => {
    it('should have default index names', async () => {
      const config = await import('@/server/config');
      expect(config.STORAGE_CONFIG.indexes.testCases).toBe('evals_test_cases');
      expect(config.STORAGE_CONFIG.indexes.benchmarks).toBe('evals_experiments');
      expect(config.STORAGE_CONFIG.indexes.runs).toBe('evals_runs');
      expect(config.STORAGE_CONFIG.indexes.analytics).toBe('evals_analytics');
    });

    it('should read storage environment variables', async () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://storage.example.com';
      process.env.OPENSEARCH_STORAGE_USERNAME = 'storeuser';
      process.env.OPENSEARCH_STORAGE_PASSWORD = 'storepass';

      const config = await import('@/server/config');
      expect(config.STORAGE_CONFIG.endpoint).toBe('https://storage.example.com');
      expect(config.STORAGE_CONFIG.username).toBe('storeuser');
      expect(config.STORAGE_CONFIG.password).toBe('storepass');
    });
  });

  describe('isStorageConfigured', () => {
    it('should return false when no storage config', async () => {
      delete process.env.OPENSEARCH_STORAGE_ENDPOINT;
      delete process.env.OPENSEARCH_STORAGE_USERNAME;
      delete process.env.OPENSEARCH_STORAGE_PASSWORD;

      const config = await import('@/server/config');
      expect(config.isStorageConfigured()).toBe(false);
    });

    it('should return true when all storage config present', async () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://storage.example.com';
      process.env.OPENSEARCH_STORAGE_USERNAME = 'user';
      process.env.OPENSEARCH_STORAGE_PASSWORD = 'pass';

      const config = await import('@/server/config');
      expect(config.isStorageConfigured()).toBe(true);
    });

    it('should return false when partial storage config', async () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://storage.example.com';
      delete process.env.OPENSEARCH_STORAGE_USERNAME;
      delete process.env.OPENSEARCH_STORAGE_PASSWORD;

      const config = await import('@/server/config');
      expect(config.isStorageConfigured()).toBe(false);
    });
  });

  describe('Environment mode', () => {
    it('should default to development', async () => {
      delete process.env.NODE_ENV;
      const config = await import('@/server/config');
      expect(config.NODE_ENV).toBe('development');
      expect(config.IS_DEVELOPMENT).toBe(true);
      expect(config.IS_PRODUCTION).toBe(false);
    });

    it('should detect production mode', async () => {
      process.env.NODE_ENV = 'production';
      const config = await import('@/server/config');
      expect(config.NODE_ENV).toBe('production');
      expect(config.IS_PRODUCTION).toBe(true);
      expect(config.IS_DEVELOPMENT).toBe(false);
    });
  });

  describe('default export', () => {
    it('should export all config as default', async () => {
      const { default: config } = await import('@/server/config');
      expect(config).toHaveProperty('PORT');
      expect(config).toHaveProperty('AWS_REGION');
      expect(config).toHaveProperty('BEDROCK_MODEL_ID');
      expect(config).toHaveProperty('OPENSEARCH_LOGS');
      expect(config).toHaveProperty('STORAGE_CONFIG');
      expect(config).toHaveProperty('isStorageConfigured');
      expect(config).toHaveProperty('NODE_ENV');
      expect(config).toHaveProperty('IS_PRODUCTION');
      expect(config).toHaveProperty('IS_DEVELOPMENT');
    });
  });
});
