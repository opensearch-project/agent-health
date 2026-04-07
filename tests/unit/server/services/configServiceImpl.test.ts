/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the REAL configService implementation.
 *
 * These tests import the actual module via a relative path to bypass the
 * moduleNameMapper (which redirects `@/server/services/configService` to the
 * jest mock).  `fs` is mocked so nothing touches the real disk.
 *
 * Covers the Bug-2 fix (credential preservation via `??`) and the Bug-3 fix
 * (returning username + hasPassword in getConfigStatus).
 */

jest.mock('fs');

import fs from 'fs';

// Silence noise from the debug module's init block
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Import the REAL module using a relative path that is not caught by moduleNameMapper.
// The mapper only catches: @/server/services/configService, ../services/configService.js,
// ../../services/configService.js  — this 4-level relative path is not in the mapper.
import {
  saveStorageConfig,
  saveObservabilityConfig,
  getConfigStatus,
} from '../../../../server/services/configService';

const mockedFs = fs as jest.Mocked<typeof fs>;

// Helper to capture what gets written to disk and parse it back to an object
function captureWrite(): () => Record<string, unknown> {
  let written: string | undefined;
  mockedFs.writeFileSync.mockImplementation((_path, data) => {
    written = data as string;
  });
  return () => {
    if (!written) throw new Error('writeFileSync was not called');
    return JSON.parse(written.trimEnd());
  };
}

// Helper to set what readFileSync returns
function setStoredConfig(config: Record<string, unknown>): void {
  mockedFs.existsSync.mockReturnValue(true);
  mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
}

