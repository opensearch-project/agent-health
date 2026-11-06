/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-step failure classification.
 *
 * Owner incident (a 62-case run against a REST agent, 5 cases "errored"):
 * the agent's HTTP call never returned to agent-health — Node's built-in
 * undici gave up after its default 300 s `headersTimeout` and threw the
 * famously opaque `TypeError: fetch failed`, with the REAL reason
 * (`HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT`) hidden on
 * `error.cause`. The runner logged only `fetch failed`, persisted an empty
 * report, and then judged the empty trajectory — so the UI ended up saying
 * "evaluator could not run" when the truth was "the agent request timed
 * out after 5 minutes".
 *
 * `describeAgentError()` unwraps the cause chain into one human-readable line
 * and classifies it (`timeout` / `connection` / `http_<status>` / `unknown`)
 * so the report can carry `agentError` + `failureStage: 'agent'` and the UI
 * can render the actual cause. Pure and dependency-free so the browser
 * bundle can import it too.
 */

import type { AgentErrorInfo, AgentErrorKind } from '@/types';

/** Options that enrich the classification with connector context. */
export interface DescribeAgentErrorContext {
  endpoint?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  /**
   * Response headers of a non-2xx reply. Passed through
   * {@link selectDiagnosticResponseHeaders} before persisting, so a caller
   * may hand over either the raw set or an already-filtered one.
   */
  responseHeaders?: Record<string, string>;
}

/**
 * The ONLY response headers of a non-2xx reply that are persisted on a report:
 * an allowlist, not a redaction denylist. Anything else a server sends back
 * (`set-cookie`, `www-authenticate`, `location` with a signed URL, `server`,
 * vendor diagnostics, …) is attacker-/operator-controlled text that can carry
 * credentials or PII, and a name-based denylist cannot be made exhaustive.
 *
 * What is kept is what an operator needs to look up exactly this failed call:
 *   - request / correlation / trace ids, by the common naming patterns
 *     (`x-request-id`, `x-amzn-requestid`, `x-amz-request-id`, `x-amz-id-2`,
 *     `x-amz-cf-id`, `x-amzn-trace-id`, `x-correlation-id`, `cf-ray`,
 *     `traceparent`, `x-cloud-trace-context`, `x-b3-traceid`, …);
 *   - the service's own error classification (`x-amzn-errortype`);
 *   - `retry-after`, `date`, `content-type`.
 */
const DIAGNOSTIC_HEADER_PATTERNS: readonly RegExp[] = [
  /(^|[-_])(request|correlation|trace|req)[-_]?id$/,
  /(^|[-_])requestid$/,
  /^x-amz-id-2$/,
  /^x-amz-cf-id$/,
  /^x-amzn-trace-id$/,
  /^cf-ray$/,
  /^traceparent$/,
  /^x-cloud-trace-context$/,
  /^x-b3-traceid$/,
  /^x-amzn-errortype$/,
  /^retry-after$/,
  /^date$/,
  /^content-type$/,
];

/** Bounds on what one report may carry (the reply is untrusted input). */
export const MAX_DIAGNOSTIC_HEADERS = 20;
export const MAX_DIAGNOSTIC_HEADER_VALUE_LENGTH = 256;

/** True when a (lower-cased) header name is on the diagnostic allowlist. */
export function isDiagnosticResponseHeader(name: string): boolean {
  return DIAGNOSTIC_HEADER_PATTERNS.some((re) => re.test(name));
}

/**
 * Keep only the allowlisted diagnostic headers of a non-2xx reply, with
 * lower-cased names, at most {@link MAX_DIAGNOSTIC_HEADERS} entries and
 * values cut to {@link MAX_DIAGNOSTIC_HEADER_VALUE_LENGTH} chars. Accepts the
 * fetch `Headers` object (iterable) or a plain record; idempotent, so it is
 * applied both where the connector builds the error and again where the
 * runner persists it. Returns `undefined` when nothing qualifies so the
 * field is simply absent on the report.
 */
