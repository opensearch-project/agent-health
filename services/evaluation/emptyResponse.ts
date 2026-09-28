/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Empty-response detection.
 *
 * Owner incident: an HTTP agent whose model call had failed silently answered
 * `200` with an EMPTY payload — `{ answer: null, results: [], steps: [] }`.
 * The agent's `afterResponse` hook rendered a placeholder ("No results
 * committed …") as the final response step, agent-health sent that single
 * step to the LLM judge, and the judge PASSED it on a lenient rubric ("Any
 * reply at all — fully achieved"). A response with no agent activity and no
 * content must never reach the judge as a candidate answer.
 *
 * `classifyEmptyResponse()` decides, after the connector (and any
 * `afterResponse` hook) returned and BEFORE trace polling / judging, whether
 * a result is EMPTY. It is generic across connectors and deliberately
 * conservative — a false positive would silently error a real run, so only
 * three signals classify:
 *
 *  1. **Explicit hook flag.** An `afterResponse` hook that synthesizes text
 *     from a structured payload knows when it rendered a placeholder; it says
 *     so with `{ empty: true }` on what it returns (`isEmpty`, top-level or on
 *     `response`, is an alias). `{ empty: false }` suppresses the built-in
 *     detection for a payload shape it does not recognise.
 *  2. **Blank trajectory.** No agent-originated step (`tool_result` / `action`
 *     / `thinking` / `assistant`) AND the final response text is blank AND the
 *     raw connector payload carries no content under a known content key.
 *  3. **Unbacked response text.** No agent-originated step, a non-blank
 *     response step, and a raw payload in which every KNOWN content key
 *     (`answer`, `response`, `results`, `steps`, …) is null / empty — the
 *     text was not produced by the agent: it is either the REST connector's
 *     JSON echo of an empty body (`200 {}` → response step `"{}"`) or a
 *     placeholder a hook rendered. A payload with no known content key at all
 *     (unknown shape) or with no raw events never classifies this way.
 *
 * Structured results with a null answer (`{ answer: null, results: [{…}] }`)
 * are NOT empty — the results ARE the answer for retrieval agents.
 *
 * The runner turns an empty result into a FINAL agent failure
 * (`AgentEmptyResponseError` → `kind=agent_empty_response`, `metricsStatus:
 * 'error'`, `passFailStatus: null`, never trace-polled, never judged) and, by
 * default, counts it toward the run's endpoint circuit breaker
 * (`services/evaluation/agentReachability.ts`): an endpoint that returns
 * nothing repeatedly is as dead as one that refuses connections.
 *
 * Pure and dependency-free so the server bundle, the judge route and unit
 * tests can all import it.
 */

import type { TrajectoryStep } from '@/types';

/** Machine-readable class of an empty response (`agentError.code`). */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE';

/**
 * Env toggle: do consecutive empty responses count toward the endpoint
 * circuit breaker? Default yes; `0` / `false` / `no` / `off` disables.
 * Per-agent override: `connectorConfig.emptyResponseTripsBreaker`.
 */
export const EMPTY_RESPONSE_TRIPS_BREAKER_ENV = 'AGENT_EMPTY_RESPONSE_TRIPS_BREAKER';

/** Trajectory step types that prove the agent DID something. */
export const AGENT_ACTIVITY_STEP_TYPES: ReadonlySet<TrajectoryStep['type']> = new Set<TrajectoryStep['type']>([
  'tool_result',
  'action',
  'thinking',
  'assistant',
]);

/**
 * Payload keys under which connectors (REST / OpenAI-compatible / LangGraph /
 * AG-UI / ML-Commons / subprocess) and the common agent frameworks put the
 * agent's actual output. Anything else (`session_id`, `status`, `runId`,
 * `*_source`, …) is metadata and never counts as content.
 */
export const CONTENT_KEYS: ReadonlySet<string> = new Set([
  // final answer text
  'answer', 'final_answer', 'finalAnswer', 'response', 'content', 'text', 'message', 'messages',
  'completion', 'reply', 'output', 'outputs', 'delta',
  // structured results / retrieval output
  'result', 'results', 'data', 'items', 'hits', 'documents', 'sources', 'citations',
  // agent activity
  'steps', 'toolCalls', 'tool_calls', 'thinking', 'choices', 'inference_results',
]);

export type EmptyResponseSource = 'hook' | 'blank' | 'no-content';

export interface EmptyResponseVerdict {
  empty: boolean;
  /** Which rule decided (only when `empty`). */
  source?: EmptyResponseSource;
  /** One-line human explanation, safe to put on a report. */
  detail: string;
  /** Agent-originated steps seen (tool_result / action / thinking / assistant). */
  agentSteps: number;
  /** Characters of final response text (trimmed). */
  responseChars: number;
  /** What the raw connector payload looked like. */
  payload: PayloadContentState;
}

/**
 * `content` — at least one known content key carries a value;
 * `empty`   — the payload is null / `{}` / `[]`, or every known content key
 *             present is null / blank / an empty collection;
 * `unknown` — no raw events, or a shape with no known content key at all.
 */
export type PayloadContentState = 'content' | 'empty' | 'unknown';

const MAX_DEPTH = 8;

/** True when `value` contains ANY non-blank string / number / boolean, at any depth. */
export function hasAnyLeaf(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return true;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some(v => hasAnyLeaf(v, depth + 1));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(v => hasAnyLeaf(v, depth + 1));
  return false;
}

/**
 * Content state of ONE raw event / payload object. `empty` requires BOTH that
 * every known content key is null / blank / an empty collection AND that no
 * other key holds a non-empty array or object — structured data under a key
 * we do not know (`custom_results: [{…}]`) is evidence of an answer we cannot
 * read, so the shape is `unknown` (never classified). Scalar metadata under
 * unknown keys (`session_id`, `status`, `latency_ms`) is ignored.
 */
function eventContentState(event: unknown): PayloadContentState {
  if (event === null || event === undefined) return 'empty';
  if (typeof event === 'string') return event.trim().length > 0 ? 'unknown' : 'empty';
  if (typeof event !== 'object') return hasAnyLeaf(event) ? 'unknown' : 'empty';
  if (Array.isArray(event)) return payloadContentState(event);
  const entries = Object.entries(event as Record<string, unknown>);
  if (entries.length === 0) return 'empty';
  const known = entries.filter(([k]) => CONTENT_KEYS.has(k));
  if (known.length === 0) return 'unknown';
  if (known.some(([, v]) => hasAnyLeaf(v))) return 'content';
  const unknownStructured = entries.some(([k, v]) => !CONTENT_KEYS.has(k) && v !== null && typeof v === 'object' && hasAnyLeaf(v));
  return unknownStructured ? 'unknown' : 'empty';
}

/**
 * Content state of a connector's `rawEvents`. `content` wins over `unknown`
 * wins over `empty` across events — a stream that carried one text delta has
 * content; a stream of pure protocol events (`RUN_STARTED` …) is unknown; a
 * single `{}` body (or `[{ answer: null, results: [] }]`) is empty. No raw
 * events at all is `unknown` (no evidence either way).
 */
export function payloadContentState(rawEvents: unknown): PayloadContentState {
  if (rawEvents === undefined || rawEvents === null) return 'unknown';
  if (!Array.isArray(rawEvents)) return eventContentState(rawEvents);
  if (rawEvents.length === 0) return 'unknown';
  let sawUnknown = false;
  for (const event of rawEvents) {
    const s = eventContentState(event);
    if (s === 'content') return 'content';
    if (s === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'empty';
}

/**
 * Read the explicit empty flag off an `afterResponse` hook result:
 * `empty` (top-level, the documented contract), or its accepted aliases
 * `isEmpty` (top-level) / `response.isEmpty`. `true` forces the empty
 * classification, `false` suppresses the built-in detection, `undefined`
 * leaves the decision to {@link classifyEmptyResponse}.
 */
export function readExplicitEmptyFlag(hookResult: unknown): boolean | undefined {
  if (!hookResult || typeof hookResult !== 'object') return undefined;
  const r = hookResult as Record<string, any>;
  for (const v of [r.empty, r.isEmpty, r.response?.isEmpty]) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

type StepLike = Pick<TrajectoryStep, 'type' | 'content'>;

function isContentfulStep(s: StepLike): boolean {
  if (s.type === 'action' || s.type === 'tool_result') return true;
  return typeof s.content === 'string' ? s.content.trim().length > 0 : s.content != null;
}

export interface ClassifyEmptyResponseInput {
  trajectory: ReadonlyArray<StepLike> | undefined | null;
  /** The connector's raw payload(s). Absent / empty array = no evidence. */
  rawEvents?: unknown;
  /** Explicit flag from the connector hook (see {@link readExplicitEmptyFlag}). */
  explicit?: boolean;
}

/**
 * Decide whether an agent result is EMPTY (nothing to judge). See the module
 * doc for the three rules. Never throws.
 */
export function classifyEmptyResponse(input: ClassifyEmptyResponseInput): EmptyResponseVerdict {
  const steps = Array.isArray(input.trajectory) ? input.trajectory : [];
  // Tool activity (`action` / `tool_result`) counts by type — a tool call
  // happened. Text activity (`assistant` / `thinking`) must carry non-blank
  // content: an empty stub is not evidence the agent did anything.
  const agentSteps = steps.filter(s => s && AGENT_ACTIVITY_STEP_TYPES.has(s.type) && isContentfulStep(s)).length;
  const responseText = steps
    .filter(s => s && s.type === 'response')
    .map(s => (typeof s.content === 'string' ? s.content : s.content == null ? '' : String(s.content)))
    .join('\n')
    .trim();
  const payload = payloadContentState(input.rawEvents);
  const base = { agentSteps, responseChars: responseText.length, payload };

  if (input.explicit === true) {
    return { ...base, empty: true, source: 'hook', detail: 'the connector hook flagged the response as empty (no steps, no answer, no results)' };
  }
  if (input.explicit === false) {
    return { ...base, empty: false, detail: 'the connector hook flagged the response as non-empty' };
  }
  if (agentSteps > 0) {
    return { ...base, empty: false, detail: `${agentSteps} agent step${agentSteps === 1 ? '' : 's'} present` };
  }
  if (responseText.length === 0) {
    if (payload === 'content') {
      return { ...base, empty: false, detail: 'no response text, but the payload carries structured content' };
    }
    return {
      ...base,
      empty: true,
      source: 'blank',
      detail: `no agent steps and no response text${payload === 'empty' ? '; the payload has no answer, steps or results' : ''}`,
    };
  }
  if (payload === 'empty') {
    return {
      ...base,
      empty: true,
      source: 'no-content',
      detail: `no agent steps; the ${responseText.length}-char response text is not backed by any agent content (payload has no answer, steps or results)`,
    };
  }
  return { ...base, empty: false, detail: payload === 'content' ? 'the payload carries content' : 'response text present; payload shape unknown' };
}

/**
 * Resolve whether empty responses count toward the endpoint circuit breaker:
 * `connectorConfig.emptyResponseTripsBreaker` (per agent, boolean only — a
 * non-boolean is ignored with a warning) wins over
 * `AGENT_EMPTY_RESPONSE_TRIPS_BREAKER` (env; `0`/`false`/`no`/`off` disable)
 * over the default `true`.
 */
export function resolveEmptyResponseTripsBreaker(
  connectorConfig: Record<string, any> | undefined,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): boolean {
  const perAgent = connectorConfig?.emptyResponseTripsBreaker;
  if (typeof perAgent === 'boolean') return perAgent;
  if (perAgent !== undefined && perAgent !== null) {
    console.warn(`[emptyResponse] Ignoring non-boolean connectorConfig.emptyResponseTripsBreaker=${JSON.stringify(perAgent)}`);
  }
  const fromEnv = env[EMPTY_RESPONSE_TRIPS_BREAKER_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return !FALSY.has(fromEnv.trim().toLowerCase());
  return true;
}

const FALSY = new Set(['0', 'false', 'no', 'off']);

/** What the connector returned, carried on the error so the report can show it. */
export interface EmptyResponsePayload {
  trajectory: TrajectoryStep[];
  rawEvents: unknown[];
  runId: string | null;
  metadata?: Record<string, any>;
  agentDurationMs: number;
}

/**
 * Thrown by `invokeAgent` when the connector returned an EMPTY result. The
 * message names the endpoint host and the rule that fired; the connector's
 * trajectory / raw payload ride along so the failed report still shows what
 * the agent actually returned.
 */
export class AgentEmptyResponseError extends Error {
  readonly code = EMPTY_RESPONSE_CODE;
  readonly endpoint: string;
  readonly verdict: EmptyResponseVerdict;
  readonly payload: EmptyResponsePayload;

  constructor(verdict: EmptyResponseVerdict, endpointHost: string, payload: EmptyResponsePayload) {
    super(
      `${EMPTY_RESPONSE_CODE} — agent returned an empty response (no steps, no answer, no results) ` +
      `from agent endpoint ${endpointHost}: ${verdict.detail}`,
    );
    this.name = 'AgentEmptyResponseError';
    this.endpoint = endpointHost;
    this.verdict = verdict;
    this.payload = payload;
  }
}

export function isAgentEmptyResponseError(error: unknown): error is AgentEmptyResponseError {
  return error instanceof AgentEmptyResponseError;
}
