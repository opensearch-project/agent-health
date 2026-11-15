/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `createHttpSourceStorage` (#612): the `SourceStorage` surface the source
 * resolver needs, over the storage REST API — against a REAL `http` server
 * standing in for the project server, so request shapes and status handling
 * are exercised, not mocked.
 */

import { createServer, type Server } from 'http';
import { createHttpSourceStorage, filterTestCases, StorageApiError } from '@/cli/utils/httpSourceStorage';

interface Call { method: string; path: string; body: any }
let server: Server;
let url: string;
let calls: Call[];
let routes: Record<string, (c: Call) => { status: number; body: unknown }>;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const call: Call = { method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined };
      calls.push(call);
      const key = `${call.method} ${call.path.split('?')[0]}`;
      const handler = routes[key];
      const answer = handler ? handler(call) : { status: 404, body: { error: 'Not found' } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls = []; routes = {}; });

const tc = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `case ${id}`, category: 'General', difficulty: 'Easy', initialPrompt: 'q', labels: [], ...extra });

describe('createHttpSourceStorage', () => {
  it('reads benchmarks and test cases by id; 404 → null; other errors → StorageApiError with the server message', async () => {
    routes['GET /api/storage/benchmarks/b-1'] = () => ({ status: 200, body: { id: 'b-1', name: 'B', testCaseIds: ['t-1'] } });
    routes['GET /api/storage/test-cases/t-1'] = () => ({ status: 200, body: tc('t-1') });
    routes['GET /api/storage/test-cases/t-500'] = () => ({ status: 500, body: { error: 'storage exploded' } });
    const s = createHttpSourceStorage(url);
    expect(await s.benchmarks.getById('b-1')).toMatchObject({ id: 'b-1', testCaseIds: ['t-1'] });
    expect(await s.benchmarks.getById('b-missing')).toBeNull();
    expect(await s.testCases.getById('t-1')).toMatchObject({ id: 't-1' });
    expect(await s.testCases.getById('t-missing')).toBeNull();
    await expect(s.testCases.getById('t-500')).rejects.toMatchObject({ name: 'StorageApiError', status: 500, message: 'storage exploded' });
    expect(await s.testCases.getById('t 1/x').catch((e: StorageApiError) => e.status)).toBeNull();
    expect(calls.at(-1)!.path).toBe('/api/storage/test-cases/t%201%2Fx');
  });

  it('getAll / search list without the bundled demo cases and apply the adapters\' label (ANY) semantics + pagination client-side', async () => {
    routes['GET /api/storage/test-cases'] = () => ({ status: 200, body: { testCases: [tc('a', { labels: ['x', 'y'] }), tc('b', { labels: ['y'] }), tc('c', { labels: ['z'] })], total: 3 } });
    const s = createHttpSourceStorage(url);
    const all = await s.testCases.getAll({ size: 10_000 });
    expect(all.total).toBe(3);
    expect(all.items.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(calls[0].path).toBe('/api/storage/test-cases?includeSample=false');
    const byLabel = await s.testCases.search({ labels: ['x', 'z'] });
    expect(byLabel.items.map((t) => t.id)).toEqual(['a', 'c']);
    const page = await s.testCases.search({ labels: ['y'] }, { from: 1, size: 1 });
    expect(page).toEqual({ items: [expect.objectContaining({ id: 'b' })], total: 2 });
  });

  it('create POSTs the definition; bulkUpsert POSTs { testCases } to /bulk and normalises the counts', async () => {
    routes['POST /api/storage/test-cases'] = (c) => ({ status: 201, body: { ...c.body, id: 't-new' } });
    routes['POST /api/storage/test-cases/bulk'] = (c) => ({ status: 200, body: { created: 1, errors: 0, testCases: c.body.testCases.map((t: any, i: number) => ({ ...t, id: `t-${i}` })) } });
    const s = createHttpSourceStorage(url);
    expect(await s.testCases.create({ name: 'n', initialPrompt: 'p' })).toMatchObject({ id: 't-new', name: 'n' });
    const up = await s.testCases.bulkUpsert([{ name: 'a', sourceFile: 'x.eval.js' }, { name: 'b', sourceFile: 'x.eval.js' }]);
    expect(up).toEqual({ created: 1, updated: 0, unchanged: 0, testCases: [expect.objectContaining({ id: 't-0' }), expect.objectContaining({ id: 't-1' })] });
    expect(calls[1].body).toEqual({ testCases: [{ name: 'a', sourceFile: 'x.eval.js' }, { name: 'b', sourceFile: 'x.eval.js' }] });
  });
});

describe('filterTestCases', () => {
  const items = [tc('a', { labels: ['x'], category: 'A', isPromoted: true, description: 'Hello World' }), tc('b', { labels: ['y'], difficulty: 'Hard' })] as any[];
  it('matches any label, exact category / difficulty / isPromoted, and case-insensitive text', () => {
    expect(filterTestCases(items, { labels: ['y'] }).map((t) => t.id)).toEqual(['b']);
    expect(filterTestCases(items, { category: 'A' }).map((t) => t.id)).toEqual(['a']);
    expect(filterTestCases(items, { difficulty: 'Hard' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTestCases(items, { isPromoted: true }).map((t) => t.id)).toEqual(['a']);
    expect(filterTestCases(items, { textSearch: 'hello' }).map((t) => t.id)).toEqual(['a']);
    expect(filterTestCases(items, {})).toHaveLength(2);
  });
});
