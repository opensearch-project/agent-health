/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

describe('lib/portConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AGENT_HEALTH_PORT;
    delete process.env.AGENT_HEALTH_DEV_PORT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('resolveBackendPort', () => {
    it('should default to 4001 when AGENT_HEALTH_PORT is not set', async () => {
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(4001);
    });

    it('should use AGENT_HEALTH_PORT when set', async () => {
      process.env.AGENT_HEALTH_PORT = '5555';
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(5555);
    });

    it('should fall back to default for non-numeric AGENT_HEALTH_PORT', async () => {
      process.env.AGENT_HEALTH_PORT = 'abc';
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(4001);
    });
  });

  describe('resolveDevPort', () => {
    it('should default to 4000 when AGENT_HEALTH_DEV_PORT is not set', async () => {
      const { resolveDevPort } = await import('@/lib/portConfig');
      expect(resolveDevPort()).toBe(4000);
    });

    it('should use AGENT_HEALTH_DEV_PORT when set', async () => {
      process.env.AGENT_HEALTH_DEV_PORT = '3000';
      const { resolveDevPort } = await import('@/lib/portConfig');
      expect(resolveDevPort()).toBe(3000);
    });
  });

  describe('getBackendUrl', () => {
    it('should return default URL when AGENT_HEALTH_PORT is not set', async () => {
      const { getBackendUrl } = await import('@/lib/portConfig');
      expect(getBackendUrl()).toBe('http://localhost:4001');
    });

    it('should use AGENT_HEALTH_PORT in URL', async () => {
      process.env.AGENT_HEALTH_PORT = '8080';
      const { getBackendUrl } = await import('@/lib/portConfig');
      expect(getBackendUrl()).toBe('http://localhost:8080');
    });
  });

  describe('constants', () => {
    it('should export DEFAULT_BACKEND_PORT as 4001', async () => {
      const { DEFAULT_BACKEND_PORT } = await import('@/lib/portConfig');
      expect(DEFAULT_BACKEND_PORT).toBe(4001);
    });

    it('should export DEFAULT_DEV_PORT as 4000', async () => {
      const { DEFAULT_DEV_PORT } = await import('@/lib/portConfig');
      expect(DEFAULT_DEV_PORT).toBe(4000);
    });
  });
});
