/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval roots — where the server looks for code-SDK eval source files.
 *
 * Stored code-SDK test cases carry a RELATIVE `sourceFile` (e.g.
 * `evals/demo.eval.mjs`). Historically that path was resolved against the
 * server's `process.cwd()` only, which breaks the moment the server runs
 * from a different directory than the eval suites (a shared deployment
 * started from the agent-health checkout while the suites live in another
 * repo). This module is the single owner of the ordered list of directories
 * a relative `sourceFile` is resolved against — first hit wins.
 *
 * Precedence (highest first):
 *   1. `AGENT_HEALTH_EVAL_ROOTS` env — `path.delimiter`-separated (`:` on
 *      POSIX, `;` on Windows).
 *   2. `evalRoots` in `agent-health.config.ts` (code-first; registered by the
 *      server at startup via {@link setConfiguredEvalRoots}) or in
 *      `.agent-health/state.json` (ui-first; read through the layered state
 *      resolver, which returns `{}` in code-first mode).
 *   3. Default: `[process.cwd()]` — identical to the pre-feature behaviour.
 *
 * Relative roots are resolved against `process.cwd()`. The configured list
 * REPLACES the default; add `.` explicitly to keep the cwd as a fallback.
 *
 * Deliberately no caching: the list is tiny, reads are cheap, and tests /
 * hot-reloaded configs must see changes immediately.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readLayeredState } from './statePaths';

export const EVAL_ROOTS_ENV = 'AGENT_HEALTH_EVAL_ROOTS';

/** Where the effective eval roots came from — surfaced on GET config/status. */
export type EvalRootsSource = 'environment' | 'typescript' | 'file' | 'default';

export interface EvalRootsStatus {
  roots: string[];
  source: EvalRootsSource;
}

/** One resolved source file: absolute path + the root it was found under. */
export interface ResolvedSourceFile {
  abs: string;
  /**
   * The eval root that matched, or `null` when `sourceFile` was absolute
   * and used verbatim.
   */
  root: string | null;
}

/** Full lookup result — `tried` lists every directory probed, in order. */
export interface SourceFileLookup {
  resolved: ResolvedSourceFile | null;
  tried: string[];
}

let tsEvalRoots: string[] | null = null;

/**
 * Register `evalRoots` authored in agent-health.config.ts. Called once at
 * server startup with the resolved TS config; pass `null` to clear (each
 * `createApp()` fully resets the bridge).
 */
export function setConfiguredEvalRoots(roots: string[] | null | undefined): void {
  tsEvalRoots = normalizeRootList(roots);
}

/** Test-only: reset the TS bridge between cases. */
export function __resetEvalRootsForTests(): void {
  tsEvalRoots = null;
}

function normalizeRootList(roots: unknown): string[] | null {
  if (!Array.isArray(roots)) return null;
  const cleaned = roots
    .filter((r): r is string => typeof r === 'string')
    .map(r => r.trim())
    .filter(r => r.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

function rootsFromEnv(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env[EVAL_ROOTS_ENV];
  if (typeof raw !== 'string') return null;
  return normalizeRootList(raw.split(path.delimiter));
}

function rootsFromState(cwd: string): string[] | null {
  try {
    const state = readLayeredState(cwd) as { evalRoots?: unknown };
    return normalizeRootList(state.evalRoots);
  } catch {
    return null;
  }
}

/**
 * The effective ordered eval roots plus where they came from. Every entry is
 * an absolute path (relative entries resolved against `cwd`); duplicates are
 * dropped keeping the first occurrence.
 */
export function getEvalRootsStatus(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): EvalRootsStatus {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  let roots: string[] | null;
  let source: EvalRootsSource;
  if ((roots = rootsFromEnv(env))) {
    source = 'environment';
  } else if ((roots = tsEvalRoots)) {
    source = 'typescript';
  } else if ((roots = rootsFromState(cwd))) {
    source = 'file';
  } else {
    roots = [cwd];
    source = 'default';
  }

  const seen = new Set<string>();
  const absolute: string[] = [];
  for (const r of roots) {
    const abs = path.resolve(cwd, r);
    if (seen.has(abs)) continue;
    seen.add(abs);
    absolute.push(abs);
  }
  return { roots: absolute, source };
}

/** The effective ordered eval roots (absolute paths). */
export function getEvalRoots(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  return getEvalRootsStatus(opts).roots;
}

/** Normalise Windows separators from an importing machine to POSIX. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Locate a stored `sourceFile` under the eval roots. Absolute inputs are
 * used verbatim (root = null). Relative inputs are probed against each root
 * in order; the first existing file wins. `tried` always lists what was
 * probed so callers can render an actionable "looked in …" message.
 */
export function lookupSourceFile(sourceFile: string, roots: string[] = getEvalRoots()): SourceFileLookup {
  const posix = toPosix(sourceFile);
  if (path.isAbsolute(posix)) {
    const abs = path.normalize(posix);
    return { resolved: fs.existsSync(abs) ? { abs, root: null } : null, tried: [abs] };
  }
  const tried: string[] = [];
  for (const root of roots) {
    tried.push(root);
    const abs = path.resolve(root, posix);
    if (fs.existsSync(abs)) return { resolved: { abs, root }, tried };
  }
  return { resolved: null, tried };
}

/** Convenience: {@link lookupSourceFile} without the `tried` list. */
export function resolveSourceFile(sourceFile: string, roots?: string[]): ResolvedSourceFile | null {
  return lookupSourceFile(sourceFile, roots).resolved;
}

/**
 * The root-relative, forward-slash `sourceFile` spelling to PERSIST for an
 * absolute path the loader resolved: relative to the first eval root that
 * contains it, else (unchanged legacy behaviour) relative to `cwd`. Keying
 * stored test cases on a root-relative path is what lets a later run — on a
 * server with a different cwd but the same roots — find the file again.
 */
export function toStoredSourceFile(
  absFile: string,
  roots: string[] = getEvalRoots(),
  cwd: string = process.cwd(),
): { sourceFile: string; root: string } {
  const abs = path.resolve(absFile);
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { sourceFile: rel.split(path.sep).join('/'), root };
    }
  }
  return { sourceFile: path.relative(cwd, abs).split(path.sep).join('/'), root: cwd };
}

/** Human-readable one-liner for logs / CLI hints. */
export function formatEvalRootsHint(tried: string[]): string {
  return tried.length === 0 ? '(no eval roots)' : tried.map(t => JSON.stringify(t)).join(', ');
}
