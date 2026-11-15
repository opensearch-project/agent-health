/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RunSink` over HTTP — the client side of `/api/runs/ingest/*`
 * (server/routes/runsIngest.ts). The executor token minted by `createRun` is
 * remembered and sent on every later call, with the lease generation it
 * opened; a `409 lease-lost` answer surfaces as `LeaseLostError`
 * (lib/runLease.ts) so the executor can stop.
 *
 * Delivery guarantees (#612 step 3, design §3) — RETRY UNTIL CONFIRMED:
 *
 *   - Every result-bearing mutation (`createRun`, report upserts/patches,
 *     case results, `finalize`) is appended to an on-disk spool
 *     (`<spoolDir>/<runId>.ndjson`) BEFORE it is sent, then retried with
 *     exponential backoff (1 s → 30 s) on transport failures and 5xx answers
 *     until the lease TTL has elapsed — beyond it the run is lost anyway (the
 *     sweeper has fenced this executor out). Every mutation is idempotent on
 *     the server (client-minted run/report ids, merge semantics, finalize
 *     recomputes from the persisted document), so a retry after a lost
 *     response can never duplicate anything.
 *   - On `ECONNREFUSED` the sink asks `rediscover()` where the server now
 *     lives (a restarted server; today that re-probes the same port — the
 *     per-project server record is step 4) and continues against that URL.
 *   - 4xx answers are never retried: they are the server telling the
 *     executor something about ITS request (lease lost, bad body).
 *   - Heartbeats are liveness, not results: one attempt each, never spooled;
 *     the runner keeps at most one beat in flight and simply beats again.
 *   - A confirmed `finalize` removes the spool; a delivery that exhausts its
 *     budget throws `RunDeliveryError` naming the spool path, so the CLI can
 *     exit 1 and tell the user exactly what was not recorded.
 */

import { appendFileSync, mkdirSync, rmSync } from 'fs';
import * as path from 'path';
import type { EvaluationReport, EvaluationRun } from '@/types';
import type { EvaluationRunResultEntry } from '@/server/adapters/types';
import { LeaseLostError, resolveLeaseTtlMs, type LeaseLostInfo } from '@/lib/runLease';
import {
  EXECUTOR_TOKEN_HEADER,
  LEASE_GENERATION_HEADER,
  type CreatedRun,
  type FinalizeInput,
  type LeaseEcho,
  type RunHeartbeat,
  type RunSink,
  type UpsertCaseReportInput,
  type UpsertCaseReportResult,
} from './runSink';

export class HttpRunSinkError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpRunSinkError';
  }
}

/** A mutation could not be confirmed within its delivery budget. */
export class RunDeliveryError extends Error {
  constructor(
    public readonly operation: string,
    public readonly attempts: number,
    public readonly lastError: string,
    public readonly spoolPath: string | undefined,
    elapsedMs: number,
  ) {
    super(`${operation} could not be delivered to the server within ${Math.round(elapsedMs / 1000)}s (${attempts} attempt${attempts === 1 ? '' : 's'}; last error: ${lastError})`
      + (spoolPath ? `; the unconfirmed writes are spooled at ${spoolPath}` : ''));
    this.name = 'RunDeliveryError';
  }
}

