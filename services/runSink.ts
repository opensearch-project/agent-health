/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunSink — the ONLY channel through which an evaluation-run executor writes
 * its results.
 *
 * `executeEvaluationRun` (services/evaluationRunner.ts) is write-only towards
 * storage: it creates/updates per-case report docs, records each case's
 * verdict on the run doc and, at the end, finalizes the run. It never reads
 * storage. That makes the storage boundary a small, explicit interface
 * instead of the whole `IStorageModule`, and lets the SAME runner persist
 * through different transports:
 *
 *   - `LocalRunSink`  — server-executed runs (UI "Run", `/evaluation-runs`,
 *                       re-run). Wraps the server's `IStorageModule`; the
 *                       persisted documents are identical to what the runner
 *                       wrote directly before this seam existed.
 *   - `HttpRunSink`   — an executor in another process (the CLI, see #612)
 *                       talking to `/api/runs/ingest/*`, which is itself a
 *                       thin wrapper over `LocalRunSink`.
 *
 * Every mutation is idempotent: report writes are keyed by a CLIENT-minted
 * `reportId`, so a retried request after a lost response cannot create a
 * duplicate document.
 */

import type { EvaluationReport, EvaluationRun, BenchmarkRun, BenchmarkRunStatus } from '@/types';
import type { IStorageModule, EvaluationRunResultEntry } from '@/server/adapters/types';
import { finalizeEvaluationRun, type FinalRunStatus } from './evaluationRunFinalize';

/** Progress a heartbeat carries. Advisory in this version (no leases yet). */
export interface RunHeartbeat {
  startedCount: number;
  completedCount: number;
  totalTestCases: number;
}

/**
 * What the sink tells the executor on every heartbeat / case result. Reserved
 * for lease fencing (`generation`, `cancelRequestedAt`); today always
 * `{ generation: 0 }`.
 */
export interface LeaseEcho {
  generation: number;
  cancelRequestedAt?: string;
}

export interface UpsertCaseReportInput {
  runId: string;
  testCaseId: string;
  /** 1 for the first execution of a case within a run; reserved for retries. */
  attempt: number;
  /** Client-minted id of the report document (stable across retries). */
  reportId: string;
  /**
   * Full report on first write (the `running` placeholder) or the fields to
   * merge into the existing document (the final report). Merge semantics are
   * the storage adapter's `runs.update`: `{ ...existing, ...report, id }`.
   */
  report: Partial<EvaluationReport>;
}

export interface UpsertCaseReportResult {
  reportId: string;
  /** The persisted document after the write (what `runs.update` returns). */
  report: EvaluationReport;
}

/** Terminal input for a run that ran to completion or was cancelled. */
export interface FinalizeCompletedInput {
  status: FinalRunStatus;
  /** The runner's in-memory run at completion (results, stats, judge identity). */
  completedRun: Pick<EvaluationRun, 'results' | 'testCaseSnapshots'> &
    Partial<Pick<EvaluationRun, 'judgeFailureSummary' | 'judgeModel' | 'judgeProvider'>>;
  completedAt?: string;
  /** When set, the terminal projection is linked into this benchmark's `runs[]`. */
  benchmarkId?: string;
}

/** Terminal input for a run whose executor crashed before completion. */
export interface FinalizeFailedInput {
  status: 'failed';
  error: string;
  completedAt?: string;
}

export type FinalizeInput = FinalizeCompletedInput | FinalizeFailedInput;

export interface RunSink {
  /** Persist the run document. Returns the executor token the run is bound to. */
  createRun(run: EvaluationRun): Promise<{ runId: string; executorToken: string }>;
  /** Create-or-merge a case's report document, keyed by the client-minted `reportId`. */
  upsertCaseReport(input: UpsertCaseReportInput): Promise<UpsertCaseReportResult>;
  /** Partial update of an existing report (trace-judged verdict, evaluator-error patch). */
  patchCaseReport(runId: string, reportId: string, patch: Partial<EvaluationReport>): Promise<void>;
  /** Record one case's verdict on the run document (atomic per-key merge). */
  setCaseResult(runId: string, testCaseId: string, result: EvaluationRunResultEntry): Promise<LeaseEcho>;
  /** Liveness + progress. No-op for storage today; reserved for leases. */
  heartbeat(runId: string, progress: RunHeartbeat): Promise<LeaseEcho>;
  /** Terminal transition: completed / cancelled (with stats + benchmark link) or failed. */
  finalize(runId: string, input: FinalizeInput): Promise<EvaluationRun>;
}

export const EXECUTOR_TOKEN_HEADER = 'x-ah-executor';

/** 128-bit random executor token (hex). Minted on `createRun`, echoed on every mutation. */
export function mintExecutorToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const NO_LEASE: LeaseEcho = { generation: 0 };

/**
 * Client-minted report id. Same shape both storage adapters mint
 * (`report-<epoch ms>-<base36>`), so ids written through the sink are
 * indistinguishable from ids the adapters minted before the seam existed.
 */
export function mintReportId(): string {
  return `report-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Build the `BenchmarkRun` projection of a finalized evaluation run — the
 * entry linked into `benchmark.runs[]`. Every field comes from the PERSISTED
 * run document (a rename issued mid-run lives only there) plus the judge
 * identity the runner resolved in memory.
 */
function buildBenchmarkRunProjection(
  persisted: EvaluationRun,
  stats: EvaluationRun['stats'],
  status: BenchmarkRunStatus,
  completedAt: string,
  completedRun: FinalizeCompletedInput['completedRun'],
): BenchmarkRun {
  const run = persisted as EvaluationRun & Record<string, any>;
  return {
    id: run.id, name: run.name, createdAt: run.createdAt, completedAt,
    status, agentKey: run.agentKey, modelId: run.modelId,
    judgeModelId: run.judgeModelId, results: run.results, stats,
    ...(completedRun.judgeModel ? { judgeModel: completedRun.judgeModel } : {}),
    ...(completedRun.judgeProvider ? { judgeProvider: completedRun.judgeProvider } : {}),
    ...(completedRun.judgeFailureSummary ? { judgeFailureSummary: completedRun.judgeFailureSummary } : {}),
    ...(run.description ? { description: run.description } : {}),
    ...(run.evaluatorId ? { evaluatorId: run.evaluatorId } : {}),
    ...(run.headers ? { headers: run.headers } : {}),
    ...(run.concurrency ? { concurrency: run.concurrency } : {}),
    ...(run.agentFingerprint ? {
      agentFingerprint: run.agentFingerprint,
      agentFingerprintShort: run.agentFingerprintShort,
      ...(run.agentPromptHash ? { agentPromptHash: run.agentPromptHash } : {}),
      ...(run.agentConfigSource ? { agentConfigSource: run.agentConfigSource } : {}),
    } : {}),
    testCaseSnapshots: run.testCaseSnapshots,
  } as BenchmarkRun;
}

/**
 * Sink for runs executed inside the server process. Writes go straight to the
 * server's storage module; the document shapes are exactly what the runner and
 * the `/evaluation-runs` route wrote before the seam existed (same
 * create-then-merge sequence per report, same finalize + benchmark projection).
 */
export class LocalRunSink implements RunSink {
  /** Report ids this sink has already written (fast path for the merge write). */
  private readonly knownReportIds = new Set<string>();

  constructor(private readonly storage: IStorageModule) {}

  private async reportExists(reportId: string): Promise<boolean> {
    if (this.knownReportIds.has(reportId)) return true;
    // First sight of this id in this process: it may still exist in storage
    // (a retried request whose first attempt landed, or a server restart
    // between two writes of the same report).
    return !!(await this.storage.runs.getById(reportId));
  }

  async createRun(run: EvaluationRun): Promise<{ runId: string; executorToken: string }> {
    await this.storage.evaluationRuns.create(run);
    return { runId: run.id, executorToken: mintExecutorToken() };
  }

  async upsertCaseReport(input: UpsertCaseReportInput): Promise<UpsertCaseReportResult> {
    const { reportId, report } = input;
    // Idempotent on reportId: the first write creates, every later write
    // (the final report after the `running` placeholder, or a retried
    // request) merges — the same create-then-update sequence the runner
    // used to issue directly, so the stored document is unchanged.
    if (await this.reportExists(reportId)) {
      const { id: _ignored, ...fields } = report as EvaluationReport;
      const saved = await this.storage.runs.update(reportId, fields as Partial<EvaluationReport>);
      return { reportId, report: saved as EvaluationReport };
    }
    const saved = await this.storage.runs.create({ ...report, id: reportId } as Partial<EvaluationReport>);
    this.knownReportIds.add(reportId);
    return { reportId: saved.id, report: saved as EvaluationReport };
  }

  async patchCaseReport(_runId: string, reportId: string, patch: Partial<EvaluationReport>): Promise<void> {
    await this.storage.runs.update(reportId, patch);
  }

  async setCaseResult(runId: string, testCaseId: string, result: EvaluationRunResultEntry): Promise<LeaseEcho> {
    await this.storage.evaluationRuns.updateResult(runId, testCaseId, result);
    return NO_LEASE;
  }

  async heartbeat(): Promise<LeaseEcho> {
    return NO_LEASE;
  }

  async finalize(runId: string, input: FinalizeInput): Promise<EvaluationRun> {
    const completedAt = input.completedAt ?? new Date().toISOString();
    if (input.status === 'failed') {
      return this.storage.evaluationRuns.update(runId, {
        status: 'failed',
        completedAt,
        error: input.error,
      });
    }
    // Terminal write: merge-if-absent results (+ `cancelled` markers for
    // never-started cases), recompute stats from the PERSISTED doc, then a
    // partial status/stats/completedAt update. See services/evaluationRunFinalize.ts.
    const finalized = await finalizeEvaluationRun(this.storage, {
      runId, finalStatus: input.status, completedRun: input.completedRun, completedAt,
    });
    // Link the terminal projection into the benchmark. addRun is idempotent,
    // so a crash here can be retried without orphaning the run.
    if (input.benchmarkId) {
      // The projection is built from the PERSISTED document (the only source
      // an out-of-process executor has): the full doc read back during
      // finalization, overlaid with what the terminal update returned.
      const projection = buildBenchmarkRunProjection(
        { ...finalized.persisted, ...finalized.run }, finalized.stats, input.status, completedAt, input.completedRun,
      );
      const linked = await this.storage.benchmarks.addRun(input.benchmarkId, projection);
      if (!linked) throw new Error(`Benchmark not found while linking completed run: ${input.benchmarkId}`);
    }
    return finalized.run;
  }
}
