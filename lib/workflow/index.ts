/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** Workflow SDK public surface. */

export { source, getSource, listSources, clearSources } from './source.js';
export { workflow } from './workflow.js';
export { FeedbackLedger } from './ledger.js';
export { consolidate } from './consolidate.js';
export { mapPool } from './pool.js';
export {
  profileSpans,
  buildAgentEditsPrompt,
  parseAgentEdits,
  deriveAgentEdits,
  defaultReason,
} from './stepB.js';

export type {
  WorkItem,
  SourceFetchFn,
  SourceHandle,
  AgentRunResult,
  StagedItem,
  Cluster,
  WritesMode,
  RunAgentOptions,
  WorkflowConfig,
  PRRequest,
} from './types.js';
export type { LedgerEntry } from './ledger.js';
export type { PoolStats } from './pool.js';
export type { SessionProfile, AgentEdit, ReasonFn } from './stepB.js';
export type {
  Workflow,
  WorkflowContext,
  WorkflowRunOptions,
  WorkflowResult,
  ForEachOptions,
} from './workflow.js';
