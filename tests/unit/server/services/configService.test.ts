/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';

// Mock modules - need to define mock functions first
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockLoad = jest.fn();
const mockDump = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

jest.mock('js-yaml', () => ({
  load: (...args: any[]) => mockLoad(...args),
  dump: (...args: any[]) => mockDump(...args),
}));

// Import after mocking
import {
  getStorageConfigFromFile,
  getObservabilityConfigFromFile,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
  getConfigStatus,
  configFileExists,
} from '@/server/services/configService';

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('configService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset process.env
    delete process.env.OPENSEARCH_STORAGE_ENDPOINT;
    delete process.env.OPENSEARCH_STORAGE_USERNAME;
    delete process.env.OPENSEARCH_STORAGE_PASSWORD;
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    delete process.env.OPENSEARCH_LOGS_USERNAME;
    delete process.env.OPENSEARCH_LOGS_PASSWORD;
  });

  describe('getStorageConfigFromFile', () => {
    it('should return null when config file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = getStorageConfigFromFile();

      expect(result).toBeNull();
    });

    it('should return storage config when file has storage section', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('storage:\n  endpoint: https://test.com');
      mockLoad.mockReturnValue({
        storage: {
          endpoint: 'https://test.com',
          username: 'user',
          password: 'pass',
        },
      });

      const result = getStorageConfigFromFile();

      expect(result).toEqual({
        endpoint: 'https://test.com',
        username: 'user',
        password: 'pass',
      });
    });

    it('should return null when storage section is missing endpoint', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('storage:\n  username: user');
      mockLoad.mockReturnValue({
        storage: {
          username: 'user',
        },
      });

      const result = getStorageConfigFromFile();

      expect(result).toBeNull();
    });
  });

  describe('getObservabilityConfigFromFile', () => {
    it('should return null when config file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = getObservabilityConfigFromFile();

      expect(result).toBeNull();
    });

    it('should return observability config when file has observability section', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('observability:\n  endpoint: https://test.com');
      mockLoad.mockReturnValue({
        observability: {
          endpoint: 'https://test.com',
          username: 'user',
          password: 'pass',
          indexes: {
            traces: 'traces-*',
            logs: 'logs-*',
          },
        },
      });

      const result = getObservabilityConfigFromFile();

      expect(result).toEqual({
        endpoint: 'https://test.com',
        username: 'user',
        password: 'pass',
        indexes: {
          traces: 'traces-*',
          logs: 'logs-*',
        },
      });
    });
  });

  describe('saveStorageConfig', () => {
    it('should write storage config to file', () => {
      mockExistsSync.mockReturnValue(false);
      mockDump.mockReturnValue('storage:\n  endpoint: https://test.com');

      saveStorageConfig({
        endpoint: 'https://test.com',
        username: 'user',
        password: 'pass',
      });

      expect(mockDump).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('should merge with existing config', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('observability:\n  endpoint: https://obs.com');
      mockLoad.mockReturnValue({
        observability: {
          endpoint: 'https://obs.com',
        },
      });
      mockDump.mockReturnValue('yaml content');

      saveStorageConfig({
        endpoint: 'https://storage.com',
      });

      expect(mockDump).toHaveBeenCalledWith(
        expect.objectContaining({
          observability: { endpoint: 'https://obs.com' },
          storage: { endpoint: 'https://storage.com' },
        }),
        expect.any(Object)
      );
    });
  });

  describe('clearStorageConfig', () => {
    it('should remove storage section from config', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('yaml content');
      mockLoad.mockReturnValue({
        storage: { endpoint: 'https://test.com' },
        observability: { endpoint: 'https://obs.com' },
      });
      mockDump.mockReturnValue('yaml content');

      clearStorageConfig();

      expect(mockDump).toHaveBeenCalledWith(
        { observability: { endpoint: 'https://obs.com' } },
        expect.any(Object)
      );
    });

    it('should delete file when config becomes empty', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('yaml content');
      mockLoad.mockReturnValue({
        storage: { endpoint: 'https://test.com' },
      });

      clearStorageConfig();

      expect(mockUnlinkSync).toHaveBeenCalled();
    });
  });

  describe('getConfigStatus', () => {
    it('should return file source when config file exists', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('yaml content');
      mockLoad.mockReturnValue({
        storage: { endpoint: 'https://storage.com' },
        observability: { endpoint: 'https://obs.com' },
      });

      const status = getConfigStatus();

      expect(status.storage.source).toBe('file');
      expect(status.storage.configured).toBe(true);
      expect(status.storage.endpoint).toBe('https://storage.com');
      expect(status.observability.source).toBe('file');
      expect(status.observability.configured).toBe(true);
      expect(status.observability.endpoint).toBe('https://obs.com');
    });

    it('should return environment source when using env vars', () => {
      mockExistsSync.mockReturnValue(false);
      process.env.OPENSEARCH_STORAGE_ENDPOINT = 'https://env-storage.com';
      process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://env-logs.com';

      const status = getConfigStatus();

      expect(status.storage.source).toBe('environment');
      expect(status.storage.endpoint).toBe('https://env-storage.com');
      expect(status.observability.source).toBe('environment');
      expect(status.observability.endpoint).toBe('https://env-logs.com');
    });

    it('should return none when not configured', () => {
      mockExistsSync.mockReturnValue(false);

      const status = getConfigStatus();

      expect(status.storage.source).toBe('none');
      expect(status.storage.configured).toBe(false);
      expect(status.observability.source).toBe('none');
      expect(status.observability.configured).toBe(false);
    });
  });

  describe('configFileExists', () => {
    it('should return true when file exists', () => {
      mockExistsSync.mockReturnValue(true);

      expect(configFileExists()).toBe(true);
    });

    it('should return false when file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      expect(configFileExists()).toBe(false);
    });
  });
});
