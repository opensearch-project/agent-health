/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response, NextFunction } from 'express';
import { apiKeyAuth } from '@/server/middleware/apiKeyAuth';

function createMockReqResNext(overrides: Partial<Request> = {}) {
  const req = { path: '/api/coding-agents/stats', headers: {}, ...overrides } as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('apiKeyAuth middleware', () => {
  let originalApiKey: string | undefined;
  let originalLegacyApiKey: string | undefined;
  let originalQuietDeprecations: string | undefined;

  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  beforeEach(() => {
    originalApiKey = process.env.AH_API_KEY;
    originalLegacyApiKey = process.env.AGENT_HEALTH_API_KEY;
    originalQuietDeprecations = process.env.AH_QUIET_DEPRECATIONS;
    delete process.env.AH_API_KEY;
    delete process.env.AGENT_HEALTH_API_KEY;
    process.env.AH_QUIET_DEPRECATIONS = '1';
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.AH_API_KEY;
    else process.env.AH_API_KEY = originalApiKey;
    if (originalLegacyApiKey === undefined) delete process.env.AGENT_HEALTH_API_KEY;
    else process.env.AGENT_HEALTH_API_KEY = originalLegacyApiKey;
    if (originalQuietDeprecations === undefined) delete process.env.AH_QUIET_DEPRECATIONS;
    else process.env.AH_QUIET_DEPRECATIONS = originalQuietDeprecations;
  });

  it('should call next() when no API key env var is set', () => {
    const { req, res, next } = createMockReqResNext();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should call next() for non-coding-agents routes', () => {
    process.env.AH_API_KEY = 'secret-key';
    const { req, res, next } = createMockReqResNext({ path: '/api/agents' } as Partial<Request>);

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return 401 when Authorization header is missing', () => {
    process.env.AH_API_KEY = 'secret-key';
    const { req, res, next } = createMockReqResNext();

    apiKeyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: API key required' });
  });

  it('should return 401 when Authorization header has no Bearer prefix', () => {
    process.env.AH_API_KEY = 'secret-key';
    const { req, res, next } = createMockReqResNext({
      headers: { authorization: 'Token secret-key' },
    } as Partial<Request>);

    apiKeyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: API key required' });
  });

  it('should return 401 when the provided token is wrong', () => {
    process.env.AH_API_KEY = 'secret-key';
    const { req, res, next } = createMockReqResNext({
      headers: { authorization: 'Bearer wrong-key' },
    } as Partial<Request>);

    apiKeyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Invalid API key' });
  });

  it('should call next() when the correct token is provided', () => {
    process.env.AH_API_KEY = 'secret-key';
    const { req, res, next } = createMockReqResNext({
      headers: { authorization: 'Bearer secret-key' },
    } as Partial<Request>);

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should call next() when API key env var is an empty string', () => {
    process.env.AH_API_KEY = '';
    const { req, res, next } = createMockReqResNext();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should require auth for paths with trailing slash under /api/coding-agents/', () => {
    process.env.AH_API_KEY = 'secret-key';
    const { req, res, next } = createMockReqResNext({
      path: '/api/coding-agents/sessions/123',
    } as Partial<Request>);

    apiKeyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: API key required' });
  });

  it('still accepts legacy AGENT_HEALTH_API_KEY (backward compat)', () => {
    process.env.AGENT_HEALTH_API_KEY = 'legacy-key';
    const { req, res, next } = createMockReqResNext({
      headers: { authorization: 'Bearer legacy-key' },
    } as Partial<Request>);

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('prefers AH_API_KEY over legacy AGENT_HEALTH_API_KEY when both set', () => {
    process.env.AH_API_KEY = 'new-key';
    process.env.AGENT_HEALTH_API_KEY = 'legacy-key';
    const { req, res, next } = createMockReqResNext({
      headers: { authorization: 'Bearer new-key' },
    } as Partial<Request>);

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
