/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `.env` re-read for a long-lived server (#612, problem 2).
 *
 * A server loads `<cwd>/.env` once at boot (`dotenv`), and dotenv never
 * overrides a variable the shell already exported — so the precedence users
 * rely on is: shell export > `.env` > nothing. Re-reading `.env` later must
 * keep exactly that precedence: a key may be (re)applied only if it was NOT
 * in the shell environment the process was started with.
 *
 * To know that, the set of shell-provided keys is captured BEFORE the first
 * dotenv load (`captureShellEnvSnapshot`, called first thing by both process
 * entry points). The snapshot lives on `globalThis` under a well-known Symbol
 * so the CLI bundle and the server bundle — separate module graphs in one
 * process — see the same one.
 *
 * `reloadDotenv(cwd)` then parses `<cwd>/.env` and, for each key:
 *   - one of `PROCESS_IDENTITY_KEYS` (the port/host/mode this server process
 *     is running with) → never touched (`skipped`): those can only change
 *     with a restart, and the server rewrites `AH_PORT` to the port it
 *     actually bound, which a `.env` edit must never undo;
 *   - shell-provided → never touched (`skipped`);
 *   - current value differs from what the PREVIOUS `.env` read put there →
 *     some code set it since (e.g. the server lifecycle rewriting `AH_PORT`
 *     to the port it actually bound) → never touched (`skipped`). `.env` may
 *     only replace what `.env` put there;
 *   - otherwise set (`applied`).
 * Keys the previous read provided that the file no longer has are unset under
 * the same two guards (`removed`).
 *
 * A missing `.env` is not an error (nothing applied; previously provided keys
 * are removed).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseDotenv } from 'dotenv';

const SNAPSHOT_KEY = Symbol.for('agent-health.shellEnvSnapshot');

/**
 * Variables that describe the RUNNING process (its port, bind host, mode,
 * API key) rather than what a run reads. A `.env` re-read never touches them:
 * the server lifecycle owns `AH_PORT` (rewritten to the bound port), and the
 * others only take effect at startup.
 */
export const PROCESS_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'AH_PORT', 'AGENT_HEALTH_PORT', 'PORT', 'VITE_BACKEND_PORT', 'AH_DEV_PORT', 'AGENT_HEALTH_DEV_PORT',
  'AH_HOST', 'AH_HEADLESS', 'AH_API_KEY', 'NODE_ENV',
]);

export interface ShellEnvSnapshot {
  /** Keys present in `process.env` before any `.env` file was merged. */
  shellKeys: Set<string>;
  /** What the most recent `.env` read provided (boot read included). */
  dotenvValues: Record<string, string>;
}

type GlobalWithSnapshot = typeof globalThis & { [SNAPSHOT_KEY]?: ShellEnvSnapshot };

/**
 * Record which variables the SHELL provided. Idempotent: the first call in a
 * process wins (both bundles call it; whichever runs first is the one that ran
 * before dotenv). `env` / `cwd` are injectable for tests.
 *
 * Degrades safely: if something loaded `.env` before this ran (a
 * `NODE_OPTIONS` preload, an embedder), its keys are classified as shell-
 * provided and are simply never re-applied — the pre-reload behaviour.
 */
export function captureShellEnvSnapshot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ShellEnvSnapshot {
  const g = globalThis as GlobalWithSnapshot;
  if (g[SNAPSHOT_KEY]) return g[SNAPSHOT_KEY];
  const snapshot: ShellEnvSnapshot = {
    shellKeys: new Set(Object.keys(env)),
    dotenvValues: readDotenvFile(cwd),
  };
  g[SNAPSHOT_KEY] = snapshot;
  return snapshot;
}

export function getShellEnvSnapshot(): ShellEnvSnapshot | undefined {
  return (globalThis as GlobalWithSnapshot)[SNAPSHOT_KEY];
}

/** Test-only: forget the process snapshot. */
export function __resetShellEnvSnapshot(): void {
  delete (globalThis as GlobalWithSnapshot)[SNAPSHOT_KEY];
}

function readDotenvFile(cwd: string): Record<string, string> {
  const file = join(cwd, '.env');
  if (!existsSync(file)) return {};
  return parseDotenv(readFileSync(file));
}

export interface ReloadDotenvResult {
  /** Keys set from `.env` (absent from the shell snapshot). */
  applied: string[];
  /** Keys left untouched: the shell provided them, or code changed them since the last read. */
  skipped: string[];
  /** Keys the previous `.env` provided that the file no longer has (unset). */
  removed: string[];
}

/**
 * Re-read `<cwd>/.env` into `env`, preserving shell > `.env` precedence.
 * Without a snapshot (an embedding that never called
 * `captureShellEnvSnapshot`) nothing is applied — there is no safe way to
 * tell a shell export from a boot-time `.env` value.
 */
export function reloadDotenv(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  snapshot: ShellEnvSnapshot | undefined = getShellEnvSnapshot(),
): ReloadDotenvResult {
  const result: ReloadDotenvResult = { applied: [], skipped: [], removed: [] };
  if (!snapshot) return result;
  const parsed = readDotenvFile(cwd);
  const previous = snapshot.dotenvValues;
  // `.env` may only replace what `.env` put there: a shell export, or a value
  // code changed after the last read, is left alone.
  const owned = (key: string): boolean =>
    !PROCESS_IDENTITY_KEYS.has(key) &&
    !snapshot.shellKeys.has(key) &&
    (env[key] === undefined || (key in previous && env[key] === previous[key]));
  for (const key of Object.keys(previous)) {
    if (key in parsed) continue;
    if (!owned(key)) { result.skipped.push(key); continue; }
    delete env[key];
    result.removed.push(key);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!owned(key)) { result.skipped.push(key); continue; }
    env[key] = value;
    result.applied.push(key);
  }
  snapshot.dotenvValues = parsed;
  return result;
}
