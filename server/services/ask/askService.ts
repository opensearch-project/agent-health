/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask service — THE Agent Health assistant: pi's agent loop in-process (pi SDK,
 * same pattern as the agent trace judge) with a fixed, code-enforced list of
 * READ-ONLY tools over this server's own API. No bash, no file access, no MCP,
 * no CLI spawn — `tools: ASK_TOOLS` is the whole tool surface.
 *
 * Threads are pi sessions (see askSessionStore.ts): a follow-up prompts the
 * same pi session, re-opened from its JSONL file if the server restarted.
 *
 * Time-to-first-token: the UI calls `prepareAsk()` as soon as the user starts
 * a question (chip click / composer focus). That builds the page snapshot and
 * creates the pi session while the user is still typing, so `streamAsk()` only
 * has to send the prompt.
 */

import { Type } from 'typebox';
import { resolve } from 'path';
import { readEnv } from '@/lib/envCompat';
import { loadConfigSync } from '@/lib/config/index';
import type { AssistantConfig } from '@/lib/config/index';
import { debug } from '@/lib/debug';
import { getStorageModule } from '@/server/adapters/index';
import type { PiExtensionAPI, PiExtensionFactory, PiSdk, PiSession } from '@/server/services/piSdkTypes';
import { bedrockBaseId, findRequestedModel, pickNewestClaudeModel } from '@/server/services/piAgenticJudgeService';
import {
  buildAskSnapshot,
  buildAskSystemPrompt,
  buildAskUserPrompt,
  resolveAskRefs,
  type AskPageContext,
  type AskRefs,
  type AskSelection,
} from './askContext';
import { PiAskSessionStore, readSession, type AskTurn, type PiSessionManagerLike } from './askSessionStore';
import { withRefreshingBedrockCredentials } from './askModelRuntime';

// ============================================================================
// The ONLY tools the assistant has. Pinned by a unit test.
// ============================================================================

export const ASK_TOOLS = ['get_report', 'get_evaluation_run', 'get_test_case', 'get_benchmark', 'query_spans'] as const;
export type AskToolName = (typeof ASK_TOOLS)[number];

export const ASK_AGENT = { key: 'agent-health-assistant', name: 'Agent Health assistant' } as const;

export const ASK_DEFAULT_MAX_CONCURRENT = 4;
export const ASK_DEFAULT_SESSIONS_DIR = '.agent-health/ask-sessions';
/** One tool lookup against this server's own API. */
export const ASK_DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** One whole answer: model calls + tool lookups. */
export const ASK_DEFAULT_TURN_TIMEOUT_MS = 4 * 60_000;
export const ASK_DEFAULT_MAX_TOOL_CALLS = 30;
/** After an abort, how long a turn may keep its concurrency slot before it is reclaimed regardless (env AH_ASK_ABORT_GRACE_MS). */
export const ASK_ABORT_GRACE_MS = 15_000;

export interface AskSettings {
  enabled: boolean;
  /** Pinned model id (bare or provider-qualified) or undefined for the registry default. */
  model?: string;
  /** Absolute path of the pi session directory. */
  sessionsDir: string;
  maxConcurrent: number;
  toolTimeoutMs: number;
  turnTimeoutMs: number;
  maxToolCalls: number;
}

