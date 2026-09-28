/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed trace store.
 *
 * Persists spans as JSON under `.agent-health/data/traces/{traceId}.json` (one
 * file per trace, an array of that trace's spans). This is the data plane for
 * the file observability backend — runtime data, gitignored, parallel to
 * `.agent-health/data/runs/` etc. (see docs/CONFIGURATION.md → "Where things live").
 *
 * Retention: **keep forever**. Nothing is auto-evicted; customers delete files
 * themselves (and graduate to an OpenSearch observability cluster when local
 * storage grows). Writes are atomic (tmp + rename) and merge/dedupe by spanId.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { Span } from '../../../types/index.js';
import { projectDataDir } from '../../../lib/config/statePaths.js';

/** Resolve the traces data directory (overridable for tests via AGENT_HEALTH_DATA_DIR). */
export function resolveTracesDir(baseDir?: string): string {
  if (baseDir) return baseDir;
  const dataDir = process.env.AGENT_HEALTH_DATA_DIR || projectDataDir();
  return path.join(dataDir, 'traces');
}

/** Keep trace ids to safe, bounded filenames; sha256-hash anything unexpected. */
function safeTraceFile(traceId: string): string {
  const safe = /^[A-Za-z0-9_.-]{1,128}$/.test(traceId)
    ? traceId
    : createHash('sha256').update(traceId).digest('hex');
  return `${safe}.json`;
}

/** Per-file write queue shared by every TraceStore instance in this process. */
const traceFileLocks = new Map<string, Promise<void>>();

async function withTraceFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const previous = traceFileLocks.get(file) ?? Promise.resolve();
  const run = previous.then(fn);
  // The queue tail never rejects, so one failed write cannot wedge the file.
  const tail = run.then(() => undefined, () => undefined);
  traceFileLocks.set(file, tail);
  try {
    return await run;
  } finally {
    if (traceFileLocks.get(file) === tail) traceFileLocks.delete(file);
  }
}

export class TraceStore {
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.dir = resolveTracesDir(baseDir);
  }

  get directory(): string {
    return this.dir;
  }

  private fileFor(traceId: string): string {
    return path.join(this.dir, safeTraceFile(traceId));
  }

  /** Append spans, grouped by traceId, merging+deduping by spanId. Atomic per trace. */
  async writeSpans(spans: Span[]): Promise<void> {
    if (!spans.length) return;
    await fs.mkdir(this.dir, { recursive: true });

    const byTrace = new Map<string, Span[]>();
    for (const s of spans) {
      if (!s.traceId || !s.spanId) continue;
      const arr = byTrace.get(s.traceId) || [];
      arr.push(s);
      byTrace.set(s.traceId, arr);
    }

    for (const [traceId, incoming] of byTrace) {
      // Serialize read-merge-write per trace file (process-wide): the OTLP
      // receiver builds a fresh TraceStore per request, so two concurrent
      // exports into one trace (an agent's spans + our eval span for the
      // same case) would otherwise read the same "existing" set and the
      // second rename would silently drop the first writer's spans.
      await withTraceFileLock(this.fileFor(traceId), async () => {
        const existing = await this.readTrace(traceId);
        const merged = new Map<string, Span>();
        for (const s of existing) if (s.spanId) merged.set(s.spanId, s);
        for (const s of incoming) merged.set(s.spanId, s); // newest wins (incoming ids guaranteed)
        await this.atomicWrite(this.fileFor(traceId), Array.from(merged.values()));
      });
    }
  }

  private async atomicWrite(file: string, data: Span[]): Promise<void> {
    // pid + timestamp alone is NOT unique: two concurrent exports into the
    // same trace within one millisecond (measured: a REST agent's spans and
    // agent-health's own eval spans landing together) minted the same tmp
    // name, one rename consumed it and the other failed with ENOENT — which
    // surfaced to the agent as a 400 from the OTLP receiver and failed the
    // evaluation. A random suffix makes every writer's tmp file its own.
    const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.rename(tmp, file);
  }

  /** Spans for a single trace (empty if unknown). */
  async readTrace(traceId: string): Promise<Span[]> {
    try {
      const raw = await fs.readFile(this.fileFor(traceId), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** All known trace ids. */
  async listTraceIds(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  /** Every stored span across all traces. */
  async readAll(): Promise<Span[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const all: Span[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8'));
        if (Array.isArray(parsed)) all.push(...parsed);
      } catch {
        /* skip corrupt file */
      }
    }
    return all;
  }
}
