/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Config state paths + mode resolution (config v2, #271).
 *
 * Two modes, decided by the presence of an authored config file:
 *
 *  - **code-first**: an `agent-health.config.{ts,js,mjs}` exists (project OR
 *    user scope). The authored file (+ `.env`) is the single source of truth;
 *    the runtime state file is **ignored entirely**, and the Settings UI write
 *    paths are disabled.
 *  - **ui-first**: no authored config file anywhere. Runtime state lives in
 *    `.agent-health/state.json`, written by the Settings UI / CLI.
 *
 * `.agent-health/` is scoped at both **user** (`~/.agent-health/`) and
 * **project** (`<cwd>/.agent-health/`) level, project overriding user.
 *
 * This module is the single owner of those paths + the mode rule. All runtime
 * state owners (configService, customAgentStore, debug, remoteServers) read and
 * write through it so there is no split-brain across files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';

export const STATE_DIRNAME = '.agent-health';
export const STATE_FILENAME = 'state.json';

/**
 * Generated data lives UNDER the app-managed state dir: `.agent-health/data/`
 * (runs, benchmarks, test-cases, analytics, profiles, skill-evals,
 * uploaded-skills). Combined with state.json so there is ONE app-managed,
 * gitignored directory — not a second top-level `agent-health-data/`.
 */
export const DATA_DIRNAME = 'data';

/** Authored config filenames, in priority order (shared with lib/config/loader). */
export const AUTHORED_CONFIG_NAMES = [
  'agent-health.config.ts',
  'agent-health.config.js',
  'agent-health.config.mjs',
];

/** Legacy single-file runtime config (pre config-v2); migrated to STATE_FILENAME. */
export const LEGACY_JSON_FILENAME = 'agent-health.config.json';

export type StateScope = 'project' | 'user';

// ── Path helpers ────────────────────────────────────────────────────────────

export function projectStateDir(cwd: string = process.cwd()): string {
  return join(cwd, STATE_DIRNAME);
}
export function userStateDir(): string {
  return join(homedir(), STATE_DIRNAME);
}
export function projectStatePath(cwd: string = process.cwd()): string {
  return join(projectStateDir(cwd), STATE_FILENAME);
}
export function userStatePath(): string {
  return join(userStateDir(), STATE_FILENAME);
}
/** Generated-data dir, nested under the project state dir: `<cwd>/.agent-health/data`. */
export function projectDataDir(cwd: string = process.cwd()): string {
  return join(projectStateDir(cwd), DATA_DIRNAME);
}
export function statePathForScope(scope: StateScope, cwd: string = process.cwd()): string {
  return scope === 'user' ? userStatePath() : projectStatePath(cwd);
}

// ── Mode detection ───────────────────────────────────────────────────────────

/**
 * Locate an authored config file (project scope first, then user scope).
 * Returns its absolute path, or null if none exists.
 */
export function findAuthoredConfig(cwd: string = process.cwd()): string | null {
  for (const name of AUTHORED_CONFIG_NAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  for (const name of AUTHORED_CONFIG_NAMES) {
    const p = join(userStateDir(), name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function hasAuthoredConfig(cwd: string = process.cwd()): boolean {
  return findAuthoredConfig(cwd) !== null;
}

/**
 * Code-first mode = an authored config file is present. In this mode the
 * runtime state file is ignored entirely (strict rule, #271).
 */
export function isCodeFirstMode(cwd: string = process.cwd()): boolean {
  return hasAuthoredConfig(cwd);
}

// ── State read/write ─────────────────────────────────────────────────────────

/**
 * Read a single state file. Returns `{}` when missing/corrupt (safe to create);
 * never throws.
 */
export function readStateFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[statePaths] ${path} is not a JSON object — ignoring`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.warn(`[statePaths] Failed to read ${path}:`, (err as Error).message);
    return {};
  }
}

/**
 * Layered runtime state: project overrides user, shallow per top-level key.
 * Returns `{}` in code-first mode (state ignored).
 */
export function readLayeredState(cwd: string = process.cwd()): Record<string, unknown> {
  if (isCodeFirstMode(cwd)) return {};
  const user = readStateFile(userStatePath());
  const project = readStateFile(projectStatePath(cwd));
  return { ...user, ...project };
}

/**
 * Which scope supplies a given top-level key, or null if absent / code-first.
 * Used for UI source attribution.
 */
export function stateKeyScope(key: string, cwd: string = process.cwd()): StateScope | null {
  if (isCodeFirstMode(cwd)) return null;
  if (key in readStateFile(projectStatePath(cwd))) return 'project';
  if (key in readStateFile(userStatePath())) return 'user';
  return null;
}

/**
 * Read the raw state object for a single scope (no layering). Used by owners
 * that need to merge against the exact file they will write back.
 */
export function readStateScope(scope: StateScope, cwd: string = process.cwd()): Record<string, unknown> {
  return readStateFile(statePathForScope(scope, cwd));
}

/**
 * Strict read for the write path: returns `{}` when the file is missing (safe
 * to create), `null` when it exists but is unreadable/corrupt (unsafe to
 * overwrite — would clobber).
 */
function readStateFileOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Merge `patch` into a scope's state file, preserving sibling keys. A key whose
 * value is `undefined` is deleted. Creates the `.agent-health/` dir as needed.
 *
 * Throws in code-first mode — runtime state must not be written when an
 * authored config file is present.
 */
export function writeStateScope(
  patch: Record<string, unknown>,
  scope: StateScope = 'project',
  cwd: string = process.cwd(),
): void {
  if (isCodeFirstMode(cwd)) {
    throw new Error(
      'Cannot write runtime state: data sources are managed by agent-health.config.ts (code-first mode). ' +
      'Edit the config file and restart.',
    );
  }
  const path = statePathForScope(scope, cwd);
  const dir = scope === 'user' ? userStateDir() : projectStateDir(cwd);
  const existing = readStateFileOrNull(path);
  if (existing === null) {
    throw new Error(`Cannot write runtime state: ${path} is unreadable or corrupt`);
  }
  const merged = { ...existing, ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
