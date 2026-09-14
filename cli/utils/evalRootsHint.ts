/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI-side, best-effort check that the code-SDK `sourceFile`s of the STORED
 * test cases a run is about to use are actually resolvable by the server.
 *
 * The server resolves a stored relative `sourceFile` against its eval roots
 * (`AGENT_HEALTH_EVAL_ROOTS` > `evalRoots` config > cwd — see
 * lib/config/evalRoots.ts). When none of those directories contains the
 * file, the server either falls back to the classic judge path (pre-#503) or
 * refuses to start the run (#503). Either way the operator's first question
 * is "where is the server looking?" — this prints exactly that, one line per
 * missing file, BEFORE the run is started. Purely advisory: it never blocks
 * and swallows every failure (remote server, huge benchmark, etc.).
 */

import { existsSync } from 'fs';
import * as path from 'path';
import type { TestCase, TestCaseSource } from '@/types/index.js';
import { isCodeFile } from '@/lib/testCases/loader.js';

/**
 * Max stored test cases to check; larger sets skip the hint entirely (never
 * a partial check). The fetch is ONE batched summary request, so the cost is
 * bounded by response size, not request count.
 */
export const EVAL_ROOTS_HINT_MAX_CASES = 200;

export interface EvalRootsHint {
  sourceFile: string;
  testCaseNames: string[];
  roots: string[];
}

/**
 * Pure: which distinct code `sourceFile`s among `testCases` exist under NONE
 * of `roots`. Absolute paths are checked verbatim. `exists` is injectable
 * for tests. Returns [] when there is nothing to warn about.
 */
export function findUnresolvableSourceFiles(
  testCases: Array<Pick<TestCase, 'name' | 'sourceFile'>>,
  roots: string[],
  exists: (p: string) => boolean = existsSync,
): EvalRootsHint[] {
  const byFile = new Map<string, string[]>();
  for (const tc of testCases) {
    const sf = tc.sourceFile;
    if (!sf || !isCodeFile(sf)) continue;
    const list = byFile.get(sf) ?? [];
    list.push(tc.name);
    byFile.set(sf, list);
  }
  const out: EvalRootsHint[] = [];
  for (const [sourceFile, names] of byFile) {
    const posix = sourceFile.replace(/\\/g, '/');
    const found = path.isAbsolute(posix)
      ? exists(posix)
      : roots.some(root => exists(path.resolve(root, posix)));
    if (!found) out.push({ sourceFile, testCaseNames: names, roots });
  }
  return out;
}

/** One-line, colour-free rendering of a hint (caller applies chalk). */
export function formatEvalRootsHint(hint: EvalRootsHint): string {
  const n = hint.testCaseNames.length;
  const rootsList = hint.roots.map(r => JSON.stringify(r)).join(', ');
  return (
    `Hint: ${n} stored test case${n === 1 ? '' : 's'} reference "${hint.sourceFile}", which was not found under the ` +
    `server's eval roots [${rootsList}] — set AGENT_HEALTH_EVAL_ROOTS (or evalRoots in agent-health.config.ts) on the ` +
    `server to the directory that contains it.`
  );
}

/** Minimal API surface the check needs (subset of ApiClient). */
export interface EvalRootsHintApi {
  getConfigStatus(): Promise<{ evalRoots?: { roots: string[] } } | null>;
  getBenchmark(id: string): Promise<{ testCaseIds?: string[] } | null>;
  /** One batched summary request — never one GET per test case. */
  getTestCaseSummaries(ids: string[]): Promise<Array<Pick<TestCase, 'name' | 'sourceFile'>>>;
}

/**
 * Resolve the stored test cases referenced by `benchmark` / `test-case-ids`
 * sources (file/code/directory/label sources are skipped — the server
 * resolves those itself) and return hints for any code `sourceFile` the
 * server's eval roots do not contain. Best-effort: any failure → [].
 */
export async function collectEvalRootsHints(
  api: EvalRootsHintApi,
  sources: TestCaseSource[],
  exists: (p: string) => boolean = existsSync,
): Promise<EvalRootsHint[]> {
  try {
    const ids = new Set<string>();
    for (const source of sources) {
      if (source.type === 'test-case-ids') {
        for (const id of source.ids) ids.add(id);
      } else if (source.type === 'benchmark') {
        const bm = await api.getBenchmark(source.benchmarkId);
        for (const id of bm?.testCaseIds ?? []) ids.add(id);
      }
    }
    if (ids.size === 0 || ids.size > EVAL_ROOTS_HINT_MAX_CASES) return [];

    const status = await api.getConfigStatus();
    const roots = status?.evalRoots?.roots;
    if (!roots || roots.length === 0) return [];

    const testCases = await api.getTestCaseSummaries([...ids]);
    return findUnresolvableSourceFiles(testCases, roots, exists);
  } catch {
    return [];
  }
}
