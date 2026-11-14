/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RunSink` over HTTP — the client side of `/api/runs/ingest/*`
 * (server/routes/runsIngest.ts). One request per sink call; the executor
 * token minted by `createRun` is remembered and sent on every later call.
 *
 * Deliberately minimal: no retry, no on-disk spool, no server re-discovery.
 * Those belong to the CLI executor that will use this sink (#612) and are
 * specified there; this class only proves the contract — the same
 * contract suite runs against `LocalRunSink` and this class.
 */

import type { EvaluationReport, EvaluationRun } from '@/types';
import type { EvaluationRunResultEntry } from '@/server/adapters/types';
import {
  EXECUTOR_TOKEN_HEADER,
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
  fetch?: typeof fetch;
}

export class HttpRunSink implements RunSink {
  private executorToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(serverUrl: string, options: HttpRunSinkOptions = {}) {
    this.base = `${serverUrl.replace(/\/$/, '')}/api/runs/ingest`;
    this.executorToken = options.executorToken;
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
    }
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: JSON.stringify(body) });
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new HttpRunSinkError(res.status, json?.error ?? `${method} ${path} failed with HTTP ${res.status}`);
    }
    return json as T;
  }

  async createRun(run: EvaluationRun): Promise<{ runId: string; executorToken: string }> {
    const created = await this.call<{ runId: string; executorToken: string }>('POST', '', { run }, false);
    this.executorToken = created.executorToken;
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
