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

// Mock all storage route modules
jest.mock('@/server/routes/storage/admin', () => ({ __esModule: true, default: 'adminRoutes' }));
jest.mock('@/server/routes/storage/testCases', () => ({ __esModule: true, default: 'testCasesRoutes' }));
jest.mock('@/server/routes/storage/benchmarks', () => ({ __esModule: true, default: 'benchmarksRoutes' }));
jest.mock('@/server/routes/storage/runs', () => ({ __esModule: true, default: 'runsRoutes' }));
jest.mock('@/server/routes/storage/analytics', () => ({ __esModule: true, default: 'analyticsRoutes' }));
jest.mock('@/server/routes/storage/reports', () => ({ __esModule: true, default: 'reportsRoutes' }));
jest.mock('@/server/routes/storage/evaluators', () => ({ __esModule: true, default: 'evaluatorsRoutes' }));

describe('Storage Routes Aggregator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a router and mount all storage route modules', () => {
    // Import the storage routes module which triggers route mounting
    const storageRoutes = require('@/server/routes/storage').default;

    // Verify Router was created
    expect(Router).toHaveBeenCalled();

    // Verify all routes were mounted
    expect(mockUse).toHaveBeenCalledWith('adminRoutes');
    expect(mockUse).toHaveBeenCalledWith('testCasesRoutes');
    expect(mockUse).toHaveBeenCalledWith('benchmarksRoutes');
    expect(mockUse).toHaveBeenCalledWith('runsRoutes');
    expect(mockUse).toHaveBeenCalledWith('analyticsRoutes');
    expect(mockUse).toHaveBeenCalledWith('reportsRoutes');
    expect(mockUse).toHaveBeenCalledWith('evaluatorsRoutes');
  });

  it('should mount routes in the correct order', () => {
    jest.resetModules();
    mockUse.mockClear();

    require('@/server/routes/storage');

    const calls = mockUse.mock.calls.map((call) => call[0]);

    expect(calls).toEqual([
      'adminRoutes',
      'testCasesRoutes',
      'benchmarksRoutes',
      'runsRoutes',
      'analyticsRoutes',
      'reportsRoutes',
      'evaluatorsRoutes',
    ]);
  });

  it('should export the router as default', () => {
    jest.resetModules();

    const storageRoutes = require('@/server/routes/storage').default;

    expect(storageRoutes).toBe(mockRouter);
  });
});