function positiveInt(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * Effective assistant settings: env overrides (AH_ASK_*), then the `assistant`
 * block of agent-health.config.ts, then defaults. Exported for the status
 * route and unit tests.
 */
export function resolveAskSettings(config: { assistant?: AssistantConfig } = loadConfigSync(), env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AskSettings {
  const a = config.assistant ?? {};
  const dir = env.AH_ASK_SESSIONS_DIR || a.sessionsDir || ASK_DEFAULT_SESSIONS_DIR;
  return {
    enabled: a.enabled !== false,
    model: env.AH_ASK_MODEL_ID || a.model || undefined,
    sessionsDir: resolve(cwd, dir),
    maxConcurrent: positiveInt(a.maxConcurrent) ?? ASK_DEFAULT_MAX_CONCURRENT,
    toolTimeoutMs: positiveInt(env.AH_ASK_TOOL_TIMEOUT_MS, a.toolTimeoutMs) ?? ASK_DEFAULT_TOOL_TIMEOUT_MS,
    turnTimeoutMs: positiveInt(env.AH_ASK_TURN_TIMEOUT_MS, a.turnTimeoutMs) ?? ASK_DEFAULT_TURN_TIMEOUT_MS,
    maxToolCalls: positiveInt(env.AH_ASK_MAX_TOOL_CALLS, a.maxToolCalls) ?? ASK_DEFAULT_MAX_TOOL_CALLS,
  };
}

export class AskBusyError extends Error {
  constructor(max: number) {
    super(`The assistant is already answering ${max} question${max === 1 ? '' : 's'}; try again in a moment.`);
    this.name = 'AskBusyError';
  }
}

// ============================================================================
// Public contract
// ============================================================================

export interface AskRequest {
  question: string;
  selections?: AskSelection[];
  pageContext: AskPageContext;
  /** Existing ask session to continue (follow-up), or one returned by prepareAsk(). */
  sessionId?: string;
}

export interface AskMeta {
  sessionId: string;
  turnId: string;
  agent: { key: string; name: string; model: string };
  refs: AskRefs;
  loaded: string[];
  /** True when the snapshot + pi session were prepared before the question arrived. */
  prepared: boolean;
}

export interface AskCallbacks {
  onMeta(meta: AskMeta): void;
  onDelta(text: string): void;
  onTool(ev: { name: string; status: 'start' | 'end'; isError?: boolean; args?: unknown }): void;
  onDone(result: { answer: string; durationMs: number; firstTokenMs?: number; toolCalls: string[] }): void;
  onError(message: string): void;
}

export interface AskHandle { abort(): void }

// ============================================================================
// pi SDK
// ============================================================================

async function loadPiSdk(): Promise<PiSdk & { SessionManager: any }> {
  const PI_SDK_MODULE = '@earendil-works/pi-coding-agent';
  try {
    return (await import(PI_SDK_MODULE)) as any;
  } catch (err: any) {
    throw new Error(
      'The Agent Health assistant requires the optional dependency "@earendil-works/pi-coding-agent" ' +
        `(${err?.message ?? String(err)}).`
    );
  }
}

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 1) }], details: obj };
}

/**
 * The signal one tool lookup runs under: pi's per-turn abort signal (a client
 * disconnect / turn-budget abort reaches the in-flight fetch AND its body
 * read) combined with a per-call deadline, so a stalled lookup can never pin
 * the turn — pi waits for every tool to settle before `prompt()` resolves.
 */
export function toolSignal(piSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return piSignal ? AbortSignal.any([piSignal, timeout]) : timeout;
}

function describeFetchFailure(err: any, what: string): string {
  const name = err?.name ?? '';
  if (name === 'TimeoutError') return `${what} timed out`;
  if (name === 'AbortError') return `${what} was cancelled`;
  return `${what} failed: ${err?.message ?? String(err)}`;
}

/**
 * Per-turn lookup budget shared by every tool executor of one pi session.
 * Admission happens BEFORE a lookup is dispatched — pi runs the tool calls of
 * one model response in parallel, so an after-the-fact count would let a
 * five-call batch overrun a budget of three. `used` is reset at every turn
 * start by streamAsk; `onExhausted` fires once, when a call beyond the budget
 * is refused (the turn is then cut short with that reason).
 */
export interface ToolBudget {
  used: number;
  max: number;
  /** Lookups admitted since the current model response began (reset on every assistant `message_end`). */
  admittedThisStep: number;
  onExhausted?: (message: string) => void;
}
export function createToolBudget(max = Infinity): ToolBudget { return { used: 0, max, admittedThisStep: 0 }; }

/**
 * Read-only tools over this server's own REST API (GETs + the POST /api/traces
 * read). `toolTimeoutMs` bounds each lookup (see AssistantConfig.toolTimeoutMs);
 * `budget` caps how many lookups one answer may dispatch.
 */
