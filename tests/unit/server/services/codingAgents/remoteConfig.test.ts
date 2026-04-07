/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

jest.mock('fs');

import { getRemoteServers } from '@/server/services/codingAgents/remoteConfig';

const mockFs = jest.requireMock('fs') as jest.Mocked<typeof import('fs')>;

describe('remoteConfig', () => {
  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getRemoteServers', () => {
    it('should return empty array when config file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = getRemoteServers();

      expect(result).toEqual([]);
      expect(mockFs.readFileSync).not.toHaveBeenCalled();
    });

    it('should return empty array when config has no remoteServers key', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ agents: [] }));

      const result = getRemoteServers();

      expect(result).toEqual([]);
    });

    it('should return servers when config has valid remoteServers', () => {
      const servers = [
        { name: 'server-1', url: 'http://localhost:4002' },
        { name: 'server-2', url: 'http://localhost:4003' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ remoteServers: servers })
      );

      const result = getRemoteServers();

      expect(result).toEqual(servers);
    });

    it('should filter out entries missing name', () => {
      const servers = [
        { url: 'http://localhost:4002' },
        { name: 'valid', url: 'http://localhost:4003' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ remoteServers: servers })
      );

      const result = getRemoteServers();

      expect(result).toEqual([{ name: 'valid', url: 'http://localhost:4003' }]);
    });

    it('should filter out entries missing url', () => {
      const servers = [
        { name: 'no-url' },
        { name: 'valid', url: 'http://localhost:4003' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ remoteServers: servers })
      );

      const result = getRemoteServers();

      expect(result).toEqual([{ name: 'valid', url: 'http://localhost:4003' }]);
    });

    it('should return empty array on JSON parse error', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('not valid json {{{');

      const result = getRemoteServers();

      expect(result).toEqual([]);
    });

    it('should include apiKey when present', () => {
      const servers = [
        { name: 'secure-server', url: 'http://localhost:4002', apiKey: 'secret-token' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ remoteServers: servers })
      );

      const result = getRemoteServers();

      expect(result).toEqual([
        { name: 'secure-server', url: 'http://localhost:4002', apiKey: 'secret-token' },
      ]);
    });
  });
});
