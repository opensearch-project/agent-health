/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local executor — the CLI runs evaluation runs IN ITS OWN PROCESS (#612,
 * step 3) and persists them through the project server's run-ingestion API.
 *
 * Why: a `benchmark` / `run` command is "the command the user ran" — its cwd,
 * its shell environment, its `.env`, its `agent-health.config.*`. Executing
 * the hooks, the connector and the judge here means every one of those is the
 * caller's, not whatever a long-lived server happened to load at boot; two
 * projects can share one server and still each see their own `.env`.
 *
 * What runs where:
 *   - HERE: source resolution (`code-import` reads the caller's files),
 *     `executeEvaluationRun` (hooks, connector, SDK bodies), the judge
 *     (`runJudge` in-process with the caller's credentials — there is no
 *     fallback to the server's judge), eval telemetry from the caller's config.
 *   - SERVER (storage + observability + UI): the run / report documents
 *     via `HttpRunSink` (retry-until-confirmed, spool), stored test cases
 *     and benchmarks via the storage API, trace reads via `/api/traces`.
 *
 * Lease + cancel: `createRun` opens an executor lease; the shared runner
 * heartbeats it (every 20 s at the default TTL) and a UI "Cancel" reaches
 * this process through the lease echo. SIGINT / SIGTERM cancel the local
 * token so in-flight cases drain and the run is finalized `cancelled` with
 * explicit markers; a second signal exits immediately (the sweeper then
 * fails the run as "executor lost" within the TTL).
 */

import * as path from 'path';
import type { EvaluationRun, TestCase, TestCaseSnapshot, TestCaseSource } from '@/types/index.js';
import type { ResolvedConfig } from '@/lib/config/index.js';
import { resolveAgentModel } from '@/lib/resolveAgentModel.js';
import { resolveTestCaseSources, resolveCodeFnMapForStoredTestCases, type ResolvedSources } from '@/services/sourceResolver.js';
import { executeEvaluationRun, createCancellationToken } from '@/services/evaluationRunner.js';
import type { EvaluationRunProgress } from '@/services/evaluationRunner.js';
import { HttpRunSink, RunDeliveryError } from '@/services/httpRunSink.js';
import { fetchTracesForRun, type TracesClient } from '@/services/traces/index.js';
import { createInProcessJudgeTransport } from '@/services/judge/judgeHttpContract.js';
import { isLeaseLostError, type LeaseLostInfo } from '@/lib/runLease.js';
import { resolveAgentProvenance } from '@/server/services/agentProvenance.js';
import { getCustomAgents } from '@/server/services/customAgentStore.js';
import { initEvalTelemetryFromConfig } from '@/server/services/evalTelemetryBoot.js';
import { flushEvalTracer, shutdownEvalTracer } from '@/lib/telemetry/index.js';
import { setConfiguredEvalRoots } from '@/lib/config/evalRoots.js';
import { connectorRegistry } from '@/services/connectors/server.js';
import { createHttpSourceStorage } from './httpSourceStorage.js';
import { startRunLogCapture, type RunLogCapture } from './runLogCapture.js';
import { getVersion } from '@/server/utils/version';
import type { Evaluator } from '@/types/index.js';

export interface LocalRunRequest {
  /** Human-readable run name (persisted on the run document). */
  name: string;
  sources: TestCaseSource[];
  agentKey: string;
  /** Legacy fallback for the agent's model id; the agent's own config wins. */
  modelId?: string;
  judgeModelId?: string;
  evaluatorId?: string;
  concurrency?: number;
  benchmarkId?: string;
  description?: string;
}

export interface LocalRunCallbacks {
  /** Progress for the spinner. */
  onProgress?: (progress: EvaluationRunProgress) => void;
  /**
   * The run document exists on the server (its id is known, its cases are
   * linked into the benchmark) — awaited before execution starts, so a caller
   * can record something about the run (e.g. the `--force` note, #620).
   */
  onStarted?: (info: { runId: string; testCases: TestCaseSnapshot[] }) => void | Promise<void>;
  /** A delivery retry is in progress (server unreachable / 5xx). */
  onDeliveryRetry?: (info: { operation: string; attempt: number; delayMs: number; error: string }) => void;
  /** Cancellation requested (signal or UI) — the run drains and finalizes `cancelled`. */
  onCancelRequested?: (source: 'signal' | 'lease') => void;
}

export interface LocalRunOutcome {
  runId: string;
  /** The persisted run after the terminal write (what `finalize` returned). */
  run: EvaluationRun;
  status: 'completed' | 'cancelled';
  testCases: TestCaseSnapshot[];
  /** Where the runner's / judge's log lines for this run were written. */
  logPath: string;
}

/** The run ended without a terminal write by this executor. */
export class LocalRunFailure extends Error {
  constructor(
    message: string,
    public readonly runId: string | undefined,
    public readonly kind: 'lease-lost' | 'delivery' | 'execution',
    public readonly leaseLost?: LeaseLostInfo,
    public readonly spoolPath?: string,
    public readonly logPath?: string,
  ) {
    super(message);
    this.name = 'LocalRunFailure';
  }
}

/** Spool directory for unconfirmed run writes: `<cwd>/.agent-health/spool`. */
export function spoolDirFor(cwd: string = process.cwd()): string {
  return path.join(cwd, '.agent-health', 'spool');
}

/** Probe `/health` on `serverUrl`; the URL when it answers, else undefined (used by the sink's re-discovery). */
export async function probeServer(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${serverUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? serverUrl : undefined;
  } catch {
    return undefined;
  }
}

/** Stored evaluator lookup over the storage API (system evaluators are answered by the route too). */
export function httpEvaluatorLookup(serverUrl: string, fetchImpl: typeof fetch = fetch): (id: string) => Promise<Evaluator | null> {
  return async (id) => {
    const res = await fetchImpl(`${serverUrl.replace(/\/$/, '')}/api/storage/evaluators/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load evaluator ${id}: HTTP ${res.status}`);
    return (await res.json()) as Evaluator;
  };
}

function httpTracesClient(serverUrl: string): TracesClient {
  return { fetchTracesForRun: (params) => fetchTracesForRun(params, { baseUrl: serverUrl }) };
}

/**
 * Resolve the run's sources in THIS process. Code-SDK bodies of test cases
 * that are only referenced (`-t <id>`, `-n <benchmark>`) are re-materialized
 * from their stored `sourceFile` relative to the caller's cwd / eval roots —
 * the server never needs to see the files.
 */
export async function resolveSourcesLocally(sources: TestCaseSource[], serverUrl: string, config: Pick<ResolvedConfig, 'evalRoots'>): Promise<ResolvedSources> {
  setConfiguredEvalRoots(config.evalRoots ?? null);
  const resolved = await resolveTestCaseSources(sources, createHttpSourceStorage(serverUrl));
  const withoutBody = resolved.testCases.filter((tc) => !resolved.evaluateFnMap.has(tc.id) && (tc as any).sourceFile);
  if (withoutBody.length > 0) {
    const stored = await resolveCodeFnMapForStoredTestCases(withoutBody);
    for (const [id, fn] of stored.evaluateFnMap) resolved.evaluateFnMap.set(id, fn);
    for (const [file, hooks] of stored.hooksByFile) if (!resolved.hooksByFile.has(file)) resolved.hooksByFile.set(file, hooks);
    for (const [id, scope] of stored.testHookScopes) if (!resolved.testHookScopes.has(id)) resolved.testHookScopes.set(id, scope);
  }
  return resolved;
}

/** Build the run document exactly as `POST /api/storage/evaluation-runs` does, from the CALLER's config. */
export async function buildRunDocument(request: LocalRunRequest, resolved: ResolvedSources, agents: ResolvedConfig['agents']): Promise<EvaluationRun> {
  const runId = `eval-run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const now = new Date().toISOString();
  const snapshots: TestCaseSnapshot[] = resolved.testCases.map((tc: TestCase) => ({ id: tc.id, version: (tc as any).version || 1, name: tc.name }));
  let resolvedModelId = request.modelId || '';
  try {
    resolvedModelId = resolveAgentModel(agents.find((a) => a.key === request.agentKey), request.modelId);
  } catch { /* keep fallback */ }
  return {
    id: runId,
    name: request.name,
    description: request.description,
    sources: resolved.sources,
    agentKey: request.agentKey,
    modelId: resolvedModelId,
    judgeModelId: request.judgeModelId || undefined,
    evaluatorId: request.evaluatorId,
    concurrency: request.concurrency,
    benchmarkId: request.benchmarkId,
    trigger: 'cli',
    status: 'running',
    testCaseSnapshots: snapshots,
    results: {},
    createdAt: now,
    // Agent-configuration provenance from the caller's config file.
    ...(await resolveAgentProvenance(request.agentKey)),
  } as EvaluationRun;
}

export interface ExecuteLocallyOptions {
  serverUrl: string;
  config: ResolvedConfig;
  request: LocalRunRequest;
  callbacks?: LocalRunCallbacks;
  /** Where unconfirmed writes are spooled (default `<cwd>/.agent-health/spool`). */
  spoolDir?: string;
  /** Install SIGINT/SIGTERM handlers that cancel the run (default true). */
  handleSignals?: boolean;
  /** Echo the runner's info-level log lines on the terminal (they always go to the per-run log file). */
  verbose?: boolean;
  /** Directory of per-run log files (default `<cwd>/.agent-health/logs`). */
  logDir?: string;
}

/**
 * Execute one evaluation run in this process and persist it on the server.
 * Resolves with the persisted terminal run; throws `LocalRunFailure` when
 * the run could not be brought to a terminal state by this executor.
 */
export async function executeRunLocally(options: ExecuteLocallyOptions): Promise<LocalRunOutcome> {
  const { serverUrl, config, request, callbacks = {} } = options;

  // The caller's connectors, exactly as the server registers its own at boot.
  for (const connector of config.connectors ?? []) {
    try { connectorRegistry.register(connector); } catch { /* already registered */ }
  }

  const agents = [...config.agents, ...getCustomAgents()];
  if (!agents.some((a) => a.key === request.agentKey)) {
    throw new LocalRunFailure(`Agent not found: ${request.agentKey}`, undefined, 'execution');
  }

  const resolved = await resolveSourcesLocally(request.sources, serverUrl, config);
  if (resolved.testCases.length === 0) {
    throw new LocalRunFailure('No test cases resolved from the given sources', undefined, 'execution');
  }
  const run = await buildRunDocument(request, resolved, agents);

  // From here on the runner / connectors / judge log through console.*; keep
  // the info chatter in the per-run log file (terminal only when verbose).
  const log: RunLogCapture = startRunLogCapture({ runId: run.id, verbose: options.verbose ?? !!process.env.DEBUG, dir: options.logDir });
  // Eval telemetry from the caller's config (observability cluster, OTLP).
  initEvalTelemetryFromConfig(config);

  const sink = new HttpRunSink(serverUrl, {
    executorVersion: getVersion(),
    delivery: {
      spoolDir: options.spoolDir ?? spoolDirFor(),
      // Per-project server records are step 4; today a restarted server is
      // found again on the same port.
      rediscover: () => probeServer(serverUrl),
      onRetry: (info) => {
        console.warn(`[LocalExecutor] ${info.operation} not confirmed by ${info.serverUrl} (attempt ${info.attempt}: ${info.error}); retrying in ${Math.round(info.delayMs / 1000)}s`);
        callbacks.onDeliveryRetry?.(info);
      },
    },
  });

  const getEvaluator = httpEvaluatorLookup(serverUrl);
  const deps = {
    sink,
    agents,
    models: config.models,
    judge: createInProcessJudgeTransport({ getEvaluator, config: { models: config.models, judge: config.judge } }),
    traces: httpTracesClient(serverUrl),
    getEvaluator,
  };

  try {
    await sink.createRun(run);
  } catch (error) {
    log.stop();
    throw asFailure(error, undefined, sink.spoolFile, log.logPath);
  }
  callbacks.onStarted?.({ runId: run.id, testCases: run.testCaseSnapshots });

  const cancellationToken = createCancellationToken();
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals === 1) {
      callbacks.onCancelRequested?.('signal');
      cancellationToken.cancel();
      return;
    }
    // Second signal: stop waiting for the drain. The lease sweeper fails the
    // run as "executor lost" once the heartbeats stop.
    process.exit(130);
  };
  if (options.handleSignals !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  try {
    const completedRun = await executeEvaluationRun(run, resolved.testCases, {
      ...deps,
      cancellationToken,
      evaluateFnMap: resolved.evaluateFnMap,
      hooksByFile: resolved.hooksByFile,
      testHookScopes: resolved.testHookScopes,
      onProgress: (progress) => callbacks.onProgress?.(progress),
    });
    const status = cancellationToken.isCancelled ? 'cancelled' : 'completed';
    const finalized = await sink.finalize(run.id, { status, completedRun, benchmarkId: request.benchmarkId });
    return { runId: run.id, run: finalized, status, testCases: run.testCaseSnapshots, logPath: log.logPath };
  } catch (error) {
    // Lease lost: the server already failed this run and fenced us out; a
    // terminal write would be refused. Delivery exhausted: the server never
    // confirmed — do not pretend. Anything else is this executor's failure,
    // recorded as such.
    if (!isLeaseLostError(error) && !(error instanceof RunDeliveryError)) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await sink.finalize(run.id, { status: 'failed', error: message });
      } catch (finalizeError) {
        if (!isLeaseLostError(finalizeError) && !(finalizeError instanceof RunDeliveryError)) throw finalizeError;
      }
    }
    throw asFailure(error, run.id, sink.spoolFile, log.logPath);
  } finally {
    if (options.handleSignals !== false) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    try { await flushEvalTracer(); await shutdownEvalTracer(); } catch { /* best effort */ }
    log.stop();
  }
}

function asFailure(error: unknown, runId: string | undefined, spoolPath: string | undefined, logPath: string | undefined): LocalRunFailure {
  if (error instanceof LocalRunFailure) return error;
  if (isLeaseLostError(error)) {
    const info = error.info;
    return new LocalRunFailure(
      `the server marked this run ${info.status} at ${info.at} (lease generation ${info.generation}); results after that point were not recorded`,
      runId, 'lease-lost', info, undefined, logPath,
    );
  }
  if (error instanceof RunDeliveryError) {
    return new LocalRunFailure(error.message, runId, 'delivery', undefined, error.spoolPath ?? spoolPath, logPath);
  }
  return new LocalRunFailure(error instanceof Error ? error.message : String(error), runId, 'execution', undefined, undefined, logPath);
}