export function selectDiagnosticResponseHeaders(
  headers: Record<string, string> | Iterable<[string, string]> | undefined | null,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries: Iterable<[string, string]> = typeof (headers as any)[Symbol.iterator] === 'function'
    ? (headers as Iterable<[string, string]>)
    : Object.entries(headers as Record<string, string>);
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawName, value] of entries) {
    const name = String(rawName).toLowerCase();
    if (!isDiagnosticResponseHeader(name)) continue;
    if (count >= MAX_DIAGNOSTIC_HEADERS) break;
    out[name] = String(value).slice(0, MAX_DIAGNOSTIC_HEADER_VALUE_LENGTH);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ABORT_ERR',
]);

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** Walk `error.cause` (bounded) collecting each hop's name/code/message. */
function unwrapCauseChain(error: unknown): Array<{ name?: string; code?: string; message: string }> {
  const chain: Array<{ name?: string; code?: string; message: string }> = [];
  let current: any = error;
  const seen = new Set<any>();
  for (let i = 0; i < 6 && current !== undefined && current !== null && !seen.has(current); i++) {
    seen.add(current);
    if (typeof current === 'string') {
      chain.push({ message: current });
      break;
    }
    chain.push({
      name: typeof current.name === 'string' ? current.name : undefined,
      code: typeof current.code === 'string' ? current.code : undefined,
      message: typeof current.message === 'string' ? current.message : String(current),
    });
    current = current.cause;
  }
  return chain;
}

/**
 * True for the wrapper messages that carry no information on their own and
 * must be replaced by the cause (`TypeError: fetch failed` is the canonical
 * offender — every undici transport failure surfaces under that one string).
 */
function isOpaqueWrapper(hop: { name?: string; message: string }): boolean {
  const m = hop.message.trim().toLowerCase();
  return m === 'fetch failed' || m === 'failed to fetch' || m === 'networkerror when attempting to fetch resource.' || m === '';
}

/**
 * Build the one-line human-readable cause from a cause chain: deepest
 * informative hop first (e.g. `HeadersTimeoutError: Headers Timeout Error
 * (UND_ERR_HEADERS_TIMEOUT)`), then the opaque wrapper mentioned only as a
 * suffix so log greps for `fetch failed` still match.
 */
export function unwrapErrorMessage(error: unknown): string {
  const chain = unwrapCauseChain(error);
  if (chain.length === 0) return 'Unknown error';
  const informative = chain.filter(h => !isOpaqueWrapper(h));
  // Primary = the OUTERMOST informative hop: for generic wrappers
  // (`TypeError: fetch failed` → HeadersTimeoutError) that skips the opaque
  // shell and lands on the real cause; for an already-descriptive outer error
  // (`NetworkError: Connection refused` → 'ECONNREFUSED', or our own
  // AgentRequestError which folds in elapsed/timeout/endpoint) it keeps the
  // descriptive message and only appends the deepest cause's code.
  const primary = informative[0] ?? chain[0];
  const skipLabel = new Set(['Error', 'TypeError', 'AgentRequestError']);
  const label = primary.name && !skipLabel.has(primary.name) && !primary.message.startsWith(primary.name) ? `${primary.name}: ` : '';
  let text = `${label}${primary.message}`;
  if (primary.code && !text.includes(primary.code)) text += ` (${primary.code})`;
  // Deepest distinct code (e.g. UND_ERR_HEADERS_TIMEOUT / ECONNREFUSED) for traceability.
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i];
    if (hop === primary) break;
    const token = hop.code ?? (hop.message.length <= 40 && !hop.name ? hop.message.trim() : undefined);
    if (token && !text.includes(token)) { text += ` [${token}]`; break; }
  }
  const wrappers = chain.filter(h => isOpaqueWrapper(h) && h !== primary);
  if (wrappers.length > 0 && informative.length > 0) {
    text += ` — via ${wrappers.map(w => w.message.trim() || 'empty error').join(' via ')}`;
  }
  return text;
}