export function createAskToolsExtension(serverUrl: string, toolTimeoutMs = ASK_DEFAULT_TOOL_TIMEOUT_MS, budget: ToolBudget = createToolBudget()): PiExtensionFactory {
  /**
   * Admit one lookup against the turn budget, or the error result the model
   * gets instead. A batch that overruns keeps its admitted lookups and the
   * model is told to answer with what it has; a model response that asks for
   * lookups when the budget is already spent (nothing admitted this step) is
   * what cuts the turn short.
   */
  const admit = (): ReturnType<typeof textResult> | null => {
    if (budget.used >= budget.max) {
      if (budget.admittedThisStep === 0) budget.onExhausted?.(`The assistant stopped after ${budget.max} tool lookups (assistant.maxToolCalls).`);
      return textResult({ error: `Tool budget exhausted: this answer may make at most ${budget.max} lookups. Answer with the data you already have.` });
    }
    budget.used += 1;
    budget.admittedThisStep += 1;
    return null;
  };
  const getJson = async (path: string, signal: AbortSignal | undefined) => {
    try {
      const res = await fetch(`${serverUrl}${path}`, { signal: toolSignal(signal, toolTimeoutMs) });
      if (!res.ok) return { error: `HTTP ${res.status} for ${path}` };
      return await res.json();
    } catch (err: any) {
      return { error: describeFetchFailure(err, `GET ${path}`) };
    }
  };
  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: 'get_report',
      label: 'Get a test-case report',
      description: 'Fetch one per-test-case report (full trajectory, judge verdict + reasoning, metrics, traceId) by reportId. Only for reports NOT already in the snapshot.',
      parameters: Type.Object({ reportId: Type.String() }),
      async execute(_id: string, p: { reportId: string }, signal?: AbortSignal) {
        const refused = admit(); if (refused) return refused;
        const data: any = await getJson(`/api/storage/runs/${encodeURIComponent(p.reportId)}`, signal);
        const r = data?.run ?? data;
        if (Array.isArray(r?.trajectory)) {
          r.trajectory = r.trajectory.map((s: any, i: number) => ({
            i, type: s.type, toolName: s.toolName,
            content: typeof s.content === 'string' ? s.content.slice(0, 1500) : s.content,
            toolArgs: s.toolArgs, toolOutput: typeof s.toolOutput === 'string' ? s.toolOutput.slice(0, 1500) : s.toolOutput,
          }));
        }
        if (r) delete r.rawEvents;
        return textResult(r);
      },
    });
    pi.registerTool({
      name: 'get_evaluation_run',
      label: 'Get an evaluation run',
      description: 'Fetch an evaluation run (benchmark execution): agent, stats, per-test-case results {testCaseId: {reportId, status, testCase}}.',
      parameters: Type.Object({ runId: Type.String() }),
      async execute(_id: string, p: { runId: string }, signal?: AbortSignal) {
        const refused = admit(); if (refused) return refused;
        const data: any = await getJson(`/api/storage/evaluation-runs/${encodeURIComponent(p.runId)}`, signal);
        const run = data?.evaluationRun ?? data;
        if (run?.testCaseSnapshots) {
          const names = Object.fromEntries(run.testCaseSnapshots.map((s: any) => [s.id, s.name]));
          run.results = Object.fromEntries(
            Object.entries(run.results ?? {}).map(([tc, r]: [string, any]) => [tc, { ...r, testCase: names[tc] }])
          );
          delete run.testCaseSnapshots;
        }
        return textResult(run);
      },
    });
    pi.registerTool({
      name: 'get_test_case',
      label: 'Get a test case',
      description: 'Fetch a test case definition (prompt, expected outcomes, labels).',
      parameters: Type.Object({ testCaseId: Type.String() }),
      async execute(_id: string, p: { testCaseId: string }, signal?: AbortSignal) {
        const refused = admit(); if (refused) return refused;
        const data: any = await getJson(`/api/storage/test-cases/${encodeURIComponent(p.testCaseId)}`, signal);
        const tc = data?.testCase ?? data;
        if (tc) delete tc.sourceCode;
        return textResult(tc);
      },
    });
    pi.registerTool({
      name: 'get_benchmark',
      label: 'Get a benchmark',
      description: 'Fetch a benchmark (name, test case ids, run summaries with stats).',
      parameters: Type.Object({ benchmarkId: Type.String() }),
      async execute(_id: string, p: { benchmarkId: string }, signal?: AbortSignal) {
        const refused = admit(); if (refused) return refused;
        const data: any = await getJson(`/api/storage/benchmarks/${encodeURIComponent(p.benchmarkId)}?fields=full`, signal);
        const b = data?.benchmark ?? data;
        if (Array.isArray(b?.runs)) {
          b.runs = b.runs.slice(-30).map((r: any) => ({ id: r.id, name: r.name, createdAt: r.createdAt, status: r.status, agentKey: r.agentKey, stats: r.stats }));
        }
        return textResult(b);
      },
    });
    pi.registerTool({
      name: 'query_spans',
      label: 'Query OTel spans',
      description:
        'Fetch the OpenTelemetry spans of a run by traceId (preferred), runId (agent run id) and/or sessionId. ' +
        'Returns span names, timing, status and gen_ai.* attributes. Optional nameFilter substring.',
      parameters: Type.Object({
        traceId: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        nameFilter: Type.Optional(Type.String()),
      }),
      async execute(_id: string, p: { traceId?: string; runId?: string; sessionId?: string; nameFilter?: string }, signal?: AbortSignal) {
        if (!p.traceId && !p.runId && !p.sessionId) return textResult({ error: 'Provide traceId, runId or sessionId.' });
        const refused = admit(); if (refused) return refused;
        const body: Record<string, unknown> = { size: 300 };
        if (p.traceId) body.traceId = p.traceId;
        if (p.runId) body.runIds = [p.runId];
        if (p.sessionId) body.agents = [{ serviceName: 'unknown', sessionId: p.sessionId, startedAt: 0, endedAt: Date.now() }];
        let data: any;
        try {
          const res = await fetch(`${serverUrl}/api/traces`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            signal: toolSignal(signal, toolTimeoutMs),
          });
          if (!res.ok) return textResult({ error: `traces query failed: HTTP ${res.status}` });
          data = await res.json();
        } catch (err: any) {
          return textResult({ error: describeFetchFailure(err, 'traces query') });
        }
        let spans: any[] = Array.isArray(data?.spans) ? data.spans : [];
        if (p.nameFilter) {
          const f = p.nameFilter.toLowerCase();
          spans = spans.filter((s) => String(s?.name ?? '').toLowerCase().includes(f));
        }
        return textResult({
          correlation: data?.correlation,
          spanCount: spans.length,
          spans: spans.map((s) => ({
            spanId: s.spanId, parentSpanId: s.parentSpanId, traceId: s.traceId, name: s.name,
            startTime: s.startTime, endTime: s.endTime, durationMs: s.durationMs ?? s.duration, status: s.status,
            attributes: s.attributes,
          })),
        });
      },
    });
  };
}

