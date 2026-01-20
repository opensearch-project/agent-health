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
jest.mock('@/server/routes/storage/admin', () => ({ default: 'adminRoutes' }));
jest.mock('@/server/routes/storage/testCases', () => ({ default: 'testCasesRoutes' }));
jest.mock('@/server/routes/storage/benchmarks', () => ({ default: 'benchmarksRoutes' }));
jest.mock('@/server/routes/storage/runs', () => ({ default: 'runsRoutes' }));
jest.mock('@/server/routes/storage/analytics', () => ({ default: 'analyticsRoutes' }));

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
    ]);
  });

  it('should export the router as default', () => {
    jest.resetModules();

    const storageRoutes = require('@/server/routes/storage').default;

    expect(storageRoutes).toBe(mockRouter);
  });
});