export interface HttpRunSinkDelivery {
  /**
   * Retry budget per mutation, from its first attempt. Default: the run's
   * lease TTL once `createRun` has opened it (`AH_RUN_LEASE_TTL_MS` before).
   */
  deadlineMs?: number;
  /** First backoff (default 1 s), doubling up to `maxDelayMs` (default 30 s). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Directory of the per-run spool file; no spool when omitted. */
  spoolDir?: string;
  /** Where the server is now, asked on connection refused. `undefined` = unchanged. */
  rediscover?: () => Promise<string | undefined>;
  /** Observes each retry (the CLI prints these). */
  onRetry?: (info: { operation: string; attempt: number; delayMs: number; error: string; serverUrl: string }) => void;
  /** Injectable clock + sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpRunSinkOptions {
  /** Executor token to resume with (e.g. after a process restart). */
  executorToken?: string;
  /** Lease generation to resume with (default 1, the generation `createRun` opens). */
  leaseGeneration?: number;
  /** Version reported as the executor's (`executor.version` on the run). */
  executorVersion?: string;
  fetch?: typeof fetch;
  /** Retry / spool / re-discovery behaviour. Omitted = single attempt, no spool (contract tests). */
  delivery?: HttpRunSinkDelivery;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Classify a thrown fetch error: is it a transport failure worth retrying, and was the connection refused? */
export function classifyTransportError(error: unknown): { transient: boolean; refused: boolean } {
  const codes = new Set<string>();
  let cursor: any = error;
  for (let depth = 0; cursor && depth < 5; depth++) {
    if (typeof cursor.code === 'string') codes.add(cursor.code);
    if (Array.isArray(cursor.errors)) for (const e of cursor.errors) if (typeof e?.code === 'string') codes.add(e.code);
    cursor = cursor.cause;
  }
  const message = error instanceof Error ? error.message : String(error);
  const refused = codes.has('ECONNREFUSED') || /ECONNREFUSED/.test(message);
  const transient = refused
    || ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNABORTED'].some((c) => codes.has(c))
    || /fetch failed|socket hang up|network|other side closed|terminated/i.test(message);
  return { transient, refused };
}

export class HttpRunSink implements RunSink {
  private executorToken: string | undefined;
  private leaseGeneration: number;
  private leaseTtlMs: number | undefined;
  private readonly executorVersion: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private serverUrl: string;
  private readonly delivery: HttpRunSinkDelivery | undefined;
  private spoolPath: string | undefined;

  constructor(serverUrl: string, options: HttpRunSinkOptions = {}) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.executorToken = options.executorToken;
    this.leaseGeneration = options.leaseGeneration ?? 1;
    this.executorVersion = options.executorVersion;
    this.fetchImpl = options.fetch ?? fetch;
    this.delivery = options.delivery;
  }

  /** The token `createRun` minted (undefined before the first call). */
  get token(): string | undefined {
    return this.executorToken;
  }

  /** The server URL currently in use (changes after a successful re-discovery). */
  get currentServerUrl(): string {
    return this.serverUrl;
  }

  /** Path of this run's spool file, once `createRun` has named the run (and a spool dir is configured). */
  get spoolFile(): string | undefined {
    return this.spoolPath;
  }

  private get base(): string {
    return `${this.serverUrl}/api/runs/ingest`;
  }

