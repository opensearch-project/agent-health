/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `benchmark -f other.eval.ts -n "<existing benchmark>"` guard (#620).
 *
 * A benchmark document records no source file of its own: `description` is
 * free text written once at creation ("CLI benchmark run from a.eval.ts") and
 * never updated, and the evaluation-run documents only record the sources of
 * each run. The durable record is on the TEST CASES — every code-imported
 * case carries `sourceFile`, the root-relative POSIX path the server stored
 * it under (lib/config/evalRoots.ts `toStoredSourceFile`). So "which files
 * is this benchmark made of" is answered by the distinct `sourceFile` values
 * of the test cases in its current version.
 *
 * Without this guard, running a DIFFERENT eval file under an existing
 * benchmark's name silently appended that file's cases to the existing
 * version (while the top-level `testCaseIds` pointed only at the new file's
 * cases) and mixed two question sets into one run history. The CLI now
 * requires the `-f` code files of a run to be exactly the source files the
 * benchmark's current version holds — a file it does not hold ("foreign") or
 * a file it holds that the run leaves out ("missing") is refused unless
 * `--force` is given, because either way the run's pass rate would be over a
 * different question set than the history it joins.
 *
 * Files are compared as absolute paths resolved the way the server resolves
 * them (`lookupSourceFile`: absolute verbatim, relative against each eval
 * root in order, first existing wins), so the same file spelled differently
 * (`./a.eval.ts`, `a.eval.ts`, an absolute path) is never a false mismatch.
 */

import { existsSync } from 'fs';
import * as path from 'path';
import type { Benchmark, TestCase } from '@/types/index.js';
import { isCodeFile } from '@/lib/testCases/loader.js';

export interface BenchmarkSourceMismatch {
  /** Distinct code source files (stored spelling) of the benchmark's current test cases. */
  existingSourceFiles: string[];
  /** `-f` code files (as the user typed them) the benchmark does not hold. */
  foreignFiles: string[];
  /** Source files (stored spelling) the benchmark holds that this run leaves out. */
  missingFiles: string[];
}

/** The test case ids that make up the benchmark NOW: top level ∪ current version. */
export function currentBenchmarkTestCaseIds(benchmark: Pick<Benchmark, 'testCaseIds' | 'versions' | 'currentVersion'>): string[] {
  const ids = new Set<string>(benchmark.testCaseIds ?? []);
  const current = (benchmark.versions ?? []).find(v => v.version === benchmark.currentVersion);
  for (const id of current?.testCaseIds ?? []) ids.add(id);
  return [...ids];
}

const toPosix = (p: string) => p.replace(/\\/g, '/');

/**
 * Absolute path a source file spelling denotes, resolved as the server does
 * (lib/config/evalRoots.ts `lookupSourceFile`): absolute → verbatim; relative
 * → the first of `roots` (then `cwd`) under which it exists; none → under the
 * first root, so a file that no longer exists still compares deterministically.
 */
function resolveLikeServer(file: string, roots: string[], cwd: string, exists: (p: string) => boolean): string {
  const posix = toPosix(file);
  if (path.isAbsolute(posix)) return path.normalize(posix);
  const candidates = [...roots, cwd];
  for (const root of candidates) {
    const abs = path.resolve(root, posix);
    if (exists(abs)) return abs;
  }
  return path.resolve(candidates[0], posix);
}

/**
 * Pure: compare the `-f` code files of a run with the source files of the
 * benchmark's current test cases. Returns null when there is nothing to
 * object to — no code cases stored yet (a fresh shell, or a JSON-only
 * benchmark), or the run's code files are exactly the benchmark's.
 */
export function compareSourceFiles(
  existingCases: Array<Pick<TestCase, 'sourceFile'>>,
  newFiles: string[],
  roots: string[],
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): BenchmarkSourceMismatch | null {
  const existingSourceFiles = [...new Set(
    existingCases.map(tc => tc.sourceFile).filter((sf): sf is string => !!sf && isCodeFile(sf)),
  )];
  if (existingSourceFiles.length === 0) return null;
  const codeFiles = newFiles.filter(isCodeFile);
  if (codeFiles.length === 0) return null;

  const existingAbs = new Map<string, string>(); // abs → stored spelling
  for (const sf of existingSourceFiles) existingAbs.set(resolveLikeServer(sf, roots, cwd, exists), sf);
  const newAbs = new Map<string, string>(); // abs → as typed
  for (const f of codeFiles) newAbs.set(resolveLikeServer(f, roots, cwd, exists), f);

  const foreignFiles = [...newAbs].filter(([abs]) => !existingAbs.has(abs)).map(([, f]) => f);
  const missingFiles = [...existingAbs].filter(([abs]) => !newAbs.has(abs)).map(([, sf]) => sf);
  if (foreignFiles.length === 0 && missingFiles.length === 0) return null;
  return { existingSourceFiles, foreignFiles, missingFiles };
}

/** Minimal API surface the guard needs (subset of ApiClient). */
export interface BenchmarkSourceGuardApi {
  getConfigStatus(): Promise<{ evalRoots?: { roots: string[] } } | null>;
  /** One batched summary request per chunk — never one GET per test case. */
  getTestCaseSummaries(ids: string[]): Promise<Array<Pick<TestCase, 'name' | 'sourceFile'>>>;
}

/** Ids per summary request; keeps the `?ids=` query well under URL limits. */
const SUMMARY_CHUNK = 200;

export type BenchmarkSourceCheck =
  | { kind: 'ok' }
  | { kind: 'mismatch'; mismatch: BenchmarkSourceMismatch }
  /** The stored test cases could not be read, so nothing was compared. */
  | { kind: 'unverified'; reason: string };

/**
 * Compare the `-f` code files of this run against the source files of the
 * benchmark's current test cases. Never throws: when the stored cases cannot
 * be read the result says so (`unverified`) and the caller decides.
 */
export async function checkBenchmarkSourceMismatch(
  api: BenchmarkSourceGuardApi,
  benchmark: Pick<Benchmark, 'testCaseIds' | 'versions' | 'currentVersion'>,
  files: string[],
  cwd: string = process.cwd(),
): Promise<BenchmarkSourceCheck> {
  if (!files.some(isCodeFile)) return { kind: 'ok' };
  const ids = currentBenchmarkTestCaseIds(benchmark);
  if (ids.length === 0) return { kind: 'ok' };
  try {
    // The server resolves relative source files against its eval roots
    // (default: its cwd); an older server without the status field → cwd.
    const status = await api.getConfigStatus();
    const roots = status?.evalRoots?.roots?.length ? status.evalRoots.roots : [cwd];
    const cases: Array<Pick<TestCase, 'name' | 'sourceFile'>> = [];
    for (let i = 0; i < ids.length; i += SUMMARY_CHUNK) {
      cases.push(...(await api.getTestCaseSummaries(ids.slice(i, i + SUMMARY_CHUNK))));
    }
    const mismatch = compareSourceFiles(cases, files, roots, cwd);
    return mismatch ? { kind: 'mismatch', mismatch } : { kind: 'ok' };
  } catch (err) {
    return { kind: 'unverified', reason: err instanceof Error ? err.message : String(err) };
  }
}

const list = (files: string[]) => files.map(f => JSON.stringify(f)).join(', ');
const suggestedName = (name: string, m: BenchmarkSourceMismatch) => {
  const stem = path.basename((m.foreignFiles[0] ?? m.missingFiles[0] ?? 'subset')).replace(/\.eval\.[cm]?[jt]s$/i, '');
  return `${name}-${stem}`;
};

/** The refusal printed (colour-free) when `--force` is absent. */
export function formatSourceMismatchRefusal(name: string, m: BenchmarkSourceMismatch): string[] {
  const head = m.foreignFiles.length > 0
    ? `Error: benchmark "${name}" was created from ${list(m.existingSourceFiles)}; ${list(m.foreignFiles)} ${m.foreignFiles.length > 1 ? 'are' : 'is a'} different source file${m.foreignFiles.length > 1 ? 's' : ''}.`
    : `Error: benchmark "${name}" holds test cases from ${list(m.existingSourceFiles)}; this run leaves out ${list(m.missingFiles)}.`;
  const consequence = m.foreignFiles.length > 0
    ? `Running under the same name would add ${m.foreignFiles.length > 1 ? 'their' : 'its'} test cases to "${name}" and mix two question sets in one run history.`
    : `Running under the same name would record a pass rate over a different question set in "${name}"'s history.`;
  const forceWhat = m.foreignFiles.length > 0 ? `add ${list(m.foreignFiles)} to "${name}"` : `run this subset under "${name}"`;
  return [head, consequence, `Use a different name (e.g. -n "${suggestedName(name, m)}") or pass --force to ${forceWhat} anyway.`];
}

/** The warning printed (colour-free) when `--force` overrides the guard. */
export function formatSourceMismatchForced(name: string, m: BenchmarkSourceMismatch): string {
  const parts: string[] = [];
  if (m.foreignFiles.length > 0) parts.push(`adding the test cases of ${list(m.foreignFiles)} to benchmark "${name}", which was created from ${list(m.existingSourceFiles)}`);
  if (m.missingFiles.length > 0) parts.push(`running "${name}" without ${list(m.missingFiles)}`);
  return `Warning: --force — ${parts.join('; ')}.`;
}

/** The notice printed when the check could not be performed and the run proceeds. */
export function formatSourceCheckUnverified(name: string, reason: string): string {
  return `Warning: could not verify that the -f file(s) match the source of benchmark "${name}" (${reason}); continuing.`;
}

/**
 * At the run's `started` event: which of its test cases the benchmark did NOT
 * hold before — exactly what `--force` added — for the "Added …" line.
 */
export function describeAddedTestCases(
  previousIds: Iterable<string>,
  runTestCases: Array<{ id: string; name: string }>,
  name: string,
): string | null {
  const before = new Set(previousIds);
  const added = runTestCases.filter(tc => !before.has(tc.id));
  if (added.length === 0) return null;
  const names = added.map(tc => tc.name);
  const shown = names.slice(0, 10).join(', ');
  const more = names.length > 10 ? `, +${names.length - 10} more` : '';
  return `Added ${added.length} test case${added.length === 1 ? '' : 's'} to "${name}": ${shown}${more}`;
}

/** Description recorded on the benchmark once `--force` has added files to it. */
export function describeForcedAddition(existingDescription: string | undefined, m: BenchmarkSourceMismatch): string {
  if (m.foreignFiles.length === 0) return existingDescription ?? '';
  const added = m.foreignFiles.join(', ');
  return existingDescription
    ? `${existingDescription}; ${added} added with --force`
    : `CLI benchmark run from ${m.existingSourceFiles.join(', ')}; ${added} added with --force`;
}
