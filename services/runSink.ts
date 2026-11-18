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
 *
 * Every mutation is also FENCED (#612 step 2, lib/runLease.ts): `createRun`
 * stamps `executor` + `lease` on the run document and binds the sink to the
 * minted token; each later write is a compare-and-swap on that token, the
 * lease generation and `status === 'running'`. Once the lease sweeper has
 * taken a run over (executor stopped heartbeating), the old executor's
 * writes fail with `LeaseLostError` and can never resurrect the run.
 */

import type { EvaluationReport, EvaluationRun, BenchmarkRun, BenchmarkRunStatus, RunLease } from '@/types';
import type { IStorageModule, EvaluationRunResultEntry } from '@/server/adapters/types';
import { finalizeEvaluationRun, observedModelFields, type FinalRunStatus } from './evaluationRunFinalize';
import {
  LeaseLostError, leaseGuardHolds, leaseLostInfo, resolveLeaseTtlMs, type LeaseGuard,
} from '@/lib/runLease';

/** Progress a heartbeat carries (advisory; liveness is the heartbeat itself). */
export interface RunHeartbeat {
  startedCount: number;
  completedCount: number;
  totalTestCases: number;
}

/**
 * What the sink tells the executor on every heartbeat / case result:
 * the run's lease generation and, once a cancel has been requested through
 * the server (UI "Cancel" on a run executing elsewhere), `cancelRequestedAt`
 * — the executor's cue to stop starting cases and finalize `cancelled`.
 */
export interface LeaseEcho {
  generation: number;
  cancelRequestedAt?: string;
}

/** What `createRun` hands back: the fencing token and the lease it opened. */
export interface CreatedRun {
  runId: string;
  executorToken: string;
  lease: RunLease;
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
  /** The persisted id — address every later write for this report by it. */
  reportId: string;
  /** The persisted document after the write (what `runs.update` returns). */
  report: EvaluationReport;
}

/** Terminal input for a run that ran to completion or was cancelled. */
export interface FinalizeCompletedInput {
  status: FinalRunStatus;
  /** The runner's in-memory run at completion (results, stats, judge identity). */
  completedRun: Pick<EvaluationRun, 'results' | 'testCaseSnapshots'> &
    Partial<Pick<EvaluationRun, 'judgeFailureSummary' | 'judgeModel' | 'judgeProvider' | 'modelId' | 'modelName' | 'modelSource'>>;
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
  /**
   * Persist the run document with a fresh executor lease; the run is stored
   * `running`. Returns the executor token the run is bound to and the lease.
   */
  createRun(run: EvaluationRun): Promise<CreatedRun>;
  /** Create-or-merge a case's report document, keyed by the client-minted `reportId`. */
  upsertCaseReport(input: UpsertCaseReportInput): Promise<UpsertCaseReportResult>;
  /** Partial update of an existing report (trace-judged verdict, evaluator-error patch). */
  patchCaseReport(runId: string, reportId: string, patch: Partial<EvaluationReport>): Promise<void>;
  /** Record one case's verdict on the run document (atomic per-key merge). */
  setCaseResult(runId: string, testCaseId: string, result: EvaluationRunResultEntry): Promise<LeaseEcho>;
  /** Liveness: renews the lease (`lease.heartbeatAt`) and echoes a pending cancel request. */
  heartbeat(runId: string, progress: RunHeartbeat): Promise<LeaseEcho>;
  /** Terminal transition: completed / cancelled (with stats + benchmark link) or failed. */
  finalize(runId: string, input: FinalizeInput): Promise<EvaluationRun>;
}

export const EXECUTOR_TOKEN_HEADER = 'x-ah-executor';
/** Lease generation the executor believes it holds (defaults to 1 — the generation `createRun` opens). */
export const LEASE_GENERATION_HEADER = 'x-ah-lease-generation';

/** 128-bit random executor token (hex). Minted on `createRun`, echoed on every mutation. */
export function mintExecutorToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Echo for a run that predates leases (no fence to report). */
const NO_LEASE: LeaseEcho = { generation: 0 };

function echoFrom(run: EvaluationRun | null): LeaseEcho {
  if (!run?.lease) return NO_LEASE;
  return { generation: run.lease.generation, ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt } : {}) };
}

