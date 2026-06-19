/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workflow SDK — shared types.
 *
 * A workflow is a deterministic series of steps with two stochastic nodes
 * (the agent calls). Sources, the feedback ledger, staging and consolidation
 * are all deterministic plumbing around those calls. See lib/workflow/workflow.ts.
 */

import type { TrajectoryStep } from '@/types/index.js';
import type { FeedbackLedger } from './ledger.js';

/** A unit of work. Duck-typed — a source returns plain objects of this shape. */
export interface WorkItem {
  /** Stable dedup key (ticket id, page id, email msg-id). */
  id: string;
  /** What the agent receives (a ticket URL or body). */
  prompt: string;
  /** Free-form provenance the sink can use (cti, severity, raw payload). */
  meta?: Record<string, unknown>;
}

/** A source is just an async function returning WorkItems — no interface to implement. */
export type SourceFetchFn = (args: { since?: string }) => Promise<WorkItem[]> | WorkItem[];

export interface SourceHandle {
  readonly name: string;
  readonly fetch: SourceFetchFn;
}

/** Result of one agent invocation against one WorkItem. */
export interface AgentRunResult {
  item: WorkItem;
  trajectory: TrajectoryStep[];
  output: string;
  runId: string | null;
  /** Clustering key for consolidation (derived from cti / diagnosis). */
  signature: string;
  /**
   * Run-correlation ids (currently the agent `runId` == OTel `gen_ai.request.id`),
   * used to look up this run's spans in the Traces UI / as PR evidence — these are
   * correlation handles, not raw OTel trace ids.
   */
  traceIds: string[];
}

export interface StagedItem {
  item: WorkItem;
  run: AgentRunResult;
  signature: string;
}

/** A group of similar staged fixes → one consolidated PR. */
export interface Cluster {
  label: string;
  signature: string;
  items: StagedItem[];
  tickets: WorkItem[];
  traceIds: string[];
  /** Placeholder fix artifact — the real derivation is a downstream node. */
  fix: { summary: string };
}

export type WritesMode = 'shadow' | 'live';

export interface RunAgentOptions {
  /** Cumulative feedback injected into the agent's context this run. */
  feedback?: FeedbackLedger;
  /**
   * 'shadow' (default): [READ] real, [WRITE] proposed-only. Instructs the agent not
   * to mutate; actual enforcement is connector- and human-gated (PRs are merged by a
   * human) — not guaranteed by this option alone.
   */
  writes?: WritesMode;
}

export interface WorkflowConfig {
  /** Agent key resolved from agent-health config (connector). */
  agent: string;
  /** Max agent calls in flight (cost + blast-radius cap). Default 1. */
  concurrency?: number;
  /** Evaluator id used as the profiling rubric in Step B. */
  evaluator?: string;
  /** The agent's own repo (for improvement PRs). */
  repo?: string;
}

export interface PRRequest {
  title: string;
  body?: string;
  repo?: string;
  evidence?: string[];
}
