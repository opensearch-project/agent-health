/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RunSink` over HTTP — the client side of `/api/runs/ingest/*`
 * (server/routes/runsIngest.ts). One request per sink call; the executor
 * token minted by `createRun` is remembered and sent on every later call,
 * with the lease generation it opened; a `409 lease-lost` answer surfaces as
 * `LeaseLostError` (lib/runLease.ts) so the executor can stop.
 *
 * Deliberately minimal: no retry, no on-disk spool, no server re-discovery.
 * Those belong to the CLI executor that will use this sink (#612) and are
 * specified there; this class only proves the contract — the same
 * contract suite runs against `LocalRunSink` and this class.
 */

import type { EvaluationReport, EvaluationRun } from '@/types';
import type { EvaluationRunResultEntry } from '@/server/adapters/types';
import { LeaseLostError, type LeaseLostInfo } from '@/lib/runLease';
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

export interface HttpRunSinkOptions {
  /** Executor token to resume with (e.g. after a process restart). */
  executorToken?: string;
  /** Lease generation to resume with (default 1, the generation `createRun` opens). */
  leaseGeneration?: number;
  /** Version reported as the executor's (`executor.version` on the run). */
  executorVersion?: string;
  fetch?: typeof fetch;
}

export class HttpRunSink implements RunSink {
  private executorToken: string | undefined;
  private leaseGeneration: number;
  private readonly executorVersion: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(serverUrl: string, options: HttpRunSinkOptions = {}) {
    this.base = `${serverUrl.replace(/\/$/, '')}/api/runs/ingest`;
    this.executorToken = options.executorToken;
    this.leaseGeneration = options.leaseGeneration ?? 1;
    this.executorVersion = options.executorVersion;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The token `createRun` minted (undefined before the first call). */
  get token(): string | undefined {
    return this.executorToken;
  }

  private async call<T>(method: string, path: string, body: unknown, withToken = true): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (withToken) {
      if (!this.executorToken) throw new HttpRunSinkError(0, 'HttpRunSink: createRun() must succeed before other calls');
      headers[EXECUTOR_TOKEN_HEADER] = this.executorToken;
      headers[LEASE_GENERATION_HEADER] = String(this.leaseGeneration);
    }
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: JSON.stringify(body) });
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      if (res.status === 409 && json?.error === 'lease-lost') throw new LeaseLostError(json as LeaseLostInfo);
      throw new HttpRunSinkError(res.status, json?.error ?? `${method} ${path} failed with HTTP ${res.status}`);
    }
    return json as T;
  }

  async createRun(run: EvaluationRun): Promise<CreatedRun> {
    const created = await this.call<CreatedRun>('POST', '', { run, executor: { version: this.executorVersion } }, false);
    this.executorToken = created.executorToken;
    this.leaseGeneration = created.lease?.generation ?? 1;
    // Mirror what the server stamped so the caller's run matches the document.
    run.executor = { id: created.executorToken, kind: 'cli', version: this.executorVersion ?? 'unknown' };
    run.lease = created.lease;
    run.status = 'running';
    return created;
  }

  upsertCaseReport(input: UpsertCaseReportInput): Promise<UpsertCaseReportResult> {
    const { runId, testCaseId, attempt, reportId, report } = input;
    return this.call('PUT', `/${enc(runId)}/cases/${enc(testCaseId)}/report`, { attempt, reportId, report });
  }

  async patchCaseReport(runId: string, reportId: string, patch: Partial<EvaluationReport>): Promise<void> {
    await this.call('PATCH', `/${enc(runId)}/reports/${enc(reportId)}`, { patch });
  }

  setCaseResult(runId: string, testCaseId: string, result: EvaluationRunResultEntry): Promise<LeaseEcho> {
    return this.call('PATCH', `/${enc(runId)}/cases/${enc(testCaseId)}/result`, { result });
  }

  heartbeat(runId: string, progress: RunHeartbeat): Promise<LeaseEcho> {
    return this.call('POST', `/${enc(runId)}/heartbeat`, progress);
  }

  finalize(runId: string, input: FinalizeInput): Promise<EvaluationRun> {
    return this.call('POST', `/${enc(runId)}/finalize`, input);
  }
}

const enc = encodeURIComponent;

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}
