/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Store mock function at module level so it persists across resets
const mockClientInstance = {
  search: jest.fn(),
  index: jest.fn(),
  get: jest.fn(),
};
const MockClient = jest.fn().mockImplementation(() => mockClientInstance);

// Mock the OpenSearch client
jest.mock('@opensearch-project/opensearch', () => ({
  Client: MockClient,
}));

describe('OpenSearch Client Service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear mock call history
    MockClient.mockClear();
    // Reset modules to clear the singleton state
    jest.resetModules();
    // Reset environment
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isStorageConfigured', () => {
    it('should return true when OPENSEARCH_STORAGE_ENDPOINT is set', () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://localhost:9200';

      // Re-import after setting env
      const { isStorageConfigured } = require('@/server/services/opensearchClient');

      expect(isStorageConfigured()).toBe(true);
    });

    it('should return false when OPENSEARCH_STORAGE_ENDPOINT is not set', () => {
      delete process.env.OPENSEARCH_STORAGE_ENDPOINT;

      const { isStorageConfigured } = require('@/server/services/opensearchClient');

      expect(isStorageConfigured()).toBe(false);
    });

    it('should return false when OPENSEARCH_STORAGE_ENDPOINT is empty string', () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = '';

      const { isStorageConfigured } = require('@/server/services/opensearchClient');

      expect(isStorageConfigured()).toBe(false);
    });
  });

  describe('getOpenSearchClient', () => {
    it('should return null when storage is not configured', () => {
      delete process.env.OPENSEARCH_STORAGE_ENDPOINT;

      const { getOpenSearchClient } = require('@/server/services/opensearchClient');

      const client = getOpenSearchClient();

      expect(client).toBeNull();
    });

    it('should create client with endpoint only when no credentials provided', () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://localhost:9200';
      delete process.env.OPENSEARCH_STORAGE_USERNAME;
      delete process.env.OPENSEARCH_STORAGE_PASSWORD;

      const { getOpenSearchClient } = require('@/server/services/opensearchClient');

      const client = getOpenSearchClient();

      expect(client).not.toBeNull();
      expect(MockClient).toHaveBeenCalledWith({
        node: 'https://localhost:9200',
        ssl: { rejectUnauthorized: false },
      });
    });

    it('should create client with auth when credentials are provided', () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://localhost:9200';
      process.env.OPENSEARCH_STORAGE_USERNAME = 'admin';
      process.env.OPENSEARCH_STORAGE_PASSWORD = 'admin123';

      const { getOpenSearchClient } = require('@/server/services/opensearchClient');

      const client = getOpenSearchClient();

      expect(client).not.toBeNull();
      expect(MockClient).toHaveBeenCalledWith({
        node: 'https://localhost:9200',
        ssl: { rejectUnauthorized: false },
        auth: { username: 'admin', password: 'admin123' },
      });
    });

    it('should return same client instance on subsequent calls (singleton)', () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://localhost:9200';

      const { getOpenSearchClient } = require('@/server/services/opensearchClient');

      const client1 = getOpenSearchClient();
      const client2 = getOpenSearchClient();

      expect(client1).toBe(client2);
      // Client constructor should only be called once
      expect(MockClient).toHaveBeenCalledTimes(1);
    });

    it('should return null on subsequent calls when not configured', () => {
      delete process.env.OPENSEARCH_STORAGE_ENDPOINT;

      const { getOpenSearchClient } = require('@/server/services/opensearchClient');

      const client1 = getOpenSearchClient();
      const client2 = getOpenSearchClient();

      expect(client1).toBeNull();
      expect(client2).toBeNull();
    });
  });

  describe('INDEXES', () => {
    it('should export correct index names', () => {
      const { INDEXES } = require('@/server/services/opensearchClient');

      expect(INDEXES).toEqual({
        testCases: 'evals_test_cases',
        benchmarks: 'evals_experiments',
        runs: 'evals_runs',
        analytics: 'evals_analytics',
      });
    });

    it('should have all required indexes defined', () => {
      const { INDEXES } = require('@/server/services/opensearchClient');

      expect(INDEXES.testCases).toBeDefined();
      expect(INDEXES.benchmarks).toBeDefined();
      expect(INDEXES.runs).toBeDefined();
      expect(INDEXES.analytics).toBeDefined();
    });
  });
});
