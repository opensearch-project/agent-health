/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Matcher session — collects MatcherResult[] for the currently-executing
 * test body. Matchers (expect/judge/traces) record into the active session
 * via `recordVerdict`.
 *
 * Concurrency model (RFC 004, "kills the global session"):
 *
 *   The session is held in an AsyncLocalStorage so that bodies running
 *   concurrently (the runners dispatch up to `concurrency` tests at once,
 *   interleaving at every `await`) each record into their OWN session.
 *   Before this, a single module-level `activeSession` was shared by all
 *   in-flight bodies, so verdicts cross-contaminated between tests.
 *
 *   `runInSession(fn)` is the concurrency-safe entry point and is what the
 *   runners use: it establishes a fresh session for the duration of `fn`
 *   (and everything it `await`s) and returns the collected results.
 *
 *   The legacy `startSession()` / `endSession()` pair is retained for
 *   synchronous, non-interleaved callers (unit tests, simple scripts). It
 *   uses a module-global fallback session. When an AsyncLocalStorage scope
 *   is active (i.e. we're inside `runInSession`), the ALS session always
 *   takes precedence over the global, so the two never collide.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { MatcherResult, MatcherMethod } from './types.js';

export interface MatcherSession {
  results: MatcherResult[];
  startedAt: number;
}

/** Per-async-context session. Set for the duration of `runInSession(fn)`. */
const sessionStore = new AsyncLocalStorage<MatcherSession>();

/** Legacy module-global session for direct startSession()/endSession() callers. */
let legacySession: MatcherSession | null = null;

function newSession(): MatcherSession {
  return { results: [], startedAt: Date.now() };
}

/** The session verdicts should be recorded into right now, if any. */
function currentSession(): MatcherSession | null {
  return sessionStore.getStore() ?? legacySession;
}

/**
 * Run `fn` with a fresh, isolated matcher session and return the verdicts
 * recorded during it. Concurrency-safe: each call gets its own session via
 * AsyncLocalStorage, so interleaved bodies never share verdicts.
 *
 * Results are returned even when `fn` throws — the caller can inspect both
 * the partial results and the error (cleanup hooks that record after a body
 * failure therefore still surface in the breakdown).
 */
export async function runInSession<T>(
  fn: () => Promise<T> | T
): Promise<{ results: MatcherResult[]; value?: T; error?: unknown }> {
  const session = newSession();
  try {
    const value = await sessionStore.run(session, fn);
    return { results: session.results, value };
  } catch (error) {
    return { results: session.results, error };
  }
}

/**
 * Begin a fresh global session and make it active (legacy API).
 *
 * Prefer {@link runInSession} for anything that may run concurrently. This
 * remains for synchronous, single-threaded callers.
 */
export function startSession(): MatcherSession {
  legacySession = newSession();
  return legacySession;
}

/** Stop the current global session and return its results (legacy API). */
export function endSession(): MatcherResult[] {
  if (!legacySession) return [];
  const out = legacySession.results;
  legacySession = null;
  return out;
}

/** True when a session is active (ALS scope or legacy global). */
export function isSessionActive(): boolean {
  return currentSession() !== null;
}

/** Record a single matcher verdict on the active session. No-op when none. */
export function recordVerdict(result: MatcherResult): void {
  const session = currentSession();
  if (!session) return;
  session.results.push(result);
}

/**
 * Record a verdict computed from a try/catch around the matcher body.
 * Convenience wrapper used by judge() and traces helpers; chai matchers go
 * through the chai plugin in `./expect.ts`.
 */
export async function recordWithTiming<T>(
  description: string,
  method: MatcherMethod,
  fn: () => Promise<T> | T
): Promise<T> {
  const start = Date.now();
  try {
    const value = await fn();
    recordVerdict({
      description,
      pass: true,
      method,
      durationMs: Date.now() - start,
    });
    return value;
  } catch (err: any) {
    recordVerdict({
      description,
      pass: false,
      method,
      durationMs: Date.now() - start,
      errorMessage: err?.message || String(err),
    });
    throw err;
  }
}
