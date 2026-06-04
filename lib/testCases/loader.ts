/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { pathToFileURL } from 'url';
import { createRequire, Module as NodeModule } from 'module';
import type { CodeTestCase, RegisteredHook } from './types.js';
import {
  test as testFn,
  describe as describeFn,
  beforeAll as beforeAllFn,
  afterAll as afterAllFn,
  beforeEach as beforeEachFn,
  afterEach as afterEachFn,
  setActiveFile,
  getRegisteredTests,
  getRegisteredHooks,
  clearRegistry,
} from './define.js';
import { judge as judgeFn, wasJudgeCalled, resetJudgeFlag } from './judge.js';
import { expect as ahExpect } from '../matchers/expect.js';

const CODE_EXTENSIONS = ['.ts', '.js', '.mjs'];

export function isCodeFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return CODE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function computeTestCaseHash(tc: CodeTestCase): string {
  const content = JSON.stringify({
    name: tc.name,
    prompt: tc.options.prompt,
    context: tc.options.context,
    labels: tc.options.labels,
    description: tc.options.description,
    // Include the new expected* fields so editing them invalidates the
    // sourceHash and the upsert path picks up the change. Without this,
    // a user adding `expectedOutcomes: [...]` to an existing test would
    // see the test case stay on its old version and the new outcomes
    // would never reach storage.
    expectedOutcomes: tc.options.expectedOutcomes,
    expectedTrajectory: tc.options.expectedTrajectory,
  });
  return createHash('sha256').update(content).digest('hex');
}

export interface LoadedTestCase extends CodeTestCase {
  hash: string;
}

export interface LoadResult {
  testCases: LoadedTestCase[];
  filePath: string;
  /**
   * Benchmark groups derived from `describe()` blocks in the file.
   * Maps benchmark name (the joined describe path, e.g. 'RCA Suite' or
   * 'A > B' for nested) to the test case names within. Tests outside any
   * `describe()` are not in this map; they go to the file-default benchmark
   * (CLI / server names it after the filename).
   */
  benchmarks: Map<string, string[]>;
  /**
   * All lifecycle hooks (`beforeEach`/`afterEach`/`beforeAll`/`afterAll`)
   * registered while loading this file. Empty when the file declares none.
   * The orchestrator filters by `(sourceFile, describePath)` at run time.
   */
  hooks: RegisteredHook[];
}

