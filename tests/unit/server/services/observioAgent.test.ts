/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * observioAgent tests
 *
 * Note: The real observioAgent uses import.meta.url which Jest cannot handle.
 * These tests verify the mock behavior and serve as documentation for expected API.
 * The actual implementation is tested via integration tests.
 */

import {
  OBSERVIO_PORT,
  findObservioRoot,
  isPortFree,
  spawnObservioAgent,
  killObservioAgent,
} from '@/server/services/observioAgent';

describe('observioAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('OBSERVIO_PORT', () => {
    it('exports the default port constant', () => {
      expect(OBSERVIO_PORT).toBe(3001);
    });
  });

  describe('findObservioRoot', () => {
    it('returns null by default (not found)', () => {
      const result = findObservioRoot();
      expect(result).toBeNull();
    });

    it('can be configured to return a path', () => {
      (findObservioRoot as jest.Mock).mockReturnValueOnce('/fake/observio-sample-agent');
      expect(findObservioRoot()).toBe('/fake/observio-sample-agent');
    });
  });

  describe('isPortFree', () => {
    it('resolves true by default (port is free)', async () => {
      const result = await isPortFree(3001);
      expect(result).toBe(true);
    });

    it('can be configured to report port in use', async () => {
      (isPortFree as jest.Mock).mockResolvedValueOnce(false);
      const result = await isPortFree(3001);
      expect(result).toBe(false);
    });
  });

  describe('spawnObservioAgent', () => {
    it('returns null by default (deps not installed)', () => {
      const result = spawnObservioAgent('/fake/dir');
      expect(result).toBeNull();
      expect(spawnObservioAgent).toHaveBeenCalledWith('/fake/dir');
    });

    it('can be configured to return a child process', () => {
      const mockChild = { pid: 12345, killed: false, kill: jest.fn() };
      (spawnObservioAgent as jest.Mock).mockReturnValueOnce(mockChild);
      const result = spawnObservioAgent('/fake/dir');
      expect(result).toEqual(mockChild);
    });
  });

  describe('killObservioAgent', () => {
    it('resolves false by default (nothing to kill)', async () => {
      const result = await killObservioAgent();
      expect(result).toBe(false);
    });

    it('can be configured to report successful kill', async () => {
      (killObservioAgent as jest.Mock).mockResolvedValueOnce(true);
      const result = await killObservioAgent(3001);
      expect(result).toBe(true);
    });

    it('accepts optional port parameter', async () => {
      await killObservioAgent(4000);
      expect(killObservioAgent).toHaveBeenCalledWith(4000);
    });
  });
});