/** Extract an HTTP status from the connector's own error wording, if present. */
function httpStatusFromMessage(message: string): number | undefined {
  // RESTConnector: "REST request failed: 503 - <body>"; others: "HTTP 502", "status 504".
  const m = message.match(/(?:request failed:|HTTP|status(?: code)?)\s*(\d{3})\b/i);
  if (!m) return undefined;
  const status = Number(m[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

/** Classify an agent-step error into a coarse kind. */
export function classifyAgentError(error: unknown): { kind: AgentErrorKind; httpStatus?: number } {
  const chain = unwrapCauseChain(error);
  const codes = chain.map(h => h.code).filter((c): c is string => !!c);
  const names = chain.map(h => h.name).filter((n): n is string => !!n);
  const text = chain.map(h => h.message).join(' ');

  if (codes.some(c => TIMEOUT_CODES.has(c)) || names.some(n => /Timeout|AbortError|TimeoutError/i.test(n)) || /\btimed? ?out\b/i.test(text)) {
    return { kind: 'timeout' };
  }
  if (codes.some(c => CONNECTION_CODES.has(c)) || /ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up|certificate/i.test(text)) {
    return { kind: 'connection' };
  }
  const status = (error as any)?.httpStatus ?? (error as any)?.status ?? httpStatusFromMessage(text);
  if (typeof status === 'number' && status >= 100 && status <= 599) {
    return { kind: `http_${status}` as AgentErrorKind, httpStatus: status };
  }
  return { kind: 'unknown' };
}

/**
 * Produce the persisted `agentError` record for a connector failure.
 *
 * The message is ALWAYS the unwrapped cause — `fetch failed` on its own is
 * useless to the person reading the report. When we know the connector's
 * timeout and the failure is a timeout, the message says so explicitly so
 * the remedy (raise `connectorConfig.timeoutMs` or fix the agent's latency)
 * is obvious from the UI alone.
 */
export function describeAgentError(error: unknown, ctx: DescribeAgentErrorContext = {}): AgentErrorInfo {
  const { kind, httpStatus } = classifyAgentError(error);
  let message = unwrapErrorMessage(error);
  if (kind === 'timeout' && ctx.timeoutMs !== undefined && !/\d+\s*ms/.test(message)) {
    message = `${message} — no response within ${ctx.timeoutMs}ms`;
  }
  if (ctx.endpoint && !message.includes(ctx.endpoint)) {
    message = `${message} (${ctx.endpoint})`;
  }
  const info: AgentErrorInfo = { kind, message };
  if (ctx.elapsedMs !== undefined) info.elapsedMs = Math.max(0, Math.round(ctx.elapsedMs));
  if (ctx.endpoint) info.endpoint = ctx.endpoint;
  if (ctx.timeoutMs !== undefined) info.timeoutMs = ctx.timeoutMs;
  if (httpStatus !== undefined) info.httpStatus = httpStatus;
  // Allowlist applied again here (idempotent): the context normally carries
  // the connector's already-filtered set, but a caller that built the context
  // by hand — or forgot `agentErrorContextFrom` — must not persist raw headers.
  const responseHeaders = selectDiagnosticResponseHeaders(
    ctx.responseHeaders ?? (error as Partial<AgentRequestError> | undefined)?.responseHeaders,
  );
  if (responseHeaders) info.responseHeaders = responseHeaders;
  return info;
}

/**
 * Error subclass connectors throw so the runner can persist elapsed/timeout
 * context without re-deriving it. `cause` carries the original error (undici
 * TypeError / AbortError / …) so {@link describeAgentError} can still unwrap.
 */
export class AgentRequestError extends Error {
  readonly endpoint?: string;
  readonly elapsedMs?: number;
  readonly timeoutMs?: number;
  readonly httpStatus?: number;
  /**
   * Diagnostic response headers of the non-2xx reply — connectors pass the
   * reply through {@link selectDiagnosticResponseHeaders} BEFORE attaching
   * it here, so the error object never carries credential-bearing values
   * (errors get logged and serialised).
   */
  readonly responseHeaders?: Record<string, string>;

  constructor(
    message: string,
    options: { cause?: unknown; endpoint?: string; elapsedMs?: number; timeoutMs?: number; httpStatus?: number; responseHeaders?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'AgentRequestError';
    if (options.cause !== undefined) (this as any).cause = options.cause;
    this.endpoint = options.endpoint;
    this.elapsedMs = options.elapsedMs;
    this.timeoutMs = options.timeoutMs;
    this.httpStatus = options.httpStatus;
    this.responseHeaders = options.responseHeaders;
  }
}

/** Read the connector context an {@link AgentRequestError} carries (or nothing). */
export function agentErrorContextFrom(error: unknown, fallback: DescribeAgentErrorContext = {}): DescribeAgentErrorContext {
  const e = error as Partial<AgentRequestError> | undefined;
  return {
    endpoint: e?.endpoint ?? fallback.endpoint,
    elapsedMs: e?.elapsedMs ?? fallback.elapsedMs,
    timeoutMs: e?.timeoutMs ?? fallback.timeoutMs,
    responseHeaders: e?.responseHeaders ?? fallback.responseHeaders,
  };
}
