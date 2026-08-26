/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

describe('lib/portConfig', () => {
  const originalEnv = process.env;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AH_PORT;
    delete process.env.AH_DEV_PORT;
    delete process.env.AGENT_HEALTH_PORT;
    delete process.env.AGENT_HEALTH_DEV_PORT;
    process.env.AH_QUIET_DEPRECATIONS = '1';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('resolveBackendPort', () => {
    it('defaults to 4001 when AH_PORT is not set', async () => {
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(4001);
    });

    it('uses AH_PORT when set', async () => {
      process.env.AH_PORT = '5555';
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(5555);
    });

    it('falls back to default for non-numeric AH_PORT', async () => {
      process.env.AH_PORT = 'abc';
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(4001);
    });

    it('still accepts legacy AGENT_HEALTH_PORT (backward compat)', async () => {
      process.env.AGENT_HEALTH_PORT = '5555';
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(5555);
    });

    it('prefers AH_PORT over legacy AGENT_HEALTH_PORT when both set', async () => {
      process.env.AH_PORT = '5555';
      process.env.AGENT_HEALTH_PORT = '9999';
      const { resolveBackendPort } = await import('@/lib/portConfig');
      expect(resolveBackendPort()).toBe(5555);
    });
  });

  describe('resolveDevPort', () => {
    it('defaults to 4000 when AH_DEV_PORT is not set', async () => {
      const { resolveDevPort } = await import('@/lib/portConfig');
      expect(resolveDevPort()).toBe(4000);
    });

    it('uses AH_DEV_PORT when set', async () => {
      process.env.AH_DEV_PORT = '3000';
      const { resolveDevPort } = await import('@/lib/portConfig');
      expect(resolveDevPort()).toBe(3000);
    });

    it('still accepts legacy AGENT_HEALTH_DEV_PORT', async () => {
      process.env.AGENT_HEALTH_DEV_PORT = '3000';
      const { resolveDevPort } = await import('@/lib/portConfig');
      expect(resolveDevPort()).toBe(3000);
    });
  });

  describe('getBackendUrl', () => {
    it('returns default URL when AH_PORT is not set', async () => {
      const { getBackendUrl } = await import('@/lib/portConfig');
      expect(getBackendUrl()).toBe('http://localhost:4001');
    });

    it('uses AH_PORT in URL', async () => {
      process.env.AH_PORT = '8080';
      const { getBackendUrl } = await import('@/lib/portConfig');
      expect(getBackendUrl()).toBe('http://localhost:8080');
    });
  });

  describe('constants', () => {
    it('exports DEFAULT_BACKEND_PORT as 4001', async () => {
      const { DEFAULT_BACKEND_PORT } = await import('@/lib/portConfig');
      expect(DEFAULT_BACKEND_PORT).toBe(4001);
    });

    it('exports DEFAULT_DEV_PORT as 4000', async () => {
      const { DEFAULT_DEV_PORT } = await import('@/lib/portConfig');
      expect(DEFAULT_DEV_PORT).toBe(4000);
    });
  });

  describe('isBackendPortExplicit', () => {
    it('is false when neither AH_PORT nor AGENT_HEALTH_PORT is set', async () => {
      const { isBackendPortExplicit } = await import('@/lib/portConfig');
      expect(isBackendPortExplicit()).toBe(false);
    });

    it('is true when AH_PORT is set', async () => {
      process.env.AH_PORT = '4042';
      const { isBackendPortExplicit } = await import('@/lib/portConfig');
      expect(isBackendPortExplicit()).toBe(true);
    });

    it('is true when only the legacy AGENT_HEALTH_PORT is set', async () => {
      process.env.AGENT_HEALTH_PORT = '4042';
      const { isBackendPortExplicit } = await import('@/lib/portConfig');
      expect(isBackendPortExplicit()).toBe(true);
    });

    it('is false for a non-numeric AH_PORT (getBackendUrl falls back, so warn-once must fire)', async () => {
      process.env.AH_PORT = 'abc';
      const { isBackendPortExplicit } = await import('@/lib/portConfig');
      expect(isBackendPortExplicit()).toBe(false);
    });
  });
});
