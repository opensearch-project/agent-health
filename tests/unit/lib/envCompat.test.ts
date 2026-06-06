/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readEnv,
  isLegacyEnvSet,
  warnDeprecated,
  _resetDeprecationCacheForTests,
} from '@/lib/envCompat';

describe('lib/envCompat', () => {
  const originalEnv = process.env;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AH_FOO;
    delete process.env.AGENT_HEALTH_FOO;
    delete process.env.AH_QUIET_DEPRECATIONS;
    delete process.env.AGENT_HEALTH_QUIET_DEPRECATIONS;
    _resetDeprecationCacheForTests();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('readEnv', () => {
    it('returns undefined when neither name is set', () => {
      expect(readEnv('AH_FOO', 'AGENT_HEALTH_FOO')).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns the new name without warning when only new is set', () => {
      process.env.AH_FOO = 'new-value';
      expect(readEnv('AH_FOO', 'AGENT_HEALTH_FOO')).toBe('new-value');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns the legacy name with a deprecation warning when only legacy is set', () => {
      process.env.AGENT_HEALTH_FOO = 'legacy-value';
      expect(readEnv('AH_FOO', 'AGENT_HEALTH_FOO')).toBe('legacy-value');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/AGENT_HEALTH_FOO/);
      expect(warnSpy.mock.calls[0][0]).toMatch(/AH_FOO/);
    });

    it('prefers the new name when both are set, no warning', () => {
      process.env.AH_FOO = 'new-value';
      process.env.AGENT_HEALTH_FOO = 'legacy-value';
      expect(readEnv('AH_FOO', 'AGENT_HEALTH_FOO')).toBe('new-value');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns empty-string values from the new name (does not fall through)', () => {
      process.env.AH_FOO = '';
      process.env.AGENT_HEALTH_FOO = 'legacy-value';
      expect(readEnv('AH_FOO', 'AGENT_HEALTH_FOO')).toBe('');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns only once per legacy name across multiple reads', () => {
      process.env.AGENT_HEALTH_FOO = 'legacy-value';
      readEnv('AH_FOO', 'AGENT_HEALTH_FOO');
      readEnv('AH_FOO', 'AGENT_HEALTH_FOO');
      readEnv('AH_FOO', 'AGENT_HEALTH_FOO');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when AH_QUIET_DEPRECATIONS=1', () => {
      process.env.AGENT_HEALTH_FOO = 'legacy-value';
      process.env.AH_QUIET_DEPRECATIONS = '1';
      readEnv('AH_FOO', 'AGENT_HEALTH_FOO');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when legacy AGENT_HEALTH_QUIET_DEPRECATIONS=1', () => {
      process.env.AGENT_HEALTH_FOO = 'legacy-value';
      process.env.AGENT_HEALTH_QUIET_DEPRECATIONS = '1';
      readEnv('AH_FOO', 'AGENT_HEALTH_FOO');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('isLegacyEnvSet', () => {
    it('returns true when the legacy var is set', () => {
      process.env.AGENT_HEALTH_FOO = 'x';
      expect(isLegacyEnvSet('AGENT_HEALTH_FOO')).toBe(true);
    });

    it('returns false when the legacy var is unset', () => {
      expect(isLegacyEnvSet('AGENT_HEALTH_FOO')).toBe(false);
    });

    it('returns true even when the value is empty', () => {
      process.env.AGENT_HEALTH_FOO = '';
      expect(isLegacyEnvSet('AGENT_HEALTH_FOO')).toBe(true);
    });
  });

  describe('warnDeprecated', () => {
    it('emits a single warning per legacy name', () => {
      warnDeprecated('AGENT_HEALTH_BAR', 'AH_BAR');
      warnDeprecated('AGENT_HEALTH_BAR', 'AH_BAR');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('emits separate warnings for distinct legacy names', () => {
      warnDeprecated('AGENT_HEALTH_BAR', 'AH_BAR');
      warnDeprecated('AGENT_HEALTH_BAZ', 'AH_BAZ');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});
