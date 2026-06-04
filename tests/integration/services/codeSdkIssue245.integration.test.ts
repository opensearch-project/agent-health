/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for issue #245 — full code-SDK pipeline.
 *
 * The original SDK (PR #207) and #245-related published bundles all shipped
 * with these defects:
 *   1. The body registered via `test(name, opts, body)` was never invoked
 *      → chai `expect(...)` and inline `judge()` were silently no-ops.
 *   2. `options.expectedOutcomes` / `options.expectedTrajectory` were not
 *      part of the TestOptions type and not forwarded to the persisted
 *      test case → server-side evaluators couldn't grade code-based tests
 *      and emitted "Missing required field: expectedOutcomes".
 *
 * Existing tests covered registration, source resolution, and bodies that
 * threw raw `Error`s, but **nothing exercised the chai recording path or
 * the expected* forwarding path** through the full pipeline. That gap is
 * why the regression slipped through.
 *
 * This file pins both behaviours from the only place a regression could
 * realistically happen — a real .eval.js file on disk going through
 * `resolveTestCaseSources` and into the test case storage layer that the
 * server-side runner / server evaluator consume. We use FileStorageModule
 * so the test runs without an OpenSearch dependency, exactly like the
 * Observio code-SDK integration test next door.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { resolveTestCaseSources } from '@/services/sourceResolver';
import { startSession, endSession } from '@/lib/matchers/index';
import { expect as ahExpect } from '@/lib/matchers/expect';
import type { TestCaseSource } from '@/types';

describe('Code SDK — issue #245 regression', () => {
  let tmpDir: string;
  let storage: FileStorageModule;
  const fixtureFile = path.join(os.tmpdir(), `issue-245-fixture-${Date.now()}.eval.js`);

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-245-'));
    storage = new FileStorageModule(tmpDir);

    // A self-contained .eval.js using the public package import path so
    // the loader's CJS intercept exercises the same code path users hit.
    fs.writeFileSync(fixtureFile, `
const { test, expect } = require('@opensearch-project/agent-health');

test('chai-fail-records-failure', { prompt: 'p' }, async ({ result }) => {
  expect('a').to.equal('b');
});

test('chai-pass-records-pass', { prompt: 'p' }, async ({ result }) => {
  expect('hello').to.equal('hello');
});

test('expected-outcomes-forwarded', {
  prompt: 'p',
  expectedOutcomes: ['identifies the failing dependency', 'proposes remediation'],
  expectedTrajectory: [
    { step: 1, description: 'search logs', requiredTools: ['search_logs'] },
  ],
}, async ({ result }) => {
  expect(true).to.equal(true);
});
`);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(fixtureFile)) fs.unlinkSync(fixtureFile);
  });

  // Each call to resolveTestCaseSources mutates the loader registry; we
  // resolve once and read everything from the captured snapshot.
  let resolved: Awaited<ReturnType<typeof resolveTestCaseSources>>;

  beforeAll(async () => {
    const sources: TestCaseSource[] = [{
      type: 'code-import',
      filenames: [fixtureFile],
      testCaseIds: [],
    }];
    resolved = await resolveTestCaseSources(sources, storage);
  });

  describe('part 1 — body invocation + chai recording', () => {
    it('imports all three test cases', () => {
      expect(resolved.testCases.map(tc => tc.name).sort()).toEqual([
        'chai-fail-records-failure',
        'chai-pass-records-pass',
        'expected-outcomes-forwarded',
      ]);
    });

    it('captures the evaluate function for every test case', () => {
      expect(resolved.evaluateFnMap.size).toBe(3);
      for (const tc of resolved.testCases) {
        expect(typeof resolved.evaluateFnMap.get(tc.id)).toBe('function');
      }
    });

    // Simulate exactly what the runner does: startSession → call body →
    // endSession. If the body weren't invoked (the bundle bug #245
    // describes), endSession would return [] and these would all fail.
    it('records a failed MatcherResult for chai assertion failures', async () => {
      const tc = resolved.testCases.find(t => t.name === 'chai-fail-records-failure')!;
      const evalFn = resolved.evaluateFnMap.get(tc.id)!;
      startSession();
      let threw: Error | undefined;
      try {
        await evalFn({
          result: { trajectory: [], agentOutput: '', rawEvents: [], durationMs: 0 } as any,
          expect: ahExpect,
        } as any);
      } catch (err) {
        threw = err as Error;
      }
      const matchers = endSession();

      // chai's recorder pushes a verdict and then re-throws — both are
      // critical: the verdict gives the UI per-matcher detail, the throw
      // bails the test out for the runner's catch block.
      expect(matchers).toHaveLength(1);
      expect(matchers[0]).toMatchObject({
        pass: false,
        method: 'code-assertion',
        description: "'a' to equal 'b'",
      });
      expect(matchers[0].errorMessage).toContain("expected 'a' to equal 'b'");
      expect(threw?.message).toContain("expected 'a' to equal 'b'");
    });

    it('records a passing MatcherResult for chai assertion successes', async () => {
      const tc = resolved.testCases.find(t => t.name === 'chai-pass-records-pass')!;
      const evalFn = resolved.evaluateFnMap.get(tc.id)!;
      startSession();
      await evalFn({
        result: { trajectory: [], agentOutput: '', rawEvents: [], durationMs: 0 } as any,
        expect: ahExpect,
      } as any);
      const matchers = endSession();

      expect(matchers).toHaveLength(1);
      expect(matchers[0]).toMatchObject({
        pass: true,
        method: 'code-assertion',
        description: "'hello' to equal 'hello'",
      });
    });
  });

  describe('part 2 — expectedOutcomes / expectedTrajectory forwarding', () => {
    it('persists expectedOutcomes onto the upserted test case', () => {
      const tc = resolved.testCases.find(t => t.name === 'expected-outcomes-forwarded') as any;
      expect(tc.expectedOutcomes).toEqual([
        'identifies the failing dependency',
        'proposes remediation',
      ]);
    });

    it('persists expectedTrajectory with the typed shape', () => {
      const tc = resolved.testCases.find(t => t.name === 'expected-outcomes-forwarded') as any;
      expect(tc.expectedTrajectory).toEqual([
        { step: 1, description: 'search logs', requiredTools: ['search_logs'] },
      ]);
    });

    it('does not invent expected* fields on tests that did not declare them', () => {
      const tc = resolved.testCases.find(t => t.name === 'chai-fail-records-failure') as any;
      // FileStorageModule round-trips JSON, so undefined fields stay
      // undefined (not null) — verifying both shapes is paranoid but
      // catches accidental "default to []" regressions.
      expect(tc.expectedOutcomes).toBeUndefined();
      expect(tc.expectedTrajectory).toBeUndefined();
    });
  });
});
