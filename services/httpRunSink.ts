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
 *     case results, `finalize`) is appended with its full body to an on-disk
 *     spool (`<spoolDir>/<runId>.ndjson`, mode 0600) BEFORE it is sent, then
 *     retried with exponential backoff (1 s → 30 s) on transport failures,
 *     5xx, 408 and 429 answers while the lease is still alive: the budget is
 *     the time left on the lease since the server last acknowledged a write
 *     (`ttlMs − (now − lastAck)`), because beyond it the sweeper has fenced
 *     this executor out and nothing can be delivered any more. Each attempt
 *     is bounded (`attemptTimeoutMs`, default 30 s) so a stalled socket can
 *     never silently outlive the lease. Every mutation is idempotent on the
 *     server (client-minted run/report ids, merge semantics, finalize
 *     recomputes from the persisted document; a re-POSTed `createRun` after a
 *     lost response re-stamps the lease of the same run document and the
 *     token the client never received is simply superseded), so a retry
 *     after a lost response can never duplicate anything.
 *   - The spool is a durable record of what this executor tried to write,
 *     for the user (and a future replay tool) — there is no automatic replay
 *     today. It is removed after a confirmed `finalize` unless an earlier
 *     write of the run failed for good, in which case it stays with those
 *     failures marked.
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
  mintExecutorToken,
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
   * Upper bound on the retry budget of one mutation. The effective budget is
   * the smaller of this and the lease time left since the server's last
   * acknowledgement. Default: the lease TTL (`AH_RUN_LEASE_TTL_MS` before
   * `createRun` has opened one).
   */
  deadlineMs?: number;
  /** Bound on one HTTP attempt (connect + headers + body); default 30 s, heartbeats 10 s. */
  attemptTimeoutMs?: number;
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
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
const HEARTBEAT_ATTEMPT_TIMEOUT_MS = 10_000;
/** Answers that say "not now" rather than "not that": worth another attempt. */
const RETRYABLE_STATUSES = new Set([408, 429]);

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
    || (error as { name?: string } | undefined)?.name === 'TimeoutError' || (error as { name?: string } | undefined)?.name === 'AbortError'
    || /fetch failed|socket hang up|network|other side closed|terminated|timed out|aborted/i.test(message);
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
  /** Clock reading of the last answer the server gave this executor (any 2xx). */
  private lastAckAt: number | undefined;
  /** Result-bearing writes that failed for good (4xx, exhausted budget) — the spool is kept for them. */
  private failedWrites = 0;

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

  /** Writes this sink could not get the server to accept (kept in the spool). */
  get unconfirmedWrites(): number {
    return this.failedWrites;
  }

  private get base(): string {
    return `${this.serverUrl}/api/runs/ingest`;
  }

  private now(): number {
    return (this.delivery?.now ?? Date.now)();
  }

  /** One bounded HTTP round-trip; throws `HttpRunSinkError` / `LeaseLostError` on non-2xx. */
  private async once<T>(method: string, pathSuffix: string, body: unknown, withToken: boolean, attemptTimeoutMs: number): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (withToken) {
      if (!this.executorToken) throw new HttpRunSinkError(0, 'HttpRunSink: createRun() must succeed before other calls');
      headers[EXECUTOR_TOKEN_HEADER] = this.executorToken;
      headers[LEASE_GENERATION_HEADER] = String(this.leaseGeneration);
    }
    // One signal bounds connect + headers + body: a stalled server can never
    // hold a write (and with it the lease budget) open indefinitely.
    const signal = AbortSignal.timeout(attemptTimeoutMs);
    const res = await this.fetchImpl(`${this.base}${pathSuffix}`, { method, headers, body: JSON.stringify(body), signal });
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      if (res.status === 409 && json?.error === 'lease-lost') throw new LeaseLostError(json as LeaseLostInfo);
      throw new HttpRunSinkError(res.status, json?.error ?? `${method} ${pathSuffix} failed with HTTP ${res.status}`);
    }
    this.lastAckAt = this.now();
    return json as T;
  }

  /** Lease time left since the server last acknowledged this executor (the whole TTL before the first ack). */
  private remainingLeaseMs(): number {
    const ttl = this.leaseTtlMs ?? resolveLeaseTtlMs();
    if (this.lastAckAt === undefined) return ttl;
    return Math.max(0, ttl - (this.now() - this.lastAckAt));
  }

  /**
   * Retry-until-confirmed around `once`. Transport failures, 5xx, 408 and
   * 429 answers are retried with exponential backoff while the lease is
   * alive; other 4xx (lease-lost included) propagate immediately. A write
   * that cannot be confirmed is counted so the spool is kept for it.
   */
  private async call<T>(operation: string, method: string, pathSuffix: string, body: unknown, withToken = true, retry = true): Promise<T> {
    const d = this.delivery;
    const attemptTimeout = d?.attemptTimeoutMs ?? (retry ? DEFAULT_ATTEMPT_TIMEOUT_MS : HEARTBEAT_ATTEMPT_TIMEOUT_MS);
    if (!d || !retry) {
      try {
        return await this.once<T>(method, pathSuffix, body, withToken, attemptTimeout);
      } catch (error) {
        if (d?.rediscover && classifyTransportError(error).refused) await this.rediscover();
        throw error;
      }
    }
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const baseDelay = d.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelay = d.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const started = this.now();
    const budgetMs = Math.min(d.deadlineMs ?? Number.POSITIVE_INFINITY, this.remainingLeaseMs());
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.once<T>(method, pathSuffix, body, withToken, attemptTimeout);
      } catch (error) {
        const retryable = isRetryable(error);
        if (!retryable.retry) {
          this.failedWrites++;
          throw error;
        }
        const elapsed = this.now() - started;
        const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        if (elapsed + delay > budgetMs) {
          this.failedWrites++;
          throw new RunDeliveryError(operation, attempt, retryable.message, this.spoolPath, elapsed);
        }
        if (retryable.refused) await this.rediscover();
        try {
          d.onRetry?.({ operation, attempt, delayMs: delay, error: retryable.message, serverUrl: this.serverUrl });
        } catch {
          // An observer must never decide whether a write is delivered.
        }
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

  /**
   * Append a mutation (full body) to the run's spool before sending it — a
   * durable record of what this executor tried to write. Owner-only file:
   * reports carry prompts, trajectories and model output.
   */
  private spool(runId: string, operation: string, record: unknown): void {
    const dir = this.delivery?.spoolDir;
    if (!dir) return;
    try {
      if (!this.spoolPath) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.spoolPath = path.join(dir, `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.ndjson`);
      }
      appendFileSync(this.spoolPath, `${JSON.stringify({ at: new Date().toISOString(), op: operation, ...(record as object) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[HttpRunSink] spool write failed (${operation}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createRun(run: EvaluationRun): Promise<CreatedRun> {
    // The token is minted HERE and sent with the create, so a retried create
    // (lost answer) is recognised by the server as this same executor and
    // handed the lease it already opened — never a second lease, never a
    // take-over of someone else's run (409 `run-exists`).
    this.executorToken = this.executorToken ?? mintExecutorToken();
    this.spool(run.id, 'createRun', { run, executorVersion: this.executorVersion, executorToken: this.executorToken });
    const created = await this.call<CreatedRun>('createRun', 'POST', '', { run, executor: { version: this.executorVersion } }, true);
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
    this.spool(runId, 'finalize', { input });
    const run = await this.call<EvaluationRun>('finalize', 'POST', `/${enc(runId)}/finalize`, input);
    // Confirmed terminal write: nothing left to deliver — unless an earlier
    // write of this run was refused for good; then the spool is the only
    // record of it and stays, marked.
    if (this.spoolPath) {
      if (this.failedWrites === 0) {
        try { rmSync(this.spoolPath, { force: true }); } catch { /* best effort */ }
      } else {
        this.spool(runId, 'finalize-confirmed', { unconfirmedWrites: this.failedWrites });
      }
    }
    return run;
  }
}

/** Retry on transport failures, 5xx, 408, 429; never on other 4xx (lease-lost included) or programming errors. */
function isRetryable(error: unknown): { retry: boolean; refused: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof LeaseLostError) return { retry: false, refused: false, message };
  if (error instanceof HttpRunSinkError) return { retry: error.status >= 500 || RETRYABLE_STATUSES.has(error.status), refused: false, message };
  const transport = classifyTransportError(error);
  return { retry: transport.transient, refused: transport.refused, message };
}

const enc = encodeURIComponent;

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}
