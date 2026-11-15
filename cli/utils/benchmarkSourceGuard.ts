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
 * it under (lib/config/evalRoots.ts `toStoredSourceFile`). So "which file
 * was this benchmark created from" is answered by the distinct `sourceFile`
 * values of the test cases it links.
 *
 * Without this guard, running a DIFFERENT eval file under an existing
 * benchmark's name silently appended that file's cases to the existing
 * version (while the top-level `testCaseIds` pointed only at the new file's
 * cases) and mixed two question sets into one run history. The CLI now
 * compares the `-f` code files against the stored source files BEFORE the
 * run starts and refuses unless `--force` is given.
 *
 * Comparison is done the way the server would store the new file (same
 * `toStoredSourceFile` over the server's eval roots) plus an absolute-path
 * equivalence, so the same file spelled differently (`./a.eval.ts`,
 * `a.eval.ts`, an absolute path) is never a false mismatch.
 */

import * as path from 'path';
import type { Benchmark, TestCase } from '@/types/index.js';
import { isCodeFile } from '@/lib/testCases/loader.js';
import { toStoredSourceFile } from '@/lib/config/evalRoots.js';

export interface BenchmarkSourceMismatch {
  /** Distinct code source files the benchmark's stored test cases came from. */
  existingSourceFiles: string[];
  /** The `-f` code files (as the user typed them) that match none of them. */
  foreignFiles: string[];
}

/** Every test case id the benchmark has ever linked (top level + all versions). */
export function allBenchmarkTestCaseIds(benchmark: Pick<Benchmark, 'testCaseIds' | 'versions'>): string[] {
  const ids = new Set<string>(benchmark.testCaseIds ?? []);
  for (const v of benchmark.versions ?? []) for (const id of v.testCaseIds ?? []) ids.add(id);
  return [...ids];
}

/**
 * Pure: which of `newFiles` (code files) come from none of the source files
 * of `existingCases`. Returns null when there is nothing to object to — no
 * code cases stored yet (a fresh shell, or a JSON-only benchmark), or every
 * new file is one the benchmark already holds.
 */
export function findForeignSourceFiles(
  existingCases: Array<Pick<TestCase, 'sourceFile'>>,
  newFiles: string[],
  roots: string[],
  cwd: string = process.cwd(),
): BenchmarkSourceMismatch | null {
  const existingSourceFiles = [...new Set(
    existingCases.map(tc => tc.sourceFile).filter((sf): sf is string => !!sf && isCodeFile(sf)),
  )];
  if (existingSourceFiles.length === 0) return null;

  const toPosix = (p: string) => p.replace(/\\/g, '/');
  const existingAbs = new Set<string>();
  for (const sf of existingSourceFiles) {
    const posix = toPosix(sf);
    if (path.isAbsolute(posix)) existingAbs.add(path.normalize(posix));
    for (const root of [...roots, cwd]) existingAbs.add(path.resolve(root, posix));
  }

  const foreignFiles: string[] = [];
  for (const f of newFiles) {
    if (!isCodeFile(f)) continue;
    const abs = path.resolve(cwd, f);
    const stored = toStoredSourceFile(abs, roots, cwd).sourceFile;
    const known = existingSourceFiles.some(sf => toPosix(sf) === stored) || existingAbs.has(abs);
    if (!known) foreignFiles.push(f);
  }
  return foreignFiles.length === 0 ? null : { existingSourceFiles, foreignFiles };
}

/** Minimal API surface the guard needs (subset of ApiClient). */
export interface BenchmarkSourceGuardApi {
  getConfigStatus(): Promise<{ evalRoots?: { roots: string[] } } | null>;
  /** One batched summary request per chunk — never one GET per test case. */
  getTestCaseSummaries(ids: string[]): Promise<Array<Pick<TestCase, 'name' | 'sourceFile'>>>;
}

/** Ids per summary request; keeps the `?ids=` query well under URL limits. */
const SUMMARY_CHUNK = 200;

/**
 * Compare the `-f` code files of this run against the source files of the
 * benchmark's stored test cases. Resolves to a mismatch to refuse on, or null
 * when the run may proceed. Any API failure → null (the guard is additive and
 * must never turn a working run into a failure).
 */
export async function checkBenchmarkSourceMismatch(
  api: BenchmarkSourceGuardApi,
  benchmark: Pick<Benchmark, 'testCaseIds' | 'versions'>,
  files: string[],
  cwd: string = process.cwd(),
): Promise<BenchmarkSourceMismatch | null> {
  const codeFiles = files.filter(isCodeFile);
  if (codeFiles.length === 0) return null;
  const ids = allBenchmarkTestCaseIds(benchmark);
  if (ids.length === 0) return null;
  try {
    const status = await api.getConfigStatus();
    const roots = status?.evalRoots?.roots?.length ? status.evalRoots.roots : [cwd];
    const cases: Array<Pick<TestCase, 'name' | 'sourceFile'>> = [];
    for (let i = 0; i < ids.length; i += SUMMARY_CHUNK) {
      cases.push(...(await api.getTestCaseSummaries(ids.slice(i, i + SUMMARY_CHUNK))));
    }
    return findForeignSourceFiles(cases, codeFiles, roots, cwd);
  } catch {
    return null;
  }
}

const list = (files: string[]) => files.map(f => JSON.stringify(f)).join(', ');

/** The refusal printed (colour-free) when `--force` is absent. */
export function formatSourceMismatchRefusal(name: string, m: BenchmarkSourceMismatch): string[] {
  const plural = m.foreignFiles.length > 1;
  return [
    `Error: benchmark "${name}" was created from ${list(m.existingSourceFiles)}; ${list(m.foreignFiles)} ${plural ? 'are' : 'is a'} different source file${plural ? 's' : ''}.`,
    `Running ${plural ? 'them' : 'it'} under the same name would add ${plural ? 'their' : 'its'} test cases to "${name}" and mix two question sets in one run history.`,
    `Use a different name (e.g. -n "${name}-${path.basename(m.foreignFiles[0]).replace(/\.eval\.[cm]?[jt]s$/i, '')}") or pass --force to add ${list(m.foreignFiles)} to "${name}" anyway.`,
  ];
}

/** The warning printed (colour-free) when `--force` overrides the guard. */
export function formatSourceMismatchForced(name: string, m: BenchmarkSourceMismatch): string {
  return `Warning: --force — adding the test cases of ${list(m.foreignFiles)} to benchmark "${name}", which was created from ${list(m.existingSourceFiles)}.`;
}

/**
 * After the run has started: which of its test cases were NOT part of the
 * benchmark before — exactly what `--force` added — for the "Added …" line.
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
