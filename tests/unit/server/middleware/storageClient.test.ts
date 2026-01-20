/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for storage client middleware
 *
 * Tests the middleware functions in isolation:
 * - storageClientMiddleware
 * - isStorageAvailable
 * - requireStorageClient
 * - getStorageClient
 */

import { Request, Response, NextFunction } from 'express';

// Mock the dataSourceConfig before importing storageClient
const mockResolveStorageConfig = jest.fn();
jest.mock('@/server/middleware/dataSourceConfig', () => ({
  resolveStorageConfig: mockResolveStorageConfig,
}));

// Mock the OpenSearch client
const mockClientClose = jest.fn();
jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    close: mockClientClose,
  })),
}));

// Import after mocks are set up
import {
  storageClientMiddleware,
  isStorageAvailable,
  requireStorageClient,
  getStorageClient,
  INDEXES,
} from '@/server/middleware/storageClient';

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Helper to create mock request/response
function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    storageClient: null,
    storageConfig: null,
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response {
  return {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function createMockNext(): NextFunction {
  return jest.fn();
}

describe('storageClientMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should attach storageClient when config is resolved', () => {
    const mockConfig = {
      endpoint: 'https://localhost:9200',
      username: 'admin',
      password: 'admin',
    };
    mockResolveStorageConfig.mockReturnValue(mockConfig);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    expect(req.storageClient).toBeDefined();
    expect(req.storageClient).not.toBeNull();
    expect(req.storageConfig).toEqual(mockConfig);
    expect(next).toHaveBeenCalled();
  });

  it('should set storageClient to null when config is not resolved', () => {
    mockResolveStorageConfig.mockReturnValue(null);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    expect(req.storageClient).toBeNull();
    expect(req.storageConfig).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it('should always call next', () => {
    mockResolveStorageConfig.mockReturnValue(null);

    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('should use cached client for same config', () => {
    const mockConfig = {
      endpoint: 'https://localhost:9200',
      username: 'admin',
      password: 'cached-test',
    };
    mockResolveStorageConfig.mockReturnValue(mockConfig);

    const req1 = createMockReq();
    const req2 = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    storageClientMiddleware(req1, res, next);
    storageClientMiddleware(req2, res, next);

    // Same client instance should be reused
    expect(req1.storageClient).toBe(req2.storageClient);
  });

  it('should create new client for different config', () => {
    const mockConfig1 = {
      endpoint: 'https://localhost:9200',
      username: 'admin1',
      password: 'password1',
    };
    const mockConfig2 = {
      endpoint: 'https://localhost:9200',
      username: 'admin2',
      password: 'password2',
    };

    const req1 = createMockReq();
    const req2 = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    mockResolveStorageConfig.mockReturnValue(mockConfig1);
    storageClientMiddleware(req1, res, next);

    mockResolveStorageConfig.mockReturnValue(mockConfig2);
    storageClientMiddleware(req2, res, next);

    // Different client instances for different configs
    expect(req1.storageClient).not.toBe(req2.storageClient);
  });
});

describe('isStorageAvailable', () => {
  it('should return true when storageClient is present', () => {
    const req = createMockReq({
      storageClient: {} as any,
    });

    expect(isStorageAvailable(req)).toBe(true);
  });

  it('should return false when storageClient is null', () => {
    const req = createMockReq({
      storageClient: null,
    });

    expect(isStorageAvailable(req)).toBe(false);
  });
});

describe('requireStorageClient', () => {
  it('should return client when present', () => {
    const mockClient = { search: jest.fn() };
    const req = createMockReq({
      storageClient: mockClient as any,
    });

    const result = requireStorageClient(req);
    expect(result).toBe(mockClient);
  });

  it('should throw error when client is null', () => {
    const req = createMockReq({
      storageClient: null,
    });

    expect(() => requireStorageClient(req)).toThrow('Storage not configured');
  });
});

describe('getStorageClient', () => {
  it('should return client when present', () => {
    const mockClient = { search: jest.fn() };
    const req = createMockReq({
      storageClient: mockClient as any,
    });

    const result = getStorageClient(req);
    expect(result).toBe(mockClient);
  });

  it('should return null when client is null', () => {
    const req = createMockReq({
      storageClient: null,
    });

    const result = getStorageClient(req);
    expect(result).toBeNull();
  });
});

describe('INDEXES', () => {
  it('should export correct index names', () => {
    expect(INDEXES.testCases).toBe('evals_test_cases');
    expect(INDEXES.benchmarks).toBe('evals_experiments');
    expect(INDEXES.runs).toBe('evals_runs');
    expect(INDEXES.analytics).toBe('evals_analytics');
  });
});