function serverUrl(): string {
  return process.env.AH_JUDGE_SERVER_URL || `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;
}

// ----------------------------------------------------------------------------
// Process-wide runtime cache (pi model registry). Re-read every few minutes so
// a new pin / newly credentialed provider is picked up. Credentials are NOT
// what this cache is for: Bedrock calls resolve them per call through the
// refreshing provider (askModelRuntime.ts), so a live session never signs
// with stale keys.
// ----------------------------------------------------------------------------

interface Runtime { sdk: Awaited<ReturnType<typeof loadPiSdk>>; modelRuntime: any; model: { provider: string; id: string }; at: number; pin?: string }
let runtimeCache: Runtime | null = null;
let runtimePending: Promise<Runtime> | null = null;
const RUNTIME_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the operator's model pin against the credentialed registry.
 * `provider/id` matches that provider only (the same id can exist under
 * several providers — anthropic vs amazon-bedrock — and the pin decides where
 * data is sent); a bare id matches any provider. Within the match, Bedrock's
 * region-appropriate inference profile is preferred (findRequestedModel).
 * An unavailable pin is an ERROR, never a silent fallback to another model.
 */
export function resolvePinnedModel<T extends { provider: string; id: string }>(available: T[], pin: string): T {
  // `provider/id` only when the prefix names a registry provider: Bedrock ARN
  // ids (`arn:aws:bedrock:…:inference-profile/x`) contain a slash too.
  const slash = pin.indexOf('/');
  const prefix = slash > 0 ? pin.slice(0, slash) : undefined;
  const provider = prefix && available.some((m) => m.provider === prefix) ? prefix : undefined;
  const id = provider ? pin.slice(slash + 1) : pin;
  const pool = provider ? available.filter((m) => m.provider === provider) : available;
  // A pin that already names an inference-profile variant (`global.…`, `eu.…`)
  // is taken verbatim; a bare Bedrock id keeps the region-profile preference
  // (bare Claude 4.x ids cannot run on-demand) — findRequestedModel.
  const exact = pool.find((m) => m.id === id);
  const model = exact && (exact.provider !== 'amazon-bedrock' || bedrockBaseId(id) !== id) ? exact : findRequestedModel(pool, id);
  if (!model) {
    const have = available.map((m) => `${m.provider}/${m.id}`);
    throw new Error(
      `Agent Health assistant: pinned model "${pin}" is not in the credentialed pi registry` +
        (have.length ? ` (available: ${have.slice(0, 8).join(', ')}${have.length > 8 ? ', …' : ''}).` : ' (no credentialed model at all).')
    );
  }
  return model;
}

async function getRuntime(): Promise<Runtime> {
  const pin = resolveAskSettings().model;
  if (runtimeCache && runtimeCache.pin === pin && Date.now() - runtimeCache.at < RUNTIME_TTL_MS) return runtimeCache;
  if (runtimePending) return runtimePending;
  runtimePending = (async () => {
    const sdk = await loadPiSdk();
    const modelRuntime = withRefreshingBedrockCredentials(await sdk.ModelRuntime.create());
    const available = (await modelRuntime.getAvailable()) as Array<{ provider: string; id: string }>;
    const model = pin ? resolvePinnedModel(available, pin) : pickNewestClaudeModel(available);
    if (!model) throw new Error('Agent Health assistant: no credentialed model in the pi registry (configure a Bedrock/Anthropic model for pi).');
    runtimeCache = { sdk, modelRuntime, model, at: Date.now(), pin };
    return runtimeCache;
  })().finally(() => { runtimePending = null; });
  return runtimePending;
}

// ----------------------------------------------------------------------------
// Live sessions
// ----------------------------------------------------------------------------

interface LiveSession {
  id: string;
  session: PiSession & { subscribe?: (l: (e: any) => void) => () => void };
  sm: PiSessionManagerLike;
  model: string;
  page: AskPageContext;
  /** Snapshot built for the first turn (consumed by the first prompt). */
  snapshot?: { markdown: string; refs: AskRefs; loaded: string[] };
  /** Whether any turn has been prompted in this process. */
  turns: number;
  lastUsed: number;
  /**
   * Ownership token of the turn currently using this pi session, or null when
   * idle. Only the holder may release it or abort the session — a request
   * refused because the session is held must not clear someone else's hold.
   */
  heldBy: string | null;
  /** The lookup budget shared by this pi session's tool executors (reset per turn). */
  toolBudget: ToolBudget;
}
const live = new Map<string, LiveSession>();
/** Cold resumes in flight, keyed by session id: two follow-ups racing after a restart open ONE pi session, not two writers on one JSONL. */
const opening = new Map<string, Promise<LiveSession | null>>();
const LIVE_TTL_MS = 30 * 60 * 1000;
/** Prepared-but-never-asked sessions are cheap but unbounded under spam; keep at most this many around. */
export const LIVE_UNUSED_MAX = 200;
function evictUnusedLiveSessions(): void {
  const unused = [...live.values()].filter((s) => s.turns === 0 && !s.heldBy).sort((a, b) => a.lastUsed - b.lastUsed);
  for (let i = 0; i < unused.length - LIVE_UNUSED_MAX; i++) live.delete(unused[i].id);
}
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of live) if (!s.heldBy && now - s.lastUsed > LIVE_TTL_MS) live.delete(id);
}, 5 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

let storeSingleton: PiAskSessionStore | null = null;
async function getStore(): Promise<PiAskSessionStore> {
  const dir = resolveAskSettings().sessionsDir;
  if (!storeSingleton || storeSingleton.dir !== dir) {
    const sdk = await loadPiSdk();
    storeSingleton = new PiAskSessionStore(sdk.SessionManager, dir);
  }
  return storeSingleton;
}

/** Questions being answered right now (concurrency cap, see AssistantConfig.maxConcurrent). */
let answering = 0;
export function askInFlight(): number { return answering; }
export async function getAskSessionStore(): Promise<PiAskSessionStore> { return getStore(); }

async function createPiSession(rt: Runtime, sm: PiSessionManagerLike): Promise<{ session: LiveSession['session']; toolBudget: ToolBudget }> {
  const { createAgentSession, DefaultResourceLoader, getAgentDir } = rt.sdk;
  const toolBudget = createToolBudget();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => buildAskSystemPrompt(),
    appendSystemPromptOverride: () => [],
    extensionFactories: [createAskToolsExtension(serverUrl(), resolveAskSettings().toolTimeoutMs, toolBudget)],
    // Headless + isolated: no user extensions/skills/themes/context files.
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    model: rt.model,
    modelRuntime: rt.modelRuntime,
    resourceLoader,
    // READ-ONLY by construction: exactly these tools, nothing built-in.
    tools: [...ASK_TOOLS],
    sessionManager: sm,
  });
  return { session: session as LiveSession['session'], toolBudget };
}

/**
 * Build the page snapshot and create the pi session BEFORE the question
 * arrives. Returns the session id the client must send with `streamAsk`.
 */
export async function prepareAsk(input: { pageContext: AskPageContext; selections?: AskSelection[] }): Promise<{ sessionId: string; refs: AskRefs; loaded: string[]; model: string }> {
  const t0 = Date.now();
  const [rt, store, snapshot] = await Promise.all([
    getRuntime(),
    getStore(),
    buildAskSnapshot(getStorageModule(), resolveAskRefs(input.pageContext)),
  ]);
  const selections = (input.selections ?? []).filter((s) => s && typeof s.text === 'string' && s.text.trim());
  const sm = store.create({ page: input.pageContext, selections, firstQuestion: '' });
  const { session, toolBudget } = await createPiSession(rt, sm);
  const id = sm.getSessionId();
  live.set(id, { id, session, sm, model: `${rt.model.provider}/${rt.model.id}`, page: input.pageContext, snapshot, turns: 0, lastUsed: Date.now(), heldBy: null, toolBudget });
  evictUnusedLiveSessions();
  debug('Ask', 'prepared', id, 'in', Date.now() - t0, 'ms; loaded:', snapshot.loaded.join(', '));
  return { sessionId: id, refs: snapshot.refs, loaded: snapshot.loaded, model: `${rt.model.provider}/${rt.model.id}` };
}

/**
 * Get a live session: prepared in memory, or re-opened from its pi JSONL file
 * (restart), or null. Cold opens are single-flight per id.
 */
async function resumeSession(id: string, rt: Runtime): Promise<LiveSession | null> {
  const found = live.get(id);
  if (found) return found;
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;
  const open = (async () => {
    const store = await getStore();
    const sm = store.open(id);
    if (!sm) return null;
    const detail = readSession(sm);
    const { session, toolBudget } = await createPiSession(rt, sm);
    const ls: LiveSession = { id, session, sm, model: `${rt.model.provider}/${rt.model.id}`, page: detail?.page ?? { route: '/' }, turns: detail?.turns.length ?? 1, lastUsed: Date.now(), heldBy: null, toolBudget };
    live.set(id, ls);
    debug('Ask', 'resumed pi session from file', sm.getSessionFile());
    return ls;
  })().finally(() => { opening.delete(id); });
  opening.set(id, open);
  return open;
}

function textOf(message: any): string {
  return Array.isArray(message?.content)
    ? message.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('')
    : '';
}

/**
 * The outcome of ONE turn, from the assistant messages pi FINISHED during it
 * (`message_end` events collected while the prompt ran — never an index into
 * `session.messages`, which auto-compaction rewrites mid-turn, and never
 * earlier turns: a failed follow-up must not surface the previous answer). pi
 * reports provider failures as an assistant message with `stopReason: "error"`
 * — `prompt()` resolves normally — so the terminal assistant message's stop
 * reason decides.
 */
export function summarizeTurn(turnMessages: any[]): { answer: string; error?: string; aborted?: boolean } {
  const assistants = (turnMessages ?? []).filter((m) => m?.role === 'assistant');
  const terminal = assistants[assistants.length - 1];
  // The answer is the final assistant text of this turn (after any tool round-trips).
  let answer = '';
  for (const m of assistants) { const t = textOf(m); if (t.trim()) answer = t; }
  if (terminal?.stopReason === 'aborted') return { answer, aborted: true };
  if (terminal?.stopReason === 'error') return { answer, error: terminal.errorMessage || 'The model call failed.' };
  return { answer };
}

// ============================================================================
// Entry point
// ============================================================================

export function streamAsk(req: AskRequest, cb: AskCallbacks): AskHandle {
  const signal = { aborted: false };
  const startedAt = Date.now();
  let firstTokenMs: number | undefined;
  const firstToken = () => { if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt; };
  const toolCalls: string[] = [];
  const token = `hold-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let ls: LiveSession | null = null;
  let counted = false;
  /** Why this turn was cut short by us (client gone / budget), if it was. */
  let cutShort: string | undefined;

  const releaseSlot = () => { if (counted) { answering -= 1; counted = false; } };
  const releaseHold = () => { if (ls && ls.heldBy === token) { ls.heldBy = null; ls.lastUsed = Date.now(); } };
  /**
   * Resolves ASK_ABORT_GRACE_MS after the first abort: the hard bound on how
   * long a cancelled turn may keep its concurrency SLOT. The session hold is a
   * different matter — see `stillRunning` below.
   */
  let graceTimer: NodeJS.Timeout | undefined;
  let fireGrace: () => void = () => {};
  const graceExpired = new Promise<void>((r) => { fireGrace = r; });
  const startGrace = () => {
    if (graceTimer) return;
    graceTimer = setTimeout(fireGrace, positiveInt(process.env.AH_ASK_ABORT_GRACE_MS) ?? ASK_ABORT_GRACE_MS);
    graceTimer.unref?.();
  };
  let abortRequested = false;
  const abortTurn = (reason?: string) => {
    if (reason && !cutShort) cutShort = reason;
    if (abortRequested || !ls || ls.heldBy !== token) return;
    abortRequested = true;
    ls.session.abort?.().catch(() => { /* ignore */ });
    startGrace();
  };
  /**
   * When the grace expires before `prompt()` settles, the turn's slot is given
   * back but the pi session stays HELD by this token until the prompt really
   * settles: a second writer on the same JSONL (two pi sessions appending to one
   * thread) is never opened. Follow-ups meanwhile get the "still answering"
   * refusal; the hold is released by the late settle.
   */
  let stillRunning: Promise<unknown> | null = null;

  (async () => {
    try {
      const settings = resolveAskSettings();
      const rt = await getRuntime();
      const selections = (req.selections ?? []).filter((s) => s && typeof s.text === 'string' && s.text.trim());
      let prepared = false;
      if (req.sessionId) {
        ls = await resumeSession(req.sessionId, rt);
        if (!ls) throw new Error(`Ask session ${req.sessionId} not found`);
        prepared = !!ls.snapshot;
      }
      if (!ls) {
        const p = await prepareAsk({ pageContext: req.pageContext, selections });
        ls = live.get(p.sessionId)!;
      }
      if (ls.heldBy) throw new Error('This ask session is still answering a previous question.');
      if (answering >= settings.maxConcurrent) throw new AskBusyError(settings.maxConcurrent);
      // From here on this request OWNS the session and a concurrency slot.
      answering += 1;
      counted = true;
      ls.heldBy = token;
      ls.lastUsed = Date.now();
      if (signal.aborted) return; // the client left while we were resuming; nothing was started
      if (ls.turns === 0) ls.sm.appendSessionInfo(req.question.slice(0, 120));

      // First turn: the prepared snapshot. Follow-ups: pi already has the
      // snapshot in context; only send a fresh one if the page changed.
      const sameRoute = ls.page.route === req.pageContext.route;
      let snapshot = ls.snapshot;
      if (!snapshot && (ls.turns === 0 || !sameRoute)) {
        snapshot = await buildAskSnapshot(getStorageModule(), resolveAskRefs(req.pageContext));
      }
      ls.snapshot = undefined;
      const refs = snapshot?.refs ?? resolveAskRefs(req.pageContext);
      const turnId = `turn-${Date.now().toString(36)}`;
      // The client left while the snapshot was being built: never invoke the model.
      if (signal.aborted) return;
      cb.onMeta({
        sessionId: ls.id, turnId,
        agent: { ...ASK_AGENT, model: ls.model },
        refs, loaded: snapshot?.loaded ?? [], prepared,
      });

      const userPrompt = buildAskUserPrompt({
        question: req.question,
        selections,
        page: req.pageContext,
        refs,
        snapshotMarkdown: snapshot?.markdown ?? '',
        isFollowUp: ls.turns > 0,
      });
      debug('Ask', 'session', ls.id, 'turn', ls.turns + 1, 'prompt chars', userPrompt.length, 'prepared', prepared);

      let streamed = '';
      /** Assistant messages pi finished during THIS turn (stable across compaction, retries). */
      const turnAssistants: any[] = [];
      ls.toolBudget.used = 0;
      ls.toolBudget.admittedThisStep = 0;
      ls.toolBudget.max = settings.maxToolCalls;
      ls.toolBudget.onExhausted = (message) => abortTurn(message);
      const unsubscribe = ls.session.subscribe?.((event: any) => {
        if (event.type === 'message_end' && event.message?.role === 'assistant') { turnAssistants.push(event.message); ls!.toolBudget.admittedThisStep = 0; }
        if (signal.aborted) return;
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          const d: string = event.assistantMessageEvent.delta ?? '';
          if (!d) return;
          streamed += d; firstToken(); cb.onDelta(d);
        } else if (event.type === 'message_start' && event.message?.role === 'assistant' && streamed) {
          streamed += '\n\n'; cb.onDelta('\n\n');
        } else if (event.type === 'tool_execution_start') {
          toolCalls.push(event.toolName);
          cb.onTool({ name: event.toolName, status: 'start', args: event.args });
        } else if (event.type === 'tool_execution_end') {
          cb.onTool({ name: event.toolName, status: 'end', isError: !!event.isError });
        }
      });
      // Turn budget: wall clock for model calls + tool lookups together.
      const budget = setTimeout(() => abortTurn(`The assistant ran out of time after ${Math.round(settings.turnTimeoutMs / 1000)}s (assistant.turnTimeoutMs).`), settings.turnTimeoutMs);
      const turnStartedAt = new Date().toISOString();
      let settledInTime = true;
      const running = ls.session.prompt(userPrompt);
      try {
        // An abort is cooperative: pi waits for the provider / tool to honour
        // the signal. If something ignores it, the concurrency slot is given
        // back after a grace period; the session hold is kept until the prompt
        // really settles (`stillRunning`), so no second writer is opened.
        settledInTime = await Promise.race([
          running.then(() => true),
          graceExpired.then(() => false),
        ]);
      } finally {
        clearTimeout(budget);
        if (graceTimer) clearTimeout(graceTimer);
        if (settledInTime) unsubscribe?.();
      }
      if (!settledInTime) {
        stillRunning = running.catch(() => undefined).finally(() => { unsubscribe?.(); ls!.turns += 1; });
        throw new Error(cutShort ?? 'The answer did not stop after it was cancelled.');
      }
      ls.turns += 1; // a thrown prompt leaves `turns` alone: the next question is still the first and rebuilds its snapshot
      const outcome = summarizeTurn(turnAssistants);
      const answer = outcome.answer || streamed;
      const durationMs = Date.now() - startedAt;
      let error: string | undefined;
      if (cutShort) error = cutShort;
      else if (outcome.error) error = outcome.error;
      else if (outcome.aborted) error = signal.aborted ? 'Cancelled' : 'The answer was interrupted.';
      else if (!answer.trim()) error = 'The assistant returned no text.';
      const turn: AskTurn = {
        id: turnId, question: req.question, answer, selections, startedAt: turnStartedAt,
        completedAt: new Date().toISOString(), durationMs, firstTokenMs, toolCalls: [...toolCalls], error,
      };
      (await getStore()).recordTurn(ls.sm, turn);
      if (signal.aborted) return;
      if (error) cb.onError(error);
      else cb.onDone({ answer, durationMs, firstTokenMs, toolCalls: [...toolCalls] });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      debug('Ask', 'failed:', message);
      if (!signal.aborted) cb.onError(message);
    } finally {
      // Whatever happened, this request gives back exactly what it took — the
      // session hold only once its prompt has actually settled.
      releaseSlot();
      if (stillRunning) stillRunning.then(releaseHold);
      else releaseHold();
    }
  })();

  return {
    abort() {
      signal.aborted = true;
      abortTurn();
    },
  };
}

/** Test hook: drop in-memory sessions and the runtime cache. @internal */
export function resetAskServiceState(): void {
  live.clear();
  opening.clear();
  runtimeCache = null;
  runtimePending = null;
  storeSingleton = null;
  answering = 0;
}
