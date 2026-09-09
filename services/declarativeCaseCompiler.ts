/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compiler from the declarative JSON authoring surface to an RFC-004 matcher
 * session body. The runner cannot distinguish this body from a JavaScript SDK
 * body: both call `agent.run()`, record MatcherResult entries in the active
 * session, and let gate-role results mechanically derive the verdict.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { TestCase } from '@/types';
import type { EvalResult, TestFixtures } from '@/lib/testCases/types';
import type { MatcherResult } from '@/lib/matchers/types';
import { recordVerdict } from '@/lib/matchers/session';
import { normalizeExpectedOutcomes } from '@/lib/testCases/declarativeOutcomes';

export interface WorkspaceManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface WorkspaceDiff {
  pass: boolean;
  reasoning: string;
  expected: WorkspaceManifestEntry[];
  actual: WorkspaceManifestEntry[];
}

/**
 * Minimal batch surface required by the compiler. `judge.batch` is pluggable
 * deliberately: main currently routes it through `/api/judge`; PR #392 can
 * replace that backing provider with the restricted evidence judge without
 * changing the compiler or JSON mapping.
 */
export interface DeclarativeBatchJudge {
  batch(
    result: EvalResult,
    claims: Array<{ outcome: string; role: 'gate' | 'observe' }>,
  ): Promise<unknown>;
}

export interface DeclarativeCompilerDependencies {
  compareWorkspace?: (
    workspaceDir: string,
    expected: WorkspaceManifestEntry[],
  ) => Promise<WorkspaceDiff>;
}

/** True for persisted/UI/JSON cases that should use the compiled SDK path. */
export function isDeclarativeTestCase(testCase: TestCase): boolean {
  return !(testCase.sourceFile && /\.(?:eval\.)?(?:[cm]?js|ts)$/i.test(testCase.sourceFile));
}

/**
 * Compile a declarative case into the same fixture function used by code SDK
 * tests. One compiled invocation produces N matcher results, not one aggregate
 * result, while making at most one LLM request for all judged claims.
 */
export function compileDeclarativeTestCase(
  testCase: TestCase,
  dependencies: DeclarativeCompilerDependencies = {},
): (fixtures: TestFixtures) => Promise<void> {
  const outcomes = normalizeExpectedOutcomes(testCase.expectedOutcomes);
  const judged = outcomes.filter((item) => item.check === undefined);
  const workspaceChecks = outcomes.filter((item) => item.check === 'workspace-diff');
  const expectedManifest = workspaceChecks.length > 0
    ? readFixtureManifest(testCase)
    : [];
  const compareWorkspace = dependencies.compareWorkspace ?? compareWorkspaceToManifest;

  return async (fixtures: TestFixtures): Promise<void> => {
    if (!fixtures.agent) {
      throw new Error(`Declarative test case "${testCase.name}" requires the SDK agent fixture`);
    }

    const result = await fixtures.agent.run();

    if (judged.length > 0) {
      const batchJudge = fixtures.judge as typeof fixtures.judge & DeclarativeBatchJudge;
      if (typeof batchJudge.batch !== 'function') {
        throw new Error(
          'Declarative outcome compilation requires judge.batch(); use the SDK v2 bound judge fixture',
        );
      }
      // One call for every LLM-backed outcome. judge.batch records one matcher
      // entry per claim with its own role/reasoning in this active session.
      await batchJudge.batch(
        result,
        judged.map(({ outcome, role }) => ({ outcome, role })),
      );
    }

    if (workspaceChecks.length > 0) {
      const workspaceDir = result.workspaceDir;
      if (!workspaceDir) {
        throw new Error(
          `Declarative test case "${testCase.name}" uses workspace-diff, but the connector did not expose a final workspace directory`,
        );
      }
      // Multiple authored descriptions may point at the same deterministic
      // fact; scan/hash the workspace once and record each requested signal.
      const diff = await compareWorkspace(workspaceDir, expectedManifest);
      for (const check of workspaceChecks) {
        recordVerdict({
          description: check.outcome,
          pass: diff.pass,
          method: 'workspace-diff',
          role: check.role,
          reasoning: diff.reasoning,
          actual: diff.actual,
          expected: diff.expected,
          ...(!diff.pass ? { errorMessage: diff.reasoning } : {}),
        });
      }
    }
  };
}

function readFixtureManifest(testCase: TestCase): WorkspaceManifestEntry[] {
  const tree = (testCase.fixture?.payload as any)?.manifest?.tree;
  if (!Array.isArray(tree)) {
    throw new Error(
      `Declarative test case "${testCase.name}" uses workspace-diff, but fixture.payload.manifest.tree is missing`,
    );
  }
  return tree.map((entry: any) => ({
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
  })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Deterministically compare a final directory tree with the pinned fixture. */
export async function compareWorkspaceToManifest(
  workspaceDir: string,
  expected: WorkspaceManifestEntry[],
): Promise<WorkspaceDiff> {
  const actual = await buildWorkspaceManifest(workspaceDir);
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const added = actual.filter((entry) => !expectedByPath.has(entry.path)).map((entry) => entry.path);
  const removed = expected.filter((entry) => !actualByPath.has(entry.path)).map((entry) => entry.path);
  const changed = actual.filter((entry) => {
    const before = expectedByPath.get(entry.path);
    return before && (before.size !== entry.size || before.sha256 !== entry.sha256);
  }).map((entry) => entry.path);
  const pass = added.length === 0 && removed.length === 0 && changed.length === 0;
  const details = [
    added.length ? `added: ${added.join(', ')}` : '',
    removed.length ? `removed: ${removed.join(', ')}` : '',
    changed.length ? `changed: ${changed.join(', ')}` : '',
  ].filter(Boolean);
  return {
    pass,
    reasoning: pass
      ? `Final workspace matches the pinned ${expected.length}-file fixture manifest.`
      : `Final workspace differs from the pinned fixture manifest (${details.join('; ')}).`,
    expected,
    actual,
  };
}

async function buildWorkspaceManifest(root: string): Promise<WorkspaceManifestEntry[]> {
  const entries: WorkspaceManifestEntry[] = [];
  async function visit(dir: string): Promise<void> {
    const children = await fs.readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(dir, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (child.isSymbolicLink()) {
        throw new Error(`workspace-diff does not follow symbolic link: ${relative}`);
      }
      if (child.isDirectory()) {
        await visit(absolute);
      } else if (child.isFile()) {
        const bytes = await fs.readFile(absolute);
        entries.push({
          path: relative,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await visit(path.resolve(root));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Mechanical RFC-004 verdict: every non-observe gate must pass. */
export function deriveMatcherSessionVerdict(
  matcherResults: readonly MatcherResult[],
): 'passed' | 'failed' | 'errored' {
  if (matcherResults.some((result) => result.errored)) return 'errored';
  return matcherResults.every((result) => result.role === 'observe' || result.pass)
    ? 'passed'
    : 'failed';
}
