/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed trace store.
 *
 * Persists judge-consumable NDJSON under `.agent-health/data/traces/`, one
 * canonical file per correlation bucket. A bucket is selected from the first
 * stable run identity available on a span (`agent_health.run.id`,
 * `gen_ai.conversation.id`, `session.id`), with `traceId` as the fallback.
 * Each line is a lightly flattened span plus `raw`, which lets the existing
 * traces UI/API recover the complete internal Span without a second store.
 *
 * Retention: **keep forever**. Writes are atomic (tmp + rename) and merge/dedupe
 * by traceId+spanId. The former `{traceId}.json` array layout is intentionally
 * not read: local trace data is runtime state and no migration is required.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Span } from '../../../types/index.js';
import { projectDataDir } from '../../../lib/config/statePaths.js';

/** Resolve the traces data directory (overridable for tests via AGENT_HEALTH_DATA_DIR). */
export function resolveTracesDir(baseDir?: string): string {
  if (baseDir) return baseDir;
  const dataDir = process.env.AGENT_HEALTH_DATA_DIR || projectDataDir();
  return path.join(dataDir, 'traces');
}

type CorrelationKind = 'run' | 'conversation' | 'session' | 'trace';
type Correlation = { kind: CorrelationKind; value: string };

/** The line format is intentionally useful to jq without first unpacking raw. */
export interface CanonicalSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: Span['kind'];
  startTime: string;
  endTime: string;
  durationMs?: number;
  status: Span['status'];
  'service.name'?: unknown;
  'session.id'?: unknown;
  [attribute: `gen_ai.${string}`]: unknown;
  [attribute: `agent_health.${string}`]: unknown;
  raw: Span;
}

function correlationForSpan(span: Span): Correlation {
  const attributes = span.attributes || {};
  const candidates: Array<[CorrelationKind, unknown]> = [
    ['run', attributes['agent_health.run.id']],
    ['conversation', attributes['gen_ai.conversation.id']],
    ['session', attributes['session.id']],
  ];
  for (const [kind, value] of candidates) {
    if (typeof value === 'string' && value.length > 0) return { kind, value };
  }
  return { kind: 'trace', value: span.traceId };
}

/** Keep correlation values to safe, bounded filenames; hash anything unexpected. */
function safeCorrelationFile({ kind, value }: Correlation): string {
  if (/^[A-Za-z0-9_.-]{1,120}$/.test(value)) return `${kind}-${value}.ndjson`;
  return `${kind}-${createHash('sha256').update(`${kind}:${value}`).digest('hex')}.ndjson`;
}

function toCanonicalRecord(span: Span): CanonicalSpanRecord {
  const attributes = span.attributes || {};
  const hoisted = Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => key.startsWith('gen_ai.') || key.startsWith('agent_health.'))
      .sort(([a], [b]) => a.localeCompare(b))
  );
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    ...(span.kind !== undefined ? { kind: span.kind } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    ...(span.duration !== undefined ? { durationMs: span.duration } : {}),
    status: span.status,
    ...(attributes['service.name'] !== undefined ? { 'service.name': attributes['service.name'] } : {}),
    ...(attributes['session.id'] !== undefined ? { 'session.id': attributes['session.id'] } : {}),
    ...hoisted,
    raw: span,
  } as CanonicalSpanRecord;
}

function fromCanonicalRecord(record: any): Span | undefined {
  if (record?.raw && typeof record.raw === 'object' && record.raw.traceId && record.raw.spanId) {
    return record.raw as Span;
  }
  if (!record?.traceId || !record?.spanId) return undefined;
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'service.name' || key === 'session.id' || key.startsWith('gen_ai.') || key.startsWith('agent_health.')) {
      attributes[key] = value;
    }
  }
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
    name: record.name || '',
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    startTime: record.startTime,
    endTime: record.endTime,
    ...(record.durationMs !== undefined ? { duration: record.durationMs } : {}),
    status: record.status || 'UNSET',
    attributes,
  };
}

export class TraceStore {
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.dir = resolveTracesDir(baseDir);
  }

  get directory(): string {
    return this.dir;
  }

  private fileForSpan(span: Span): string {
    return path.join(this.dir, safeCorrelationFile(correlationForSpan(span)));
  }

  private async canonicalFiles(): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir))
        .filter((file) => file.endsWith('.ndjson'))
        .sort()
        .map((file) => path.join(this.dir, file));
    } catch {
      return [];
    }
  }

  private async readRecords(file: string): Promise<CanonicalSpanRecord[]> {
    try {
      return (await fs.readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line) as CanonicalSpanRecord]; }
          catch { return []; }
        });
    } catch {
      return [];
    }
  }

  /** Append spans by stable run/session/trace bucket, newest duplicate wins. */
  async writeSpans(spans: Span[]): Promise<void> {
    if (!spans.length) return;
    await fs.mkdir(this.dir, { recursive: true });

    const byFile = new Map<string, Span[]>();
    for (const span of spans) {
      if (!span.traceId || !span.spanId) continue;
      const file = this.fileForSpan(span);
      const entries = byFile.get(file) || [];
      entries.push(span);
      byFile.set(file, entries);
    }

    for (const [file, incoming] of byFile) {
      const merged = new Map<string, CanonicalSpanRecord>();
      for (const record of await this.readRecords(file)) {
        if (record.traceId && record.spanId) merged.set(`${record.traceId}:${record.spanId}`, record);
      }
      for (const span of incoming) merged.set(`${span.traceId}:${span.spanId}`, toCanonicalRecord(span));
      await this.atomicWrite(file, Array.from(merged.values()));
    }
  }

  private async atomicWrite(file: string, records: CanonicalSpanRecord[]): Promise<void> {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const data = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  }

  /** Spans for a single trace (empty if unknown). */
  async readTrace(traceId: string): Promise<Span[]> {
    return (await this.readAll()).filter((span) => span.traceId === traceId);
  }

  /** All known trace ids. */
  async listTraceIds(): Promise<string[]> {
    return [...new Set((await this.readAll()).map((span) => span.traceId))];
  }

  /** Every stored span across all canonical files, deduped across buckets. */
  async readAll(): Promise<Span[]> {
    const spans = new Map<string, Span>();
    for (const file of await this.canonicalFiles()) {
      for (const record of await this.readRecords(file)) {
        const span = fromCanonicalRecord(record);
        if (span) spans.set(`${span.traceId}:${span.spanId}`, span);
      }
    }
    return [...spans.values()];
  }

  /**
   * Resolve exactly the canonical files backing already-correlated spans.
   * Returned paths are real regular files inside this store and are suitable
   * for an explicit RestrictedBash read-only mount; siblings are not exposed.
   */
  async canonicalFilesForSpans(spans: Span[]): Promise<string[]> {
    const dirReal = await fs.realpath(this.dir).catch(() => undefined);
    if (!dirReal) return [];
    const out = new Set<string>();
    for (const span of spans) {
      const candidate = this.fileForSpan(span);
      const stat = await fs.lstat(candidate).catch(() => undefined);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const real = await fs.realpath(candidate);
      if (real === dirReal || !real.startsWith(dirReal + path.sep)) continue;
      out.add(real);
    }
    return [...out].sort();
  }
}
