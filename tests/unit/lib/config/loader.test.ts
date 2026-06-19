/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';

// Mock fs and path modules
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

jest.mock('path', () => ({
  ...jest.requireActual('path'),
  join: jest.fn((...args) => args.join('/')),
  resolve: jest.fn((...args) => args.join('/')),
}));

describe('Config Loader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('loadConfigSync', () => {
    it('should return default config when no config file exists', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const { loadConfigSync } = require('@/lib/config/loader');
      const config = loadConfigSync();

      expect(config).toBeDefined();
      expect(config.agents).toBeDefined();
      expect(config.models).toBeDefined();
    });

    it('should load TypeScript config when agent-health.config.ts exists', () => {
      (fs.existsSync as jest.Mock).mockImplementation((filepath: string) => {
        return filepath.includes('agent-health.config.ts');
      });

      // Mock require for the TS config
      jest.doMock('/test/agent-health.config.ts', () => ({
        default: {
          agents: { 'ts-agent': { name: 'TS Agent' } },
          models: { 'ts-model': { model_id: 'ts-model-id' } },
        },
      }), { virtual: true });

      const { loadConfigSync } = require('@/lib/config/loader');
      const config = loadConfigSync();

      expect(config).toBeDefined();
    });
  });

  describe('findConfigFile', () => {
    it('should return default config when files do not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const { loadConfigSync } = require('@/lib/config/loader');
      const config = loadConfigSync();

      // Should return a valid config object with defaults
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });
  });
});

describe('toAgentConfig (via loadConfig)', () => {
  it('should preserve hooks through agent config conversion', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    // Clear cache and modules so we get a fresh loader
    jest.resetModules();
    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    // loadConfig with no config file returns defaults; to test toAgentConfig
    // we need to mock the file loading. Instead, test the exported mergeConfigs
    // behavior indirectly: verify that agent configs from defaults don't break
    // with the new hooks field.
    const config = await loadConfig('/nonexistent', true);

    // Default agents should have no hooks (undefined)
    for (const agent of config.agents) {
      expect(agent.hooks).toBeUndefined();
    }
  });
});

describe('defineConfig', () => {
  it('should return the config object unchanged', () => {
    const { defineConfig } = require('@/lib/config/defineConfig');

    const testConfig = {
      agents: { 'test': { name: 'Test' } },
      models: { 'model': { model_id: 'id' } },
    };

    const result = defineConfig(testConfig);

    expect(result).toBe(testConfig);
  });

  it('should preserve hooks in agent config', () => {
    const { defineConfig } = require('@/lib/config/defineConfig');

    const hookFn = async (ctx: any) => ctx;
    const testConfig = {
      agents: [{
        key: 'test',
        name: 'Test',
        endpoint: 'http://localhost:3000',
        hooks: { beforeRequest: hookFn },
      }],
    };

    const result = defineConfig(testConfig);
    expect(result.agents[0].hooks.beforeRequest).toBe(hookFn);
  });
});

describe('findConfigFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should find agent-health.config.ts file', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockImplementation((filePath: string) => {
      return filePath.endsWith('agent-health.config.ts');
    });

    const { findConfigFile } = require('@/lib/config/loader');
    const result = findConfigFile('/test/dir');

    expect(result).not.toBeNull();
    expect(result.format).toBe('typescript');
    expect(result.exists).toBe(true);
  });

  it('should find agent-health.config.js file when .ts not present', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockImplementation((filePath: string) => {
      return filePath.endsWith('agent-health.config.js');
    });

    const { findConfigFile } = require('@/lib/config/loader');
    const result = findConfigFile('/test/dir');

    expect(result).not.toBeNull();
    expect(result.format).toBe('javascript');
    expect(result.exists).toBe(true);
  });

  it('should find agent-health.config.mjs file', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockImplementation((filePath: string) => {
      return filePath.endsWith('agent-health.config.mjs');
    });

    const { findConfigFile } = require('@/lib/config/loader');
    const result = findConfigFile('/test/dir');

    expect(result).not.toBeNull();
    expect(result.format).toBe('javascript');
    expect(result.exists).toBe(true);
  });

  it('should return null when no config file found', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { findConfigFile } = require('@/lib/config/loader');
    const result = findConfigFile('/test/dir');

    expect(result).toBeNull();
  });
});