export interface LocalRunSinkOptions {
  /**
   * Write on behalf of THIS executor (the ingestion route binds a sink per
   * request to the token/generation the request carries). A sink without a
   * bound executor fences with the tokens of the runs it created itself.
   */
  executor?: LeaseGuard;
  /** Stamped on runs this sink creates. */
  executorKind?: 'cli' | 'server';
  executorVersion?: string;
  /**
   * Token the executor minted itself for the run this sink creates (an
   * out-of-process executor sends it with `createRun` so a retried create
   * after a lost response is recognised as the same executor). Default: a
   * fresh server-minted token.
   */
  executorToken?: string;
  /** Lease TTL for runs this sink creates; default `AH_RUN_LEASE_TTL_MS` / 5 min. */
  ttlMs?: number;
  /** Clock (tests). */
  now?: () => Date;
}

/** State shared by every per-executor view of one storage module. */
interface LocalSinkShared {
  /** Reports this sink has written: id → the run/case they belong to (fast path + identity check). */
  knownReports: Map<string, { runId: string; testCaseId: string }>;
  /**
   * Leases opened by `createRun` in this process: runId → guard. Kept for the
   * sink's lifetime on purpose — the fence must still apply to a write that
   * arrives AFTER the run is terminal (that is exactly the write it refuses).
   * A sink lives as long as the route call that created the run.
   */
  leases: Map<string, LeaseGuard>;
}

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
    ...observedModelFields(completedRun),
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
  private readonly shared: LocalSinkShared;
  private readonly options: LocalRunSinkOptions;

  constructor(private readonly storage: IStorageModule, options: LocalRunSinkOptions = {}, shared?: LocalSinkShared) {
    this.options = options;
    this.shared = shared ?? { knownReports: new Map(), leases: new Map() };
  }

  /**
   * The same sink (same storage, same report memo) writing for another
   * executor — one per ingestion request, bound to the token + generation
   * the request carries.
   */
  forExecutor(executor: LeaseGuard): LocalRunSink {
    return new LocalRunSink(this.storage, { ...this.options, executor }, this.shared);
  }

  private get knownReports() { return this.shared.knownReports; }

  /** The guard a write for `runId` must present: the bound executor, else the lease this process opened. */
  private guardFor(runId: string): LeaseGuard | undefined {
    return this.options.executor ?? this.shared.leases.get(runId);
  }

  /**
   * Fail closed: a sink that holds no guard for `runId` may only write a run
   * that carries no lease (created before leases existed). Writing a LEASED
   * run without its token would silently bypass the fence, so it is refused
   * as a programming error rather than performed unguarded.
   */
  private async requireGuardIfLeased(runId: string, guard: LeaseGuard | undefined, run: EvaluationRun | null): Promise<void> {
    if (guard || !run?.lease) return;
    throw new Error(`LocalRunSink holds no executor lease for run ${runId}: it is leased to another executor (token required)`);
  }

  /**
   * Fence for writes that do not touch the run document itself (per-case
   * report documents): check the run's lease first. Not atomic with the
   * report write — a report document cannot be CAS'd against another
   * document — but it closes the window to the one read, and the run
   * document's own status/results are always written under the atomic
   * guard, so a late report write can never change what the run says.
   */
  private async assertLease(runId: string): Promise<void> {
    const guard = this.guardFor(runId);
    const run = await this.storage.evaluationRuns.getById(runId);
    if (!guard) {
      // Legacy (pre-lease) path: report writes never required the run
      // document to exist; they only must not touch a LEASED run unfenced.
      await this.requireGuardIfLeased(runId, guard, run);
      return;
    }
    if (!run) throw new Error(`Evaluation run ${runId} not found`);
    if (!leaseGuardHolds(run, guard)) throw new LeaseLostError(leaseLostInfo(run));
  }

  /**
   * A write may only touch the report of the run/case it names. Catches an
   * id collision or a caller addressing another run's report before anything
   * is merged.
   */
  private assertOwnership(reportId: string, runId: string, owner: { runId?: string; testCaseId?: string } | undefined, testCaseId?: string): void {
    if (!owner) return;
    if (owner.runId && owner.runId !== runId) {
      throw new Error(`Report ${reportId} belongs to run ${owner.runId}, not ${runId}`);
    }
    if (testCaseId && owner.testCaseId && owner.testCaseId !== testCaseId) {
      throw new Error(`Report ${reportId} belongs to test case ${owner.testCaseId}, not ${testCaseId}`);
    }
  }

  /** Who owns an existing report, or `undefined` when it does not exist yet. */
  private async existingOwner(reportId: string): Promise<{ runId?: string; testCaseId?: string } | undefined> {
    const known = this.knownReports.get(reportId);
    if (known) return known;
    // First sight of this id in this process: it may still exist in storage
    // (a retried request whose first attempt landed, or a server restart
    // between two writes of the same report).
    const existing = await this.storage.runs.getById(reportId);
    if (!existing) return undefined;
    return { runId: (existing as any).experimentRunId, testCaseId: existing.testCaseId };
  }

  async createRun(run: EvaluationRun): Promise<CreatedRun> {
    const executorToken = this.options.executorToken ?? mintExecutorToken();
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const lease: RunLease = { generation: 1, heartbeatAt: now, ttlMs: this.options.ttlMs ?? resolveLeaseTtlMs() };
    // Stamped on the caller's object too: the run the executor holds in
    // memory and the persisted document agree on who owns it. A leased run
    // is by definition executing, so it is stored `running`.
    run.executor = { id: executorToken, kind: this.options.executorKind ?? 'server', version: this.options.executorVersion ?? 'unknown' };
    run.lease = lease;
    run.status = 'running';
    await this.storage.evaluationRuns.create(run);
    this.shared.leases.set(run.id, { executorId: executorToken, generation: lease.generation });
    return { runId: run.id, executorToken, lease };
  }

  async upsertCaseReport(input: UpsertCaseReportInput): Promise<UpsertCaseReportResult> {
    const { runId, testCaseId, reportId, report } = input;
    await this.assertLease(runId);
    // Idempotent on reportId: the first write creates, every later write
    // (the final report after the `running` placeholder, or a retried
    // request) merges — the same create-then-update sequence the runner
    // used to issue directly, so the stored document is unchanged.
    const owner = await this.existingOwner(reportId);
    if (owner) {
      this.assertOwnership(reportId, runId, owner, testCaseId);
      const { id: _ignored, ...fields } = report as EvaluationReport;
      const saved = await this.storage.runs.update(reportId, fields as Partial<EvaluationReport>);
      return { reportId, report: saved as EvaluationReport };
    }
    const saved = await this.storage.runs.create({ ...report, id: reportId } as Partial<EvaluationReport>);
    // The id the adapter persisted is authoritative (both adapters honour the
    // one they are given); callers address every later write by the returned id.
    this.knownReports.set(saved.id, { runId, testCaseId });
    return { reportId: saved.id, report: saved as EvaluationReport };
  }

  async patchCaseReport(runId: string, reportId: string, patch: Partial<EvaluationReport>): Promise<void> {
    this.assertOwnership(reportId, runId, await this.existingOwner(reportId));
    await this.assertLease(runId);
    await this.storage.runs.update(reportId, patch);
  }

  async setCaseResult(runId: string, testCaseId: string, result: EvaluationRunResultEntry): Promise<LeaseEcho> {
    const guard = this.guardFor(runId);
    if (!guard) await this.requireGuardIfLeased(runId, guard, await this.storage.evaluationRuns.getById(runId));
    const found = await this.storage.evaluationRuns.updateResult(runId, testCaseId, result, guard);
    if (found === false) throw new Error(`Evaluation run ${runId} not found`);
    return echoFrom(await this.storage.evaluationRuns.getById(runId));
  }

  async heartbeat(runId: string, _progress?: RunHeartbeat): Promise<LeaseEcho> {
    const guard = this.guardFor(runId);
    const current = await this.storage.evaluationRuns.getById(runId);
    if (!current) throw new Error(`Evaluation run ${runId} not found`);
    await this.requireGuardIfLeased(runId, guard, current);
    if (!guard) return echoFrom(current); // pre-lease run: nothing to renew
    // A guard for a document that carries no lease at all cannot hold.
    if (!current.lease) throw new LeaseLostError(leaseLostInfo(current));
    // Read-then-guarded-write is safe: the only other writer of `lease` is
    // the sweeper, and it bumps `generation`, which this guard pins. The
    // runner keeps at most one beat in flight, so beats cannot reorder.
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const renewed = await this.storage.evaluationRuns.update(runId, { lease: { ...current.lease, heartbeatAt: now } }, guard);
    return echoFrom(renewed);
  }

  async finalize(runId: string, input: FinalizeInput): Promise<EvaluationRun> {
    const completedAt = input.completedAt ?? new Date().toISOString();
    const guard = this.guardFor(runId);
    if (!guard) await this.requireGuardIfLeased(runId, guard, await this.storage.evaluationRuns.getById(runId));
    let finalized: { run: EvaluationRun; persisted: EvaluationRun; stats: EvaluationRun['stats'] };
    try {
      if (input.status === 'failed') {
        return await this.storage.evaluationRuns.update(runId, {
          status: 'failed',
          completedAt,
          error: input.error,
        }, guard);
      }
      // Terminal write: merge-if-absent results (+ `cancelled` markers for
      // never-started cases), recompute stats from the PERSISTED doc, then a
      // partial status/stats/completedAt update. See services/evaluationRunFinalize.ts.
      finalized = await finalizeEvaluationRun(this.storage, {
        runId, finalStatus: input.status, completedRun: input.completedRun, completedAt, guard,
      });
    } catch (error) {
      // A RETRIED finalize (lost response) finds the run already terminal —
      // written by this very executor at this very generation. That is the
      // idempotent success case, not a lost lease: hand back the persisted
      // state and still (re)link the projection below. Anything else
      // (generation bumped, token cleared, another terminal status) is real.
      const already = guard && error instanceof LeaseLostError ? await this.finalizedByMe(runId, guard, input.status) : undefined;
      if (!already) throw error;
      finalized = { run: already, persisted: already, stats: already.stats };
    }
    // Link the terminal projection into the benchmark. addRun is idempotent,
    // so a crash here can be retried without orphaning the run.
    if (input.status !== 'failed' && input.benchmarkId) {
      // The projection is built from the PERSISTED document (the only source
      // an out-of-process executor has): the full doc read back during
      // finalization, overlaid with what the terminal update returned.
      const projection = buildBenchmarkRunProjection(
        { ...finalized.persisted, ...finalized.run }, finalized.stats, input.status, finalized.run.completedAt ?? completedAt, input.completedRun,
      );
      const linked = await this.storage.benchmarks.addRun(input.benchmarkId, projection);
      if (!linked) throw new Error(`Benchmark not found while linking completed run: ${input.benchmarkId}`);
    }
    return finalized.run;
  }

  /** The persisted run if `guard`'s executor already wrote this exact terminal status, else undefined. */
  private async finalizedByMe(runId: string, guard: LeaseGuard, status: FinalizeInput['status']): Promise<EvaluationRun | undefined> {
    const run = await this.storage.evaluationRuns.getById(runId);
    if (!run || run.status !== status) return undefined;
    if (run.executor?.id !== guard.executorId || run.lease?.generation !== guard.generation) return undefined;
    return run;
  }
}