  /** One HTTP round-trip; throws `HttpRunSinkError` / `LeaseLostError` on non-2xx. */
  private async once<T>(method: string, pathSuffix: string, body: unknown, withToken: boolean): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (withToken) {
      if (!this.executorToken) throw new HttpRunSinkError(0, 'HttpRunSink: createRun() must succeed before other calls');
      headers[EXECUTOR_TOKEN_HEADER] = this.executorToken;
      headers[LEASE_GENERATION_HEADER] = String(this.leaseGeneration);
    }
    const res = await this.fetchImpl(`${this.base}${pathSuffix}`, { method, headers, body: JSON.stringify(body) });
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      if (res.status === 409 && json?.error === 'lease-lost') throw new LeaseLostError(json as LeaseLostInfo);
      throw new HttpRunSinkError(res.status, json?.error ?? `${method} ${pathSuffix} failed with HTTP ${res.status}`);
    }
    return json as T;
  }

  /**
   * Retry-until-confirmed around `once`. Transport failures and 5xx answers
   * are retried with exponential backoff until the delivery deadline; 4xx
   * answers (including lease-lost) propagate immediately.
   */
  private async call<T>(operation: string, method: string, pathSuffix: string, body: unknown, withToken = true, retry = true): Promise<T> {
    const d = this.delivery;
    if (!d || !retry) {
      try {
        return await this.once<T>(method, pathSuffix, body, withToken);
      } catch (error) {
        if (d?.rediscover && classifyTransportError(error).refused) await this.rediscover();
        throw error;
      }
    }
    const now = d.now ?? Date.now;
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadlineMs = d.deadlineMs ?? this.leaseTtlMs ?? resolveLeaseTtlMs();
    const baseDelay = d.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelay = d.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const started = now();
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.once<T>(method, pathSuffix, body, withToken);
      } catch (error) {
        const retryable = isRetryable(error);
        if (!retryable.retry) throw error;
        const elapsed = now() - started;
        const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        if (elapsed + delay > deadlineMs) {
          throw new RunDeliveryError(operation, attempt, retryable.message, this.spoolPath, elapsed);
        }
        if (retryable.refused) await this.rediscover();
        d.onRetry?.({ operation, attempt, delayMs: delay, error: retryable.message, serverUrl: this.serverUrl });
        await sleep(delay);
      }
    }
  }

  private async rediscover(): Promise<void> {
    if (!this.delivery?.rediscover) return;
    try {
      const next = await this.delivery.rediscover();
      if (next) this.serverUrl = next.replace(/\/$/, '');
    } catch {
      // Keep the current URL; the next attempt will tell.
    }
  }

  /** Append a mutation to the run's spool before sending it (durable record of what was attempted). */
  private spool(runId: string, operation: string, record: unknown): void {
    const dir = this.delivery?.spoolDir;
    if (!dir) return;
    try {
      if (!this.spoolPath) {
        mkdirSync(dir, { recursive: true });
        this.spoolPath = path.join(dir, `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.ndjson`);
      }
      appendFileSync(this.spoolPath, `${JSON.stringify({ at: new Date().toISOString(), op: operation, ...(record as object) })}\n`);
    } catch (error) {
      console.warn(`[HttpRunSink] spool write failed (${operation}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createRun(run: EvaluationRun): Promise<CreatedRun> {
    this.spool(run.id, 'createRun', { runId: run.id });
    const created = await this.call<CreatedRun>('createRun', 'POST', '', { run, executor: { version: this.executorVersion } }, false);
    this.executorToken = created.executorToken;
    this.leaseGeneration = created.lease?.generation ?? 1;
    this.leaseTtlMs = created.lease?.ttlMs;
    // Mirror what the server stamped so the caller's run matches the document.
    run.executor = { id: created.executorToken, kind: 'cli', version: this.executorVersion ?? 'unknown' };
    run.lease = created.lease;
    run.status = 'running';
    return created;
  }

  upsertCaseReport(input: UpsertCaseReportInput): Promise<UpsertCaseReportResult> {
    const { runId, testCaseId, attempt, reportId, report } = input;
    this.spool(runId, 'upsertCaseReport', { testCaseId, reportId, attempt, report });
    return this.call('upsertCaseReport', 'PUT', `/${enc(runId)}/cases/${enc(testCaseId)}/report`, { attempt, reportId, report });
  }

  async patchCaseReport(runId: string, reportId: string, patch: Partial<EvaluationReport>): Promise<void> {
    this.spool(runId, 'patchCaseReport', { reportId, patch });
    await this.call('patchCaseReport', 'PATCH', `/${enc(runId)}/reports/${enc(reportId)}`, { patch });
  }

  setCaseResult(runId: string, testCaseId: string, result: EvaluationRunResultEntry): Promise<LeaseEcho> {
    this.spool(runId, 'setCaseResult', { testCaseId, result });
    return this.call('setCaseResult', 'PATCH', `/${enc(runId)}/cases/${enc(testCaseId)}/result`, { result });
  }

  heartbeat(runId: string, progress: RunHeartbeat): Promise<LeaseEcho> {
    // Liveness only: one attempt, no spool — the runner beats again.
    return this.call('heartbeat', 'POST', `/${enc(runId)}/heartbeat`, progress, true, false);
  }

  async finalize(runId: string, input: FinalizeInput): Promise<EvaluationRun> {
    this.spool(runId, 'finalize', { status: input.status });
    const run = await this.call<EvaluationRun>('finalize', 'POST', `/${enc(runId)}/finalize`, input);
    // Confirmed terminal write: nothing left to deliver.
    if (this.spoolPath) {
      try { rmSync(this.spoolPath, { force: true }); } catch { /* best effort */ }
    }
    return run;
  }
}

/** Retry on transport failures and 5xx; never on 4xx (lease-lost included) or programming errors. */
function isRetryable(error: unknown): { retry: boolean; refused: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof LeaseLostError) return { retry: false, refused: false, message };
  if (error instanceof HttpRunSinkError) return { retry: error.status >= 500, refused: false, message };
  const transport = classifyTransportError(error);
  return { retry: transport.transient, refused: transport.refused, message };
}

const enc = encodeURIComponent;

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}