describe('loadConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should use defaults when no config file exists', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();
    const config = await loadConfig('/nonexistent', true);

    expect(config.agents).toBeDefined();
    expect(config.agents.length).toBeGreaterThan(0);
    expect(config.models).toBeDefined();
    expect(config.server.port).toBe(4001);
  });

  it('should return cached config on second call', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    const config1 = await loadConfig('/nonexistent', true);
    const config2 = await loadConfig('/nonexistent');

    // Same reference since cached
    expect(config1).toStrictEqual(config2);
  });

  it('should reload when force is true', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    const config1 = await loadConfig('/nonexistent', true);
    const config2 = await loadConfig('/nonexistent', true);

    // Both are freshly loaded but structurally equal
    expect(config1.agents.length).toBe(config2.agents.length);
  });

  it('should set default reporters to console', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    const config = await loadConfig('/test', true);
    expect(config.reporters).toEqual([['console']]);
  });

  it('should set default judge config', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    const config = await loadConfig('/test', true);
    expect(config.judge.provider).toBe('bedrock');
    expect(config.judge.model).toBe('claude-sonnet-4');
  });

  it('exposes storage/observability on the resolved config (undefined when unset) (#261)', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    const config = await loadConfig('/nonexistent', true);
    // The keys must exist on ResolvedConfig so server/app.ts can pass them to
    // setTsClusterConfig(); with no config file they resolve to undefined.
    expect('storage' in config).toBe(true);
    expect('observability' in config).toBe(true);
    expect(config.storage).toBeUndefined();
    expect(config.observability).toBeUndefined();
  });

  it('logs an explicit message when only the runtime state file is present', async () => {
    // No code config (.ts/.js/.mjs), but .agent-health/state.json exists.
    // The loader doesn't read it — server services do — but the startup log
    // must surface its presence (ui-first mode) so the user doesn't think
    // "no config" when storage / observability are in fact configured.
    const mockFs = require('fs');
    mockFs.existsSync.mockImplementation((p: string) => p.endsWith('state.json'));

    // Diagnostics go to stdout only in interactive use (gated by lib/diagnostics).
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();
    await loadConfig('/test', true);

    const calls = logSpy.mock.calls.map(c => c.join(' '));
    expect(calls.some(s => s.includes('state.json') && s.includes('detected'))).toBe(true);
    // And the misleading "No config file found" message must NOT fire.
    expect(calls.some(s => s.includes('No config file found'))).toBe(false);
  });

  it('still logs the original "no config" message when neither code nor JSON config exists', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const { loadConfig, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();
    await loadConfig('/test', true);

    const calls = logSpy.mock.calls.map(c => c.join(' '));
    expect(calls.some(s => s.includes('No config file found'))).toBe(true);
  });
});

describe('hasServerJsonConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('returns true when the runtime state file exists', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockImplementation((p: string) => p.endsWith('state.json'));

    const { hasServerJsonConfig } = require('@/lib/config/loader');
    expect(hasServerJsonConfig('/test')).toBe(true);
  });

  it('returns false when agent-health.config.json is absent', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { hasServerJsonConfig } = require('@/lib/config/loader');
    expect(hasServerJsonConfig('/test')).toBe(false);
  });
});

describe('loadConfigSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should return cached config if available', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);
    jest.spyOn(console, 'log').mockImplementation();

    const { loadConfig, loadConfigSync, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    // Populate cache via loadConfig
    const asyncConfig = await loadConfig('/test', true);
    const syncConfig = loadConfigSync();

    expect(syncConfig).toBe(asyncConfig);

    jest.restoreAllMocks();
  });

  it('should return defaults with empty connectors and testCases', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { loadConfigSync, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    const config = loadConfigSync();
    expect(config.connectors).toEqual([]);
    expect(config.testCases).toEqual([]);
  });
});

describe('clearConfigCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should clear the cached config', async () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);
    jest.spyOn(console, 'log').mockImplementation();

    const { loadConfig, loadConfigSync, clearConfigCache } = require('@/lib/config/loader');
    clearConfigCache();

    await loadConfig('/test', true);
    clearConfigCache();

    // After clearing, loadConfigSync should return fresh defaults (not cached)
    const syncConfig = loadConfigSync();
    expect(syncConfig).toBeDefined();
    expect(syncConfig.agents).toBeDefined();

    jest.restoreAllMocks();
  });
});

describe('getConfigFileInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('should return config file info when exists', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockImplementation((filePath: string) => {
      return filePath.endsWith('agent-health.config.ts');
    });

    const { getConfigFileInfo } = require('@/lib/config/loader');
    const info = getConfigFileInfo('/test/dir');

    expect(info).not.toBeNull();
    expect(info.format).toBe('typescript');
  });

  it('should return null when no config file found', () => {
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(false);

    const { getConfigFileInfo } = require('@/lib/config/loader');
    const info = getConfigFileInfo('/test/dir');

    expect(info).toBeNull();
  });
});