describe('configService (real implementation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: config file does not exist (clean slate)
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockReturnValue('{}');
    mockedFs.writeFileSync.mockImplementation(() => {});
  });

  // ==========================================================================
  // readConfigFromDisk — clobber prevention
  // ==========================================================================

  describe('clobber prevention', () => {
    it('saveStorageConfig throws when existing config file is unreadable (corrupt JSON)', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('NOT VALID JSON {{{');

      expect(() => saveStorageConfig({ endpoint: 'https://new.com' }))
        .toThrow('existing config file is unreadable or corrupt');
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('saveObservabilityConfig throws when existing config file is unreadable (corrupt JSON)', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('NOT VALID JSON {{{');

      expect(() => saveObservabilityConfig({ endpoint: 'https://obs.com' }))
        .toThrow('existing config file is unreadable or corrupt');
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('saveStorageConfig throws when config file contains a JSON array', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('["not", "an", "object"]');

      expect(() => saveStorageConfig({ endpoint: 'https://new.com' }))
        .toThrow('existing config file is unreadable or corrupt');
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('saveStorageConfig succeeds when config file does not exist (new file)', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const getWritten = captureWrite();

      saveStorageConfig({ endpoint: 'https://new.com' });

      const result = getWritten();
      expect((result.storage as any).endpoint).toBe('https://new.com');
    });
  });

  // ==========================================================================
  // saveStorageConfig — Bug-2: credential preservation
  // ==========================================================================

  describe('saveStorageConfig', () => {
    it('writes endpoint, username, and password when all are provided', () => {
      setStoredConfig({});
      const getWritten = captureWrite();

      saveStorageConfig({ endpoint: 'https://new.com', username: 'alice', password: 'secret' });

      const result = getWritten();
      expect(result.storage).toEqual({
        endpoint: 'https://new.com',
        username: 'alice',
        password: 'secret',
      });
    });

    it('preserves stored username and password when new values are undefined', () => {
      setStoredConfig({
        storage: { endpoint: 'https://old.com', username: 'stored-user', password: 'stored-pass' },
      });
      const getWritten = captureWrite();

      // Simulate what the frontend sends after loading settings with blank password field:
      // username is undefined, password is undefined
      saveStorageConfig({ endpoint: 'https://new.com', username: undefined, password: undefined });

      const result = getWritten();
      expect((result.storage as any).username).toBe('stored-user');
      expect((result.storage as any).password).toBe('stored-pass');
      expect((result.storage as any).endpoint).toBe('https://new.com');
    });

    it('overwrites stored username when a new username is provided', () => {
      setStoredConfig({
        storage: { endpoint: 'https://old.com', username: 'old-user', password: 'old-pass' },
      });
      const getWritten = captureWrite();

      saveStorageConfig({ endpoint: 'https://new.com', username: 'new-user', password: undefined });

      const result = getWritten();
      expect((result.storage as any).username).toBe('new-user');
      expect((result.storage as any).password).toBe('old-pass'); // preserved
    });

    it('overwrites stored password when a new password is provided', () => {
      setStoredConfig({
        storage: { endpoint: 'https://old.com', username: 'user', password: 'old-pass' },
      });
      const getWritten = captureWrite();

      saveStorageConfig({ endpoint: 'https://new.com', username: undefined, password: 'new-pass' });

      const result = getWritten();
      expect((result.storage as any).password).toBe('new-pass');
      expect((result.storage as any).username).toBe('user'); // preserved
    });

    it('does not write username or password keys when both are absent and nothing was stored', () => {
      setStoredConfig({});
      const getWritten = captureWrite();

      saveStorageConfig({ endpoint: 'https://new.com', username: undefined, password: undefined });

      const result = getWritten();
      expect(result.storage).not.toHaveProperty('username');
      expect(result.storage).not.toHaveProperty('password');
    });

    it('preserves other top-level config keys (e.g. customAgents) when saving', () => {
      setStoredConfig({
        customAgents: [{ key: 'my-agent', name: 'My Agent', endpoint: 'http://agent' }],
      });
      const getWritten = captureWrite();

      saveStorageConfig({ endpoint: 'https://store.com' });

      const result = getWritten();
      expect(result.customAgents).toBeDefined();
    });

    it('writes tlsSkipVerify when provided', () => {
      setStoredConfig({});
      const getWritten = captureWrite();

      saveStorageConfig({ endpoint: 'https://new.com', tlsSkipVerify: true });

      const result = getWritten();
      expect((result.storage as any).tlsSkipVerify).toBe(true);
    });
  });

  // ==========================================================================
  // saveObservabilityConfig — Bug-2: credential preservation
  // ==========================================================================

  describe('saveObservabilityConfig', () => {
    it('writes endpoint, username, and password when all are provided', () => {
      setStoredConfig({});
      const getWritten = captureWrite();

      saveObservabilityConfig({ endpoint: 'https://obs.com', username: 'bob', password: 'pw' });

      const result = getWritten();
      expect(result.observability).toEqual({
        endpoint: 'https://obs.com',
        username: 'bob',
        password: 'pw',
      });
    });

    it('preserves stored username and password when new values are undefined', () => {
      setStoredConfig({
        observability: {
          endpoint: 'https://old-obs.com',
          username: 'obs-user',
          password: 'obs-pass',
        },
      });
      const getWritten = captureWrite();

      saveObservabilityConfig({ endpoint: 'https://new-obs.com', username: undefined, password: undefined });

      const result = getWritten();
      expect((result.observability as any).username).toBe('obs-user');
      expect((result.observability as any).password).toBe('obs-pass');
      expect((result.observability as any).endpoint).toBe('https://new-obs.com');
    });

    it('overwrites stored credentials when new values are provided', () => {
      setStoredConfig({
        observability: { endpoint: 'https://old-obs.com', username: 'old', password: 'old-pw' },
      });
      const getWritten = captureWrite();

      saveObservabilityConfig({ endpoint: 'https://new-obs.com', username: 'new', password: 'new-pw' });

      const result = getWritten();
      expect((result.observability as any).username).toBe('new');
      expect((result.observability as any).password).toBe('new-pw');
    });

    it('preserves indexes when credentials change', () => {
      setStoredConfig({
        observability: {
          endpoint: 'https://obs.com',
          username: 'user',
          password: 'pass',
        },
      });
      const getWritten = captureWrite();

      saveObservabilityConfig({
        endpoint: 'https://obs.com',
        username: undefined,
        password: undefined,
        indexes: { traces: 'my-traces-*', logs: 'my-logs-*' },
      });

      const result = getWritten();
      expect((result.observability as any).indexes).toEqual({ traces: 'my-traces-*', logs: 'my-logs-*' });
      expect((result.observability as any).username).toBe('user');
      expect((result.observability as any).password).toBe('pass');
    });
  });

  // ==========================================================================
  // getConfigStatus — Bug-3: username + hasPassword
  // ==========================================================================

  describe('getConfigStatus', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env.OPENSEARCH_STORAGE_ENDPOINT;
      delete process.env.OPENSEARCH_STORAGE_USERNAME;
      delete process.env.OPENSEARCH_STORAGE_PASSWORD;
      delete process.env.OPENSEARCH_LOGS_ENDPOINT;
      delete process.env.OPENSEARCH_LOGS_USERNAME;
      delete process.env.OPENSEARCH_LOGS_PASSWORD;
    });

    afterEach(() => {
      process.env = OLD_ENV;
    });

    it('returns username from file config', () => {
      setStoredConfig({
        storage: { endpoint: 'https://store.com', username: 'file-user', password: 'pw' },
      });

      const status = getConfigStatus();

      expect(status.storage.username).toBe('file-user');
    });

    it('returns hasPassword: true when password is stored in file', () => {
      setStoredConfig({
        storage: { endpoint: 'https://store.com', username: 'user', password: 'secret' },
      });

      const status = getConfigStatus();

      expect(status.storage.hasPassword).toBe(true);
    });

    it('returns hasPassword: false when no password is stored in file', () => {
      setStoredConfig({
        storage: { endpoint: 'https://store.com', username: 'user' },
      });

      const status = getConfigStatus();

      expect(status.storage.hasPassword).toBe(false);
    });

    it('returns username from env var when no file config', () => {
      mockedFs.existsSync.mockReturnValue(false);
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env-store.com';
      process.env.OPENSEARCH_STORAGE_USERNAME = 'env-user';

      const status = getConfigStatus();

      expect(status.storage.source).toBe('environment');
      expect(status.storage.username).toBe('env-user');
    });

    it('returns hasPassword: true when env var password exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env-store.com';
      process.env.OPENSEARCH_STORAGE_PASSWORD = 'env-secret';

      const status = getConfigStatus();

      expect(status.storage.hasPassword).toBe(true);
    });

    it('returns hasPassword: false when no env var password', () => {
      mockedFs.existsSync.mockReturnValue(false);
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env-store.com';

      const status = getConfigStatus();

      expect(status.storage.hasPassword).toBe(false);
    });

    it('returns observability username from file config', () => {
      setStoredConfig({
        observability: { endpoint: 'https://obs.com', username: 'obs-user', password: 'pw' },
      });

      const status = getConfigStatus();

      expect(status.observability.username).toBe('obs-user');
      expect(status.observability.hasPassword).toBe(true);
    });

    it('returns observability username from env var when no file config', () => {
      mockedFs.existsSync.mockReturnValue(false);
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://env-obs.com';
      process.env.OPENSEARCH_LOGS_USERNAME = 'env-obs-user';
      process.env.OPENSEARCH_LOGS_PASSWORD = 'env-obs-pass';

      const status = getConfigStatus();

      expect(status.observability.source).toBe('environment');
      expect(status.observability.username).toBe('env-obs-user');
      expect(status.observability.hasPassword).toBe(true);
    });

    it('never returns credentials in a field named password', () => {
      setStoredConfig({
        storage: { endpoint: 'https://store.com', username: 'user', password: 'super-secret' },
        observability: { endpoint: 'https://obs.com', username: 'obs', password: 'obs-secret' },
      });

      const status = getConfigStatus();
      const json = JSON.stringify(status);

      expect(json).not.toContain('super-secret');
      expect(json).not.toContain('obs-secret');
    });
  });
});
