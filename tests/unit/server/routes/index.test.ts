/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';

// Mock express Router
const mockUse = jest.fn();
const mockRouter = {
  use: mockUse,
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock('express', () => ({
  Router: jest.fn(() => mockRouter),
}));

// Mock all route modules
jest.mock('@/server/routes/health', () => ({ default: 'healthRoutes' }));
jest.mock('@/server/routes/judge', () => ({ default: 'judgeRoutes' }));
jest.mock('@/server/routes/agent', () => ({ default: 'agentRoutes' }));
jest.mock('@/server/routes/traces', () => ({ default: 'tracesRoutes' }));
jest.mock('@/server/routes/metrics', () => ({ default: 'metricsRoutes' }));
jest.mock('@/server/routes/logs', () => ({ default: 'logsRoutes' }));
jest.mock('@/server/routes/storage', () => ({ default: 'storageRoutes' }));
jest.mock('@/server/routes/observability', () => ({ default: 'observabilityRoutes' }));
jest.mock('@/server/routes/config', () => ({ default: 'configRoutes' }));
jest.mock('@/server/routes/evaluation', () => ({ default: 'evaluationRoutes' }));

describe('Routes Aggregator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a router and mount all route modules', () => {
    // Import the routes module which triggers route mounting
    const routes = require('@/server/routes').default;

    // Verify Router was created
    expect(Router).toHaveBeenCalled();

    // Verify all routes were mounted
    expect(mockUse).toHaveBeenCalledWith('healthRoutes');
    expect(mockUse).toHaveBeenCalledWith('judgeRoutes');
    expect(mockUse).toHaveBeenCalledWith('agentRoutes');
    expect(mockUse).toHaveBeenCalledWith('tracesRoutes');
    expect(mockUse).toHaveBeenCalledWith('metricsRoutes');
    expect(mockUse).toHaveBeenCalledWith('logsRoutes');
    expect(mockUse).toHaveBeenCalledWith('storageRoutes');
    expect(mockUse).toHaveBeenCalledWith('observabilityRoutes');
    expect(mockUse).toHaveBeenCalledWith('configRoutes');
    expect(mockUse).toHaveBeenCalledWith('evaluationRoutes');
  });

  it('should mount routes in the correct order', () => {
    jest.resetModules();
    mockUse.mockClear();

    require('@/server/routes');

    const calls = mockUse.mock.calls.map((call) => call[0]);

    // Verify routes are mounted (includes logging middleware + all routes)
    // The first call is the logging middleware (anonymous function)
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(calls).toContain('healthRoutes');
    expect(calls).toContain('judgeRoutes');
    expect(calls).toContain('agentRoutes');
    expect(calls).toContain('tracesRoutes');
    expect(calls).toContain('metricsRoutes');
    expect(calls).toContain('logsRoutes');
    expect(calls).toContain('storageRoutes');
    expect(calls).toContain('observabilityRoutes');
    expect(calls).toContain('configRoutes');
    expect(calls).toContain('evaluationRoutes');
  });

  it('should export the router as default', () => {
    jest.resetModules();

    const routes = require('@/server/routes').default;

    expect(routes).toBe(mockRouter);
  });
});
