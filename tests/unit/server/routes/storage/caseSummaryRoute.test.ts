/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * POST /api/storage/runs/:id/summary — error-body contract. A storage or
 * SDK failure must not leak its raw message (hostnames, config paths) into
 * the HTTP body: the client gets a generic message plus a correlation id,
 * the server log gets the real cause under the same id.
 */

import express from 'express';
import request from 'supertest';

const mockGetById = jest.fn();
jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({ runs: { getById: (...a: any[]) => mockGetById(...a), update: jest.fn() }, testCases: { getById: jest.fn() } }),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

describe('POST /api/storage/runs/:id/summary — 500 body is generic + correlated', () => {
  let app: express.Express;
  beforeAll(async () => {
    const router = (await import('@/server/routes/storage/runs')).default;
    app = express();
    app.use(express.json());
    app.use(router);
  });

  it('does not echo the storage error; logs it with the same ref', async () => {
    mockGetById.mockRejectedValueOnce(new Error('connect ECONNREFUSED internal-cluster.example:9200 (profile ops-admin)'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/storage/runs/report-x/summary').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^Case summary failed \(ref cs-[a-z0-9]+-[a-z0-9]+\); see server log$/);
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(res.body)).not.toContain('internal-cluster');
    const ref = res.body.error.match(/ref (cs-[a-z0-9-]+)/)![1];
    const logged = error.mock.calls.map(c => c.map(x => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')).join('\n');
    expect(logged).toContain(ref);
    expect(logged).toContain('ECONNREFUSED internal-cluster.example:9200');
    error.mockRestore();
  });
});