export async function loadTestCasesFromModule(filePath: string): Promise<LoadResult> {
  const absPath = resolve(filePath);

  // Clear any prior registration for this file and set it as active
  clearRegistry(absPath);
  setActiveFile(absPath);

  let module: any;

  if (absPath.endsWith('.js')) {
    // For CJS .js files, execute in a fresh context with our test() function
    // injected. This avoids module caching issues across multiple loads.
    const code = readFileSync(absPath, 'utf-8');
    const fileDir = dirname(absPath);
    // NOTE: do not call require('module') here — this file is bundled as ESM
    // by esbuild for the server, and Dynamic require of built-ins is unsupported
    // in ESM output. Use the statically-imported NodeModule instead.
    const Module = NodeModule as typeof import('module');
    const m = new (Module as any)(absPath);
    m.filename = absPath;
    m.paths = (Module as any)._nodeModulePaths(fileDir);
    // Provide a require function scoped to the file's directory, but override
    // any require of the define module to return our own instance
    const fileRequire = createRequire(absPath);
    // Match if `id` looks like our own define module before doing any
    // filesystem resolution. Required because:
    //   1) the loader is bundled as ESM by esbuild, so synthetic CJS
    //      `require.resolve` is unavailable here, and
    //   2) `lib/testCases/define.ts` is not compiled to a .js sibling, so
    //      `fileRequire.resolve('../../lib/testCases/define')` from a
    //      fixture would throw MODULE_NOT_FOUND.
    const isDefineId = (id: string) => {
      const normalized = id.replace(/\\/g, '/').replace(/\.js$/, '');
      return (
        normalized === 'lib/testCases/define' ||
        normalized.endsWith('/lib/testCases/define')
      );
    };
    // Intercept the published package name as well — fixtures generally
    // do `require('@opensearch-project/agent-health')` and Node's resolver
    // would otherwise hit the package's exports map (which only exposes
    // 'import' for ESM consumers).
    const isPackageName = (id: string) =>
      id === '@opensearch-project/agent-health' ||
      id === '@opensearch/agent-health' ||
      id === 'agent-health';
    // What we hand back to the user when they require the SDK. Must be the
    // same shape as the published @opensearch-project/agent-health package's
    // top-level exports so fixtures work both in-tree and against the npm
    // package without code changes.
    const sdkExports = {
      test: testFn,
      describe: describeFn,
      // Lifecycle hooks — exported both as standalone names and (via
      // namespace merging in define.ts) as `test.beforeEach` etc. CJS
      // fixtures pick whichever style.
      beforeAll: beforeAllFn,
      afterAll: afterAllFn,
      beforeEach: beforeEachFn,
      afterEach: afterEachFn,
      judge: judgeFn,
      wasJudgeCalled,
      resetJudgeFlag,
      // Pre-resolved matcher API — must be a direct import (not a runtime
      // require) so it works in bundled ESM contexts (CLI, server) where
      // the synthetic CJS `require` isn't available at module-top scope.
      expect: ahExpect,
    };
    const wrappedRequire = (id: string) => {
      if (isDefineId(id) || isPackageName(id)) {
        return sdkExports;
      }
      // Fall back to a resolution-based check so that fixtures requiring the
      // SDK by absolute path or via the published package name still hand back
      // our test() registrar (and therefore land in our file-scoped registry).
      try {
        const resolved = fileRequire.resolve(id);
        const normalized = resolved.replace(/\\/g, '/');
        if (
          normalized.endsWith('/lib/testCases/define.js') ||
          normalized.endsWith('/lib/testCases/define')
        ) {
          return sdkExports;
        }
      } catch {
        // ignore unresolvable IDs — fileRequire below will surface the error
      }
      return fileRequire(id);
    };
    (wrappedRequire as any).resolve = fileRequire.resolve;

    const wrapper = `(function(exports, require, module, __filename, __dirname) { ${code}\n});`;
    const compiledFn = eval(wrapper);
    compiledFn(m.exports, wrappedRequire, m, absPath, fileDir);
    module = m.exports;
  } else {
    // For .ts and .mjs files, use dynamic import
    try {
      const fileUrl = pathToFileURL(absPath).href;
      module = await import(fileUrl);
    } catch (err: any) {
      if (err.code === 'ERR_UNKNOWN_FILE_EXTENSION' && absPath.endsWith('.ts')) {
        throw new Error(
          `Cannot import TypeScript file: ${filePath}\n` +
          'Install tsx as a dependency: npm install tsx\n' +
          'Or pre-compile .eval.ts to .eval.js before running.'
        );
      }
      throw new Error(`Failed to import module: ${filePath}\n${err.message}`);
    }
  }

  // Tests come exclusively from test() / describe() registration calls
  // (Playwright-style). Legacy default-export array form was removed when
  // we dropped defineTestCases() — the SDK is experimental and the API
  // shape is intentionally narrow.
  const testCases = getRegisteredTests(absPath);

  if (testCases.length === 0) {
    throw new Error(
      `Module ${filePath} has no test cases. Register tests with test(name, options?, body) inside the file.`
    );
  }

  // Compute per-test-case hash
  const loaded: LoadedTestCase[] = testCases.map(tc => ({
    ...tc,
    hash: computeTestCaseHash(tc),
  }));

  // Derive describe-group → test names mapping. Tests outside any
  // describe() have benchmarkPath=undefined and are excluded; the CLI/
  // server adds them to the file-default benchmark separately.
  const benchmarks = new Map<string, string[]>();
  for (const tc of loaded) {
    if (tc.benchmarkPath) {
      const list = benchmarks.get(tc.benchmarkPath) ?? [];
      list.push(tc.name);
      benchmarks.set(tc.benchmarkPath, list);
    }
  }

  // Collect every hook the file registered. Empty when no
  // beforeEach/afterEach/beforeAll/afterAll were called — the orchestrator
  // is a no-op in that case so existing tests are unaffected.
  const hooks = getRegisteredHooks(absPath);

  return { testCases: loaded, filePath: absPath, benchmarks, hooks };
}
