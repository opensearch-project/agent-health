/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore } from '@/server/adapters/file/TraceStore';
import type { Span } from '@/types';

function span(over: Partial<Span>): Span {
  return {
    traceId: 't1',
    spanId: 's1',
    name: 'span',
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    status: 'OK',
    attributes: {},
    ...over,
  };
}

describe('TraceStore', () => {
  let dir: string;
  let store: TraceStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracestore-'));
    store = new TraceStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes fallback spans as canonical NDJSON grouped by traceId', async () => {
    await store.writeSpans([
      span({ traceId: 'tA', spanId: 'a1' }),
      span({ traceId: 'tA', spanId: 'a2' }),
      span({ traceId: 'tB', spanId: 'b1' }),
    ]);
    const ids = (await store.listTraceIds()).sort();
    expect(ids).toEqual(['tA', 'tB']);
    expect(await store.readTrace('tA')).toHaveLength(2);
    expect(await store.readTrace('tB')).toHaveLength(1);
  });

  it('merges/dedupes by spanId across writes (newest wins)', async () => {
    await store.writeSpans([span({ traceId: 'tA', spanId: 'a1', name: 'first' })]);
    await store.writeSpans([
      span({ traceId: 'tA', spanId: 'a1', name: 'updated' }),
      span({ traceId: 'tA', spanId: 'a2', name: 'new' }),
    ]);
    const spans = await store.readTrace('tA');
    expect(spans).toHaveLength(2);
    expect(spans.find((s) => s.spanId === 'a1')!.name).toBe('updated');
  });

  it('readAll flattens spans across all trace files', async () => {
    await store.writeSpans([span({ traceId: 'tA', spanId: 'a1' }), span({ traceId: 'tB', spanId: 'b1' })]);
    expect(await store.readAll()).toHaveLength(2);
  });

  it('returns [] for unknown trace / empty dir', async () => {
    expect(await store.readTrace('nope')).toEqual([]);
    expect(await store.readAll()).toEqual([]);
    expect(await store.listTraceIds()).toEqual([]);
  });

  it('bounds filenames for unusual/overlong trace ids (sha256 hash)', async () => {
    const weirdId = 'x'.repeat(5000) + '/../../etc/passwd'; // overlong + unsafe chars
    await store.writeSpans([span({ traceId: weirdId, spanId: 's1' })]);
    expect(await store.readTrace(weirdId)).toHaveLength(1); // round-trips via the same hash
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^trace-[0-9a-f]{64}\.ndjson$/); // bounded sha256 hex filename
  });

  it('stores one flat, judge-consumable line per span and exposes its exact canonical file', async () => {
    const stored = span({
      traceId: 'trace-flat',
      spanId: 'flat-1',
      kind: 3,
      duration: 42,
      attributes: {
        'session.id': 'session-flat',
        'service.name': 'pi-agent',
        'gen_ai.tool.name': 'read',
        'agent_health.run.id': 'run-flat',
        ignored: 'not-hoisted',
      },
    });
    await store.writeSpans([stored]);

    const files = await store.canonicalFilesForSpans([stored]);
    expect(files).toHaveLength(1);
    expect(path.basename(files[0])).toBe('run-run-flat.ndjson');
    const lines = (await fs.readFile(files[0], 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toEqual(expect.objectContaining({
      spanId: 'flat-1', kind: 3, durationMs: 42,
      'service.name': 'pi-agent', 'session.id': 'session-flat',
      'gen_ai.tool.name': 'read', 'agent_health.run.id': 'run-flat',
    }));
    expect(record.ignored).toBeUndefined();
    expect(record.raw.attributes.ignored).toBe('not-hoisted');
  });

  it('groups multiple traces sharing session.id in one canonical session file', async () => {
    await store.writeSpans([
      span({ traceId: 'tA', spanId: 'a1', attributes: { 'session.id': 'session-1' } }),
      span({ traceId: 'tB', spanId: 'b1', attributes: { 'session.id': 'session-1' } }),
    ]);
    const files = await fs.readdir(dir);
    expect(files).toEqual(['session-session-1.ndjson']);
    expect(await store.readTrace('tA')).toHaveLength(1);
    expect(await store.listTraceIds()).toEqual(expect.arrayContaining(['tA', 'tB']));
  });

  it('skips spans without a spanId (avoid silent dedupe collisions)', async () => {
    await store.writeSpans([
      span({ traceId: 'tZ', spanId: '' }),
      span({ traceId: 'tZ', spanId: 'z1' }),
    ]);
    const spans = await store.readTrace('tZ');
    expect(spans.map((s) => s.spanId)).toEqual(['z1']);
  });

  it('keeps data forever (no eviction across many writes)', async () => {
    for (let i = 0; i < 25; i++) {
      await store.writeSpans([span({ traceId: `t${i}`, spanId: `s${i}` })]);
    }
    expect(await store.listTraceIds()).toHaveLength(25);
  });

  it('honors AGENT_HEALTH_DATA_DIR when no baseDir is passed', async () => {
    const prev = process.env.AGENT_HEALTH_DATA_DIR;
    process.env.AGENT_HEALTH_DATA_DIR = dir;
    try {
      const s2 = new TraceStore();
      await s2.writeSpans([span({ traceId: 'env', spanId: 'e1' })]);
      expect(await s2.readTrace('env')).toHaveLength(1);
      expect(s2.directory).toBe(path.join(dir, 'traces'));
    } finally {
      if (prev === undefined) delete process.env.AGENT_HEALTH_DATA_DIR;
      else process.env.AGENT_HEALTH_DATA_DIR = prev;
    }
  });
});
