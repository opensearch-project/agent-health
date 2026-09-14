/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the REAL configService implementation under config v2 (#271).
 *
 * configService now reads/writes runtime state via lib/config/statePaths
 * (project `.agent-health/state.json` over user, ignored in code-first mode),
 * so we mock statePaths rather than fs. Covers credential preservation, the
 * ts > state > env precedence, the TS-config bridge, and the mode gate.
 */

jest.mock('@/server/adapters/index', () => ({
  getStorageState: jest.fn().mockReturnValue({
    backend: 'file',
    configKey: null,
    error: null,
    configuredEndpoint: null,
  }),
}));

jest.mock('@/server/services/opensearchClientFactory', () => ({
  configToCacheKey: jest.fn().mockReturnValue(null),
}));

jest.mock('@/lib/config/statePaths', () => ({
  readLayeredState: jest.fn(() => ({})),
  readStateScope: jest.fn(() => ({})),
  writeStateScope: jest.fn(),
  isCodeFirstMode: jest.fn(() => false),
  projectStatePath: jest.fn(() => '/cwd/.agent-health/state.json'),
  userStatePath: jest.fn(() => '/home/u/.agent-health/state.json'),
}));

import { readLayeredState, readStateScope, writeStateScope } from '@/lib/config/statePaths';

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

// Import the REAL module via a relative path not caught by moduleNameMapper.
import {
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
  getConfigStatus,
  getStorageConfigFromFile,
  getObservabilityConfigFromFile,
  setTsClusterConfig,
  getStorageConfigFromTs,
  getObservabilityConfigFromTs,
  __resetTsClusterConfigForTests,
} from '../../../../server/services/configService';

const mockReadLayeredState = readLayeredState as jest.Mock;
const mockReadStateScope = readStateScope as jest.Mock;
const mockWriteStateScope = writeStateScope as jest.Mock;

/** Last patch written via writeStateScope. */
function lastWrite(): { patch: any; scope: string } {
  const calls = mockWriteStateScope.mock.calls;
  if (calls.length === 0) throw new Error('writeStateScope was not called');
  const [patch, scope] = calls[calls.length - 1];
  return { patch, scope };
}

describe('configService (real implementation, config v2)', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetTsClusterConfigForTests();
    mockReadLayeredState.mockReturnValue({});
    mockReadStateScope.mockReturnValue({});
    mockWriteStateScope.mockReset();
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

  // ==========================================================================
  // saveStorageConfig — writes to project state, preserves credentials
  // ==========================================================================

  describe('saveStorageConfig', () => {
    it('writes endpoint, username, and password to the project state file', () => {
      saveStorageConfig({ endpoint: 'https://new.com', username: 'alice', password: 'secret' });

      const { patch, scope } = lastWrite();
      expect(scope).toBe('project');
      expect(patch.storage).toEqual({ endpoint: 'https://new.com', username: 'alice', password: 'secret' });
    });

    it('preserves stored username/password when new values are undefined', () => {
      mockReadStateScope.mockReturnValue({ storage: { endpoint: 'old', username: 'stored-user', password: 'stored-pass' } });

      saveStorageConfig({ endpoint: 'https://new.com', username: undefined, password: undefined });

      const { patch } = lastWrite();
      expect(patch.storage.username).toBe('stored-user');
      expect(patch.storage.password).toBe('stored-pass');
      expect(patch.storage.endpoint).toBe('https://new.com');
    });

    it('overwrites stored username/password when new values are provided', () => {
      mockReadStateScope.mockReturnValue({ storage: { endpoint: 'old', username: 'old-user', password: 'old-pass' } });

      saveStorageConfig({ endpoint: 'https://new.com', username: 'new-user', password: undefined });
      let { patch } = lastWrite();
      expect(patch.storage.username).toBe('new-user');
      expect(patch.storage.password).toBe('old-pass');

      mockWriteStateScope.mockClear();
      saveStorageConfig({ endpoint: 'https://new.com', username: undefined, password: 'new-pass' });
      ({ patch } = lastWrite());
      expect(patch.storage.password).toBe('new-pass');
      expect(patch.storage.username).toBe('old-user');
    });

    it('omits username/password keys when both absent and nothing stored', () => {
      saveStorageConfig({ endpoint: 'https://new.com', username: undefined, password: undefined });
      const { patch } = lastWrite();
      expect(patch.storage).not.toHaveProperty('username');
      expect(patch.storage).not.toHaveProperty('password');
    });

    it('writes tlsSkipVerify and SigV4 fields when provided', () => {
      saveStorageConfig({ endpoint: 'https://new.com', authType: 'sigv4', awsRegion: 'us-east-1', awsService: 'es', tlsSkipVerify: true });
      const { patch } = lastWrite();
      expect(patch.storage.authType).toBe('sigv4');
      expect(patch.storage.awsRegion).toBe('us-east-1');
      expect(patch.storage.tlsSkipVerify).toBe(true);
    });

    it('propagates the writeStateScope error (e.g. code-first mode)', () => {
      mockWriteStateScope.mockImplementation(() => { throw new Error('managed by agent-health.config.ts (code-first mode)'); });
      expect(() => saveStorageConfig({ endpoint: 'https://x' })).toThrow(/code-first/);
    });
  });

  // ==========================================================================
  // saveObservabilityConfig
  // ==========================================================================

  describe('saveObservabilityConfig', () => {
    it('writes observability config to project state', () => {
      saveObservabilityConfig({ endpoint: 'https://obs.com', username: 'bob', password: 'pw' });
      const { patch } = lastWrite();
      expect(patch.observability).toEqual({ endpoint: 'https://obs.com', username: 'bob', password: 'pw' });
    });

    it('preserves credentials and keeps indexes when credentials change', () => {
      mockReadStateScope.mockReturnValue({ observability: { endpoint: 'https://obs.com', username: 'user', password: 'pass' } });

      saveObservabilityConfig({
        endpoint: 'https://obs.com',
        username: undefined,
        password: undefined,
        indexes: { traces: 'my-traces-*', logs: 'my-logs-*' },
      });

      const { patch } = lastWrite();
      expect(patch.observability.username).toBe('user');
      expect(patch.observability.password).toBe('pass');
      expect(patch.observability.indexes).toEqual({ traces: 'my-traces-*', logs: 'my-logs-*' });
    });
  });

  // ==========================================================================
  // clear*
  // ==========================================================================

  describe('clear*', () => {
    it('clearStorageConfig deletes the storage key via undefined patch', () => {
      clearStorageConfig();
      expect(lastWrite().patch).toEqual({ storage: undefined });
    });

    it('clearObservabilityConfig deletes the observability key via undefined patch', () => {
      clearObservabilityConfig();
      expect(lastWrite().patch).toEqual({ observability: undefined });
    });
  });

  // ==========================================================================
  // getStorageConfigFromFile / getObservabilityConfigFromFile (runtime state)
  // ==========================================================================

  describe('getStorageConfigFromFile', () => {
    it('returns null when state is empty (unconfigured or code-first)', () => {
      mockReadLayeredState.mockReturnValue({});
      expect(getStorageConfigFromFile()).toBeNull();
    });

    it('returns the storage config from layered state', () => {
      mockReadLayeredState.mockReturnValue({ storage: { endpoint: 'https://s.com', authType: 'sigv4' } });
      expect(getStorageConfigFromFile()?.endpoint).toBe('https://s.com');
    });

    it('getObservabilityConfigFromFile returns observability from state', () => {
      mockReadLayeredState.mockReturnValue({ observability: { endpoint: 'https://o.com' } });
      expect(getObservabilityConfigFromFile()?.endpoint).toBe('https://o.com');
    });
  });

  // ==========================================================================
  // getConfigStatus — source + credential surfacing
  // ==========================================================================

  describe('getConfigStatus', () => {
    it('reports source=file with username/hasPassword from the state file', () => {
      mockReadLayeredState.mockReturnValue({ storage: { endpoint: 'https://store.com', username: 'file-user', password: 'pw' } });

      const status = getConfigStatus();

      expect(status.storage.source).toBe('file');
      expect(status.storage.configured).toBe(true);
      expect(status.storage.username).toBe('file-user');
      expect(status.storage.hasPassword).toBe(true);
    });

    it('reports source=environment from env vars', () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env.com';
      process.env.OPENSEARCH_STORAGE_USERNAME = 'env-user';

      const status = getConfigStatus();
      expect(status.storage.source).toBe('environment');
      expect(status.storage.username).toBe('env-user');
    });

    it('never leaks credentials in a field named password', () => {
      mockReadLayeredState.mockReturnValue({
        storage: { endpoint: 'https://store.com', password: 'super-secret' },
        observability: { endpoint: 'https://obs.com', password: 'obs-secret' },
      });
      const json = JSON.stringify(getConfigStatus());
      expect(json).not.toContain('super-secret');
      expect(json).not.toContain('obs-secret');
    });

    // Where THIS server resolves relative code-SDK `sourceFile`s — the UI/CLI
    // read it from here (see lib/config/evalRoots.ts for the precedence).
    it('exposes evalRoots: default [cwd]; state.json evalRoots (ui-first); AGENT_HEALTH_EVAL_ROOTS wins', () => {
      expect(getConfigStatus().evalRoots).toEqual({ roots: [process.cwd()], source: 'default' });

      mockReadLayeredState.mockReturnValue({ evalRoots: ['/srv/eval-repo'] });
      expect(getConfigStatus().evalRoots).toEqual({ roots: ['/srv/eval-repo'], source: 'file' });

      process.env.AGENT_HEALTH_EVAL_ROOTS = ['/srv/a', '/srv/b'].join(require('path').delimiter);
      expect(getConfigStatus().evalRoots).toEqual({ roots: ['/srv/a', '/srv/b'], source: 'environment' });
    });
  });

  // ==========================================================================
  // TypeScript config bridge + precedence (ts > state > env)
  // ==========================================================================

  describe('TypeScript config bridge', () => {
    it('getStorageConfigFromTs / getObservabilityConfigFromTs default to null', () => {
      expect(getStorageConfigFromTs()).toBeNull();
      expect(getObservabilityConfigFromTs()).toBeNull();
    });

    it('setTsClusterConfig stores cluster config; endpoint-less treated as null', () => {
      setTsClusterConfig({ storage: { endpoint: 'https://ts.com', authType: 'sigv4', awsRegion: 'us-east-1' } });
      expect(getStorageConfigFromTs()).toEqual({ endpoint: 'https://ts.com', authType: 'sigv4', awsRegion: 'us-east-1' });

      setTsClusterConfig({ storage: { endpoint: '' } as any });
      expect(getStorageConfigFromTs()).toBeNull();
    });

    it('getConfigStatus reports source=typescript when only TS config is present', () => {
      mockReadLayeredState.mockReturnValue({}); // code-first → state ignored
      setTsClusterConfig({
        storage: { endpoint: 'https://ts-store.com', username: 'ts-user', password: 'ts-pw' },
        observability: { endpoint: 'https://ts-obs.com' },
      });

      const status = getConfigStatus();
      expect(status.storage.source).toBe('typescript');
      expect(status.storage.username).toBe('ts-user');
      expect(status.storage.hasPassword).toBe(true);
      expect(status.observability.source).toBe('typescript');
    });

    it('TS config WINS over the state file when both are present (config v2 precedence)', () => {
      // (In practice the mode gate makes state {} in code-first; this asserts
      // the resolution order directly.)
      mockReadLayeredState.mockReturnValue({ storage: { endpoint: 'https://state.com', username: 'state-user' } });
      setTsClusterConfig({ storage: { endpoint: 'https://ts.com', username: 'ts-user' } });

      const status = getConfigStatus();
      expect(status.storage.source).toBe('typescript');
      expect(status.storage.endpoint).toBe('https://ts.com');
      expect(status.storage.username).toBe('ts-user');
    });

    it('TS config wins over env vars', () => {
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env.com';
      setTsClusterConfig({ storage: { endpoint: 'https://ts.com' } });
      expect(getConfigStatus().storage.source).toBe('typescript');
    });

    it('never leaks TS-config passwords in getConfigStatus', () => {
      setTsClusterConfig({ storage: { endpoint: 'https://ts.com', password: 'ts-super-secret' } });
      expect(JSON.stringify(getConfigStatus())).not.toContain('ts-super-secret');
    });
  });
});
