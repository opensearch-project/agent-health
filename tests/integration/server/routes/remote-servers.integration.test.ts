/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for remote servers endpoints (/api/remote-servers)
 *
 * These tests verify:
 * 1. GET /api/remote-servers — lists servers with masked apiKey
 * 2. POST /api/remote-servers — validates and persists new servers
 * 3. DELETE /api/remote-servers/:name — removes servers
 * 4. POST /api/remote-servers/:name/test — tests connectivity
 *
 * Uses mocked filesystem (fs) and fetch to avoid real I/O.
 */

import { jest } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  // config-v2 writeStateScope() does mkdirSync(dir,{recursive:true}) before
  // writing .agent-health/state.json; without it the write path threw 500.
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({
    agents: [],
    models: {},
  }),
  loadConfig: jest.fn().mockResolvedValue({
    agents: [],
    models: {},
  }),
}));

jest.mock('@/server/services/customAgentStore', () => ({
  addCustomAgent: jest.fn(),
  removeCustomAgent: jest.fn(),
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/server/services/codingAgents/remoteConfig', () => ({
  getRemoteServers: jest.fn().mockReturnValue([]),
}));

jest.mock('@/lib/constants', () => ({
  VALID_CONNECTOR_TYPES: ['agui-streaming', 'rest', 'ml-commons', 'holmesgpt'],
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

// Mock global fetch for connectivity tests
const mockFetch = jest.fn() as jest.Mock;
(globalThis as any).fetch = mockFetch;

import type { Application } from 'express';
import { getRemoteServers } from '@/server/services/codingAgents/remoteConfig';

// Use require for CommonJS module compatibility in Jest
const request = require('supertest');

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('Remote Servers Endpoints', () => {
  let app: Application;

  beforeEach(async () => {
    jest.clearAllMocks();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    app = express();
    app.use(express.json());

    // Import the config router (which registers remote-servers routes)
    const { default: configRouter } = await import('@/server/routes/config');
    app.use(configRouter);

    // Default: ui-first mode (the writable state file exists, but NO authored
    // agent-health.config.{ts,js,mjs}). A blanket existsSync->true used to be
    // fine, but config-v2 reads a present authored config as code-first and
    // then rejects remote-server writes with 409. Keep authored config absent
    // so writes stay allowed (201).
    mockExistsSync.mockImplementation(
      (p: any) => !/agent-health\.config\.(ts|js|mjs)$/.test(String(p))
    );
    mockReadFileSync.mockReturnValue(JSON.stringify({ remoteServers: [] }));
    mockWriteFileSync.mockImplementation(() => {});
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/remote-servers
  // ──────────────────────────────────────────────────────────────────────────

  describe('GET /api/remote-servers', () => {
    it('should return 200 with empty servers list when none configured', async () => {
      (getRemoteServers as jest.Mock).mockReturnValue([]);

      const res = await request(app).get('/api/remote-servers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ servers: [] });
    });

    it('should return servers with apiKey masked as hasApiKey boolean', async () => {
      (getRemoteServers as jest.Mock).mockReturnValue([
        { name: 'prod', url: 'https://prod.example.com', apiKey: 'secret-key-123' },
        { name: 'dev', url: 'http://localhost:4001' },
      ]);

      const res = await request(app).get('/api/remote-servers');

      expect(res.status).toBe(200);
      expect(res.body.servers).toHaveLength(2);
      expect(res.body.servers[0]).toEqual({
        name: 'prod',
        url: 'https://prod.example.com',
        hasApiKey: true,
      });
      expect(res.body.servers[1]).toEqual({
        name: 'dev',
        url: 'http://localhost:4001',
        hasApiKey: false,
      });
      // apiKey should NOT be exposed
      expect(res.body.servers[0]).not.toHaveProperty('apiKey');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/remote-servers
  // ──────────────────────────────────────────────────────────────────────────

  describe('POST /api/remote-servers', () => {
    it('should create a remote server and return 201', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'my-server', url: 'https://remote.example.com' });

      expect(res.status).toBe(201);
      expect(res.body.server).toEqual({
        name: 'my-server',
        url: 'https://remote.example.com',
        hasApiKey: false,
      });
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('should strip trailing slash from url', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'slashy', url: 'https://remote.example.com/' });

      expect(res.status).toBe(201);
      expect(res.body.server.url).toBe('https://remote.example.com');
    });

    it('should persist apiKey when provided', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'secure', url: 'https://secure.example.com', apiKey: 'my-secret' });

      expect(res.status).toBe(201);
      expect(res.body.server.hasApiKey).toBe(true);

      // Verify config was written with apiKey
      const writtenConfig = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      const saved = writtenConfig.remoteServers[0];
      expect(saved.apiKey).toBe('my-secret');
    });

    it('should return 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ url: 'https://example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('name is required');
    });

    it('should return 400 when name is empty string', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: '   ', url: 'https://example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('name is required');
    });

    it('should return 400 when url is missing', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'no-url' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('url is required');
    });

    it('should return 400 when url is empty string', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'empty-url', url: '  ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('url is required');
    });

    it('should return 400 for invalid URL format', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'bad-url', url: 'not-a-url' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid URL/i);
    });

    it('should return 400 for non-http URL', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'ftp-server', url: 'ftp://files.example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/http or https/i);
    });

    it('should return 409 when server name already exists', async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ remoteServers: [{ name: 'existing', url: 'https://old.example.com' }] })
      );

      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'existing', url: 'https://new.example.com' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('should handle missing config file gracefully (creates from scratch)', async () => {
      mockExistsSync.mockReturnValue(false);

      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'first-server', url: 'https://first.example.com' });

      expect(res.status).toBe(201);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/remote-servers/:name
  // ──────────────────────────────────────────────────────────────────────────

  describe('DELETE /api/remote-servers/:name', () => {
    it('should remove existing server and return 204', async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          remoteServers: [
            { name: 'to-remove', url: 'https://remove.example.com' },
            { name: 'keep', url: 'https://keep.example.com' },
          ],
        })
      );

      const res = await request(app).delete('/api/remote-servers/to-remove');

      expect(res.status).toBe(204);
      const writtenConfig = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(writtenConfig.remoteServers).toHaveLength(1);
      expect(writtenConfig.remoteServers[0].name).toBe('keep');
    });

    it('should return 404 when server not found', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ remoteServers: [] }));

      const res = await request(app).delete('/api/remote-servers/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('should handle missing config file (empty servers list)', async () => {
      mockExistsSync.mockReturnValue(false);

      const res = await request(app).delete('/api/remote-servers/ghost');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/remote-servers/:name/test
  // ──────────────────────────────────────────────────────────────────────────

  describe('POST /api/remote-servers/:name/test', () => {
    beforeEach(() => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          remoteServers: [
            { name: 'prod', url: 'https://prod.example.com', apiKey: 'secret' },
            { name: 'dev', url: 'http://localhost:5000' },
          ],
        })
      );
    });

    it('should return ok status when remote responds with agents', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ agents: [{ name: 'agent-1' }, { name: 'agent-2' }] }),
      });

      const res = await request(app).post('/api/remote-servers/prod/test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', agents: 2 });

      // Verify fetch was called with correct URL and auth header
      expect(mockFetch).toHaveBeenCalledWith(
        'https://prod.example.com/api/coding-agents/available',
        expect.objectContaining({
          headers: { Authorization: 'Bearer secret' },
        })
      );
    });

    it('should not send Authorization header when no apiKey', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ agents: [] }),
      });

      const res = await request(app).post('/api/remote-servers/dev/test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', agents: 0 });

      // No auth header
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:5000/api/coding-agents/available',
        expect.objectContaining({
          headers: {},
        })
      );
    });

    it('should return error status when remote returns non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const res = await request(app).post('/api/remote-servers/prod/test');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('503');
    });

    it('should return error status when fetch throws (connection refused)', async () => {
      mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const res = await request(app).post('/api/remote-servers/prod/test');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('ECONNREFUSED');
    });

    it('should return 404 when server name not found', async () => {
      const res = await request(app).post('/api/remote-servers/unknown/test');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('should handle agents field missing in response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app).post('/api/remote-servers/dev/test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', agents: 0 });
    });
  });
});
