/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for server/app.ts - createApp()
 *
 * Verifies that createApp() loads config internally before setting up routes.
 * This prevents the module cache isolation bug where CLI-spawned servers
 * return default config because loadConfig() was called in a different bundle.
 */

// Mock loadConfig to track whether it's called
const mockLoadConfig = jest.fn().mockResolvedValue({
  agents: [],
  models: {},
  server: { port: 4001 },
  connectors: [],
  testCases: [],
  reporters: [['console']],
  judge: { provider: 'bedrock', model: 'claude-sonnet-4' },
});

jest.mock('@/lib/config/index', () => ({
  loadConfig: mockLoadConfig,
  loadConfigSync: jest.fn().mockReturnValue({
    agents: [],
    models: {},
    server: { port: 4001 },
    connectors: [],
    testCases: [],
    reporters: [['console']],
    judge: { provider: 'bedrock', model: 'claude-sonnet-4' },
  }),
}));

// Mock Express to avoid CJS/ESM interop issues
const mockApp = {
  get: jest.fn().mockReturnThis(),
  post: jest.fn().mockReturnThis(),
  put: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  use: jest.fn().mockReturnThis(),
  listen: jest.fn(),
  set: jest.fn(),
};

jest.mock('express', () => {
  const express = jest.fn(() => mockApp);
  return { __esModule: true, default: express };
});

// Mock modules that use import.meta.url or have heavy dependencies
const mockRouter = jest.fn();
jest.mock('@/server/routes/index', () => ({
  __esModule: true,
  default: mockRouter,
}));

const mockSetupMiddleware = jest.fn();
const mockSetupSpaFallback = jest.fn();
jest.mock('@/server/middleware/index', () => ({
  setupMiddleware: mockSetupMiddleware,
  setupSpaFallback: mockSetupSpaFallback,
}));

jest.mock('@/services/connectors/server', () => ({}));

import { createApp } from '@/server/app';

describe('createApp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return a promise (async function)', () => {
    const result = createApp();
    expect(result).toBeInstanceOf(Promise);
  });

  it('should call loadConfig before returning the app', async () => {
    await createApp();

    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  it('should call loadConfig before middleware and routes are set up', async () => {
    const callOrder: string[] = [];

    mockLoadConfig.mockImplementation(async () => {
      callOrder.push('loadConfig');
      return {
        agents: [],
        models: {},
        server: { port: 4001 },
        connectors: [],
        testCases: [],
        reporters: [['console']],
        judge: { provider: 'bedrock', model: 'claude-sonnet-4' },
      };
    });

    mockSetupMiddleware.mockImplementation(() => {
      callOrder.push('setupMiddleware');
    });

    await createApp();

    expect(callOrder[0]).toBe('loadConfig');
    expect(callOrder[1]).toBe('setupMiddleware');
  });

  it('should propagate config loading errors', async () => {
    mockLoadConfig.mockRejectedValueOnce(new Error('Config load failed'));

    await expect(createApp()).rejects.toThrow('Config load failed');
  });

  it('should set up middleware on the app', async () => {
    await createApp();

    expect(mockSetupMiddleware).toHaveBeenCalledTimes(1);
    expect(mockSetupMiddleware).toHaveBeenCalledWith(mockApp);
  });

  it('should mount routes on the app', async () => {
    await createApp();

    expect(mockApp.use).toHaveBeenCalledWith(mockRouter);
  });

  it('should register SPA fallback after routes', async () => {
    const callOrder: string[] = [];

    mockApp.use.mockImplementation((...args: unknown[]) => {
      if (args[0] === mockRouter) {
        callOrder.push('routes');
      }
      return mockApp;
    });

    mockSetupSpaFallback.mockImplementation(() => {
      callOrder.push('spaFallback');
    });

    await createApp();

    expect(mockSetupSpaFallback).toHaveBeenCalledTimes(1);
    expect(mockSetupSpaFallback).toHaveBeenCalledWith(mockApp);
    expect(callOrder.indexOf('routes')).toBeLessThan(callOrder.indexOf('spaFallback'));
  });
});
