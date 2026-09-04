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
import type { TestCaseDefinitionCapture } from '@/types';
import {
  setActiveFile,
  getRegisteredTests,
  getRegisteredHooks,
  clearRegistry,
} from './define.js';
import { getAuthoringSurface } from './authoringSurface.js';

const CODE_EXTENSIONS = ['.ts', '.js', '.mjs'];

export function isCodeFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return CODE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Re-exported so CLI/server importers keep a single import path
// (`@/lib/testCases/loader`) for both the loader and the language
// detector, while the browser-side EvalSourceCodeView component imports
// the same isomorphic implementation directly from `@/lib/utils` (this
// module pulls in `fs`/`module`, which are Node-only and unsafe to bundle
// into the browser).
export { detectSourceLanguage } from '@/lib/utils.js';

export function computeTestCaseHash(tc: CodeTestCase, fileSource?: string): string {
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
    // Fold in the WHOLE file's raw text (optional -- omitted by callers that
    // don't have it, e.g. existing unit tests exercising this function in
    // isolation). Without this, editing ONLY the evaluate() body, a helper
    // function, an import, or even just a comment would leave every
    // options-derived field above unchanged, `sourceHash` would stay put,
    // `bulkUpsert` would classify the row as unchanged, and the persisted
    // `sourceCode` -- the entire point of the eval-source viewer -- would
    // silently go stale relative to the real file on disk.
    fileSource,
  });
  return createHash('sha256').update(content).digest('hex');
}

export interface LoadedTestCase extends CodeTestCase {
  hash: string;
  /**
   * Per-test definition (resolved options + evaluate body text) captured
   * for the import path to persist as `TestCase.definition`. NOT folded
   * into `hash` — both inputs are already covered (options fields
   * explicitly, body text via `fileSource`), and keeping the hash inputs
   * unchanged is what guarantees a re-import of an unchanged file after
   * this field shipped is classified `unchanged`, not `updated`.
   */
  definition: TestCaseDefinitionCapture;
}

/** Upper bound on the persisted evaluate-body text (per test). */
export const DEFINITION_BODY_SOURCE_MAX_CHARS = 32 * 1024;
const BODY_TRUNCATION_MARKER = '\n/* … truncated — see whole file … */';

/**
 * Build the per-test `definition` capture from a registered test.
 *
 * `options` goes through a JSON round-trip so anything a user smuggled into
 * the options object that isn't data (a function, a symbol, `undefined`) is
 * dropped rather than serialized as `{}` or rejected by storage. `bodySource`
 * is `Function.prototype.toString()` of the evaluate callback — for the
 * synthetic-CJS `.js`/`.ts` paths that's the text as it appeared in the
 * executed source (esbuild-transpiled for `.ts`), bounded so a pathological
 * body can't bloat the document.
 */
export function captureTestDefinition(tc: CodeTestCase): TestCaseDefinitionCapture {
  let options: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(JSON.stringify(tc.options ?? {}));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) options = parsed;
  } catch {
    // Circular or otherwise unserializable options: persist nothing rather
    // than fail the import. The whole-file view is still available.
  }
  let bodySource = '';
  try {
    bodySource = typeof tc.evaluate === 'function' ? Function.prototype.toString.call(tc.evaluate) : '';
  } catch {
    bodySource = '';
  }
  let bodyTruncated = false;
  if (bodySource.length > DEFINITION_BODY_SOURCE_MAX_CHARS) {
    bodySource = bodySource.slice(0, DEFINITION_BODY_SOURCE_MAX_CHARS) + BODY_TRUNCATION_MARKER;
    bodyTruncated = true;
  }
  return {
    registeredAs: 'sdk',
    options,
    bodySource,
    ...(bodyTruncated ? { bodyTruncated: true } : {}),
  };
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
   * Raw text of the eval file, read once up front (before execution) for
   * BOTH .js and .ts/.mjs paths. Persisted verbatim as `sourceCode` on each
   * imported TestCase (see cli/commands/benchmark.ts) so the Test Case
   * detail page can render the whole file as an IDE-style code view --
   * without this we'd only have the parsed `initialPrompt`/`expectedOutcomes`
   * fields, not the `evaluate()` body that produced them.
   */
  fileSource: string;
  /**
   * All lifecycle hooks (`beforeEach`/`afterEach`/`beforeAll`/`afterAll`)
   * registered while loading this file. Empty when the file declares none.
   * The orchestrator filters by `(sourceFile, describePath)` at run time.
   */
  hooks: RegisteredHook[];
}

/**
 * Memoized dynamic import of esbuild's `transformSync`. A plain module-level
 * cached Promise, NOT a cross-load cache of any TRANSPILED code (see
 * `requireLocalTsModule` below for that) -- this only avoids re-running
 * `import('esbuild')` itself on every single file load. Resolved once
 * per process; after that, every caller gets the same already-resolved
 * function reference and can call it fully synchronously (required, since
 * CommonJS `require()` -- and therefore this loader's `wrappedRequire`
 * inside `runAsSyntheticCjs` -- cannot itself be async).
 */
let esbuildTransformSyncPromise: Promise<(typeof import('esbuild'))['transformSync']> | undefined;
function getEsbuildTransformSync() {
  if (!esbuildTransformSyncPromise) {
    esbuildTransformSyncPromise = import('esbuild').then(m => m.transformSync);
  }
  return esbuildTransformSyncPromise;
}

export async function loadTestCasesFromModule(filePath: string): Promise<LoadResult> {
  const absPath = resolve(filePath);

  // Read the raw file text up front, before any execution path below --
  // both the .js and .ts (synthetic-CJS) paths reuse this single read AS
  // the executed source. For .mjs, native `import()` reads the file
  // independently via Node's own module loader a few lines later -- in the
  // extremely narrow window where the file is edited between this read and
  // that import resolving, `fileSource` could theoretically diverge from
  // what actually ran. That's an accepted, practically negligible risk
  // (same file, same synchronous-ish call, no network hop) rather than a
  // guarantee.
  const fileSource = readFileSync(absPath, 'utf-8');

  // Clear any prior registration for this file and set it as active
  clearRegistry(absPath);
  setActiveFile(absPath);

  // Resolved once per load (not per require()) so that any NESTED `.ts`
  // require encountered synchronously while executing the CJS wrapper
  // below can transpile without itself needing to `await` -- `require()`
  // must be synchronous. Resolved for BOTH .js and .ts entry points (a
  // `.eval.js` file requiring a shared `./helper.ts` hits the exact same
  // "plain CJS can't load raw TypeScript" problem an `.eval.ts` entry does)
  // -- skipped for `.mjs`, which never calls `runAsSyntheticCjs` at all.
  const transformSync = absPath.endsWith('.mjs') ? undefined : await getEsbuildTransformSync();

  // Per-load cache of already-transpiled-and-executed helper `.ts` modules,
  // keyed by resolved absolute path. Deliberately scoped to THIS call (a
  // local variable, not module-level) so a helper required twice within
  // ONE load executes exactly once (matching normal CJS require() caching
  // semantics for the duration of a single load), but nothing survives
  // into the NEXT `loadTestCasesFromModule` call for the same file --
  // consistent with the top-level file itself never being cached across
  // loads either (see the .ts branch's rationale below).
  const tsModuleCache = new Map<string, any>();

  let module: any;

  // Execute `code` (already-valid CJS source) in a fresh Module instance,
  // with our test() registrar injected via require() interception. Shared
  // by real .eval.js files AND by the esbuild-transpiled .eval.ts path
  // below — both need the exact same wrappedRequire behavior so a
  // fixture's `require(...)` call for the SDK package name resolves to the
  // SAME authoring surface (and therefore the same shared registry)
  // regardless of which path produced the CJS source. Building a fresh
  // `Module` + `eval()` on every call (never caching) is what lets a file
  // be re-loaded any number of times in one process and register tests
  // again each time — see the .ts branch below for why that matters.
  //
  // `modulePath` is the file THIS particular call is executing -- the
  // outer entry file on the first call, or a resolved helper `.ts` path on
  // a recursive call from `requireLocalTsModule` below.
  const runAsSyntheticCjs = (code: string, modulePath: string): any => {
    const fileDir = dirname(modulePath);
    // NOTE: do not call require('module') here — this file is bundled as ESM
    // by esbuild for the server, and Dynamic require of built-ins is unsupported
    // in ESM output. Use the statically-imported NodeModule instead.
    const Module = NodeModule as typeof import('module');
    const m = new (Module as any)(modulePath);
    m.filename = modulePath;
    m.paths = (Module as any)._nodeModulePaths(fileDir);
    // Provide a require function scoped to the file's directory, but override
    // any require of the define module to return our own instance
    const fileRequire = createRequire(modulePath);
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
    // The object handed back when a CJS eval file requires the SDK. Single
    // source of truth shared with the package exports (see authoringSurface)
    // so `.js` and `.ts`/`.mjs` files see the SAME surface — no drift (#232).
    const sdkExports = getAuthoringSurface();

    // A helper `.ts` module required (directly or transitively) from this
    // file. Transpiled with the SAME esbuild settings as the entry file and
    // executed through this SAME `runAsSyntheticCjs` function recursively --
    // otherwise `import './helper.ts'` in the entry file, rewritten by
    // esbuild's straight CJS transform into `require('./helper.ts')`, would
    // reach real Node's `require()`, which has no loader registered for a
    // raw `.ts` extension and throws (an ERR_UNKNOWN_FILE_EXTENSION-shaped
    // failure, the exact class of bug this loader already fixes for the
    // ENTRY file -- multi-file .eval.ts needs the identical fix applied at
    // every nested require, not just the top-level import()).
    const requireLocalTsModule = (resolvedTsPath: string): any => {
      const cached = tsModuleCache.get(resolvedTsPath);
      if (cached !== undefined) return cached;
      if (!transformSync) {
        // Unreachable in practice -- transformSync is resolved above for
        // every extension that can reach this function (.js/.ts entries)
        // -- but keeps the error path honest if that ever changes.
        throw new Error(
          `Cannot import TypeScript file: ${resolvedTsPath}\n` +
          'esbuild (required to load .ts files) was not resolved for this load.'
        );
      }
      const helperSource = readFileSync(resolvedTsPath, 'utf-8');
      const helperCjs = transformSync(helperSource, {
        loader: 'ts',
        format: 'cjs',
        target: 'node18',
        sourcefile: resolvedTsPath,
      }).code;
      const helperExports = runAsSyntheticCjs(helperCjs, resolvedTsPath);
      tsModuleCache.set(resolvedTsPath, helperExports);
      return helperExports;
    };

    const wrappedRequire = (id: string) => {
      if (isDefineId(id) || isPackageName(id)) {
        return sdkExports;
      }
      // Resolve once, up front, so both the "is this our own define
      // module by a different path" check below AND the new "does this
      // resolve to a raw .ts file" check can reuse the same resolution
      // instead of duplicating fileRequire.resolve() calls.
      let resolved: string | undefined;
      try {
        resolved = fileRequire.resolve(id);
      } catch {
        // ignore unresolvable IDs — the fileRequire() call below will
        // surface the real error (e.g. MODULE_NOT_FOUND)
      }
      if (resolved) {
        const normalizedResolved = resolved.replace(/\\/g, '/');
        // Fall back to a resolution-based check so that fixtures requiring
        // the SDK by absolute path or via the published package name still
        // hand back our test() registrar (and therefore land in our
        // file-scoped registry).
        if (
          normalizedResolved.endsWith('/lib/testCases/define.js') ||
          normalizedResolved.endsWith('/lib/testCases/define')
        ) {
          return sdkExports;
        }
        if (normalizedResolved.endsWith('.ts')) {
          return requireLocalTsModule(resolved);
        }
      }
      try {
        return fileRequire(id);
      } catch (err: any) {
        if (err.code === 'ERR_REQUIRE_ESM') {
          throw new Error(
            `.eval.ts fixtures cannot import ESM-only packages via require() (attempted: '${id}').\n` +
            `'${id}' has no CommonJS entry point, and .eval.ts files execute as synthetic CJS.\n` +
            'Use .eval.mjs (real ESM -- can import ESM-only packages) or pre-compile to .eval.js instead.'
          );
        }
        throw err;
      }
    };
    (wrappedRequire as any).resolve = fileRequire.resolve;

    const wrapper = `(function(exports, require, module, __filename, __dirname) { ${code}\n});`;
    const compiledFn = eval(wrapper);
    compiledFn(m.exports, wrappedRequire, m, modulePath, fileDir);
    return m.exports;
  };

  if (absPath.endsWith('.js')) {
    // For CJS .js files, execute in a fresh context with our test() function
    // injected. This avoids module caching issues across multiple loads.
    module = runAsSyntheticCjs(fileSource, absPath);
  } else if (absPath.endsWith('.ts')) {
    // .eval.ts ALWAYS goes through the esbuild-transpile -> synthetic-CJS
    // path below, on every Node version — never a native `import()`, not
    // even as a "try native first, fall back to esbuild" strategy. Two
    // reasons this has to be unconditional rather than fallback-only:
    //
    //  1. Dual semantics: native `import()` under Node 22.6+/24's built-in
    //     TypeScript type-stripping gives the file REAL ESM module
    //     semantics (its own module registry entry, `import.meta`,
    //     top-level `await`, live bindings) — a completely different
    //     execution model from the synthetic-CJS path a fallback-only
    //     design would give the exact same file on Node <22.6. Two Node
    //     majors running one .eval.ts file through two different module
    //     systems is exactly the kind of gap that let the shared-registry
    //     bug documented above (`globalThis[Symbol.for(...)]`) happen in
    //     the first place — unifying on one path removes the gap instead
    //     of quietly reintroducing a second copy of it.
    //  2. ESM cache staleness: `import()` caches by resolved URL. A
    //     long-lived server process re-loading the SAME .eval.ts file a
    //     second time (a normal `agent-health benchmark -f` re-run after
    //     editing the fixture, not an exotic case) would silently get back
    //     the ALREADY-cached module without re-executing its top-level
    //     code, so `test()`/`describe()` never fire a second time and the
    //     `clearRegistry()` call above has nothing to refill — "has no
    //     test cases" on the second load with no code change at all.
    //     `.eval.js` never had this problem: `runAsSyntheticCjs` builds a
    //     fresh `Module` instance and `eval()`s the source on every single
    //     call, uncached. `.eval.ts` now shares that exact same
    //     never-cached execution path.
    //
    // Trade-off this accepts: an .eval.ts fixture can no longer use
    // `import.meta` or a top-level `await` (esbuild's CJS output has
    // neither) — documented in docs/SDK.md. Same trade-off applies to any
    // helper `.ts` file it imports (see `requireLocalTsModule` above).
    // esbuild is a required runtime dependency of this package
    // specifically because of this unconditional path (see package.json
    // "dependencies").
    if (!transformSync) {
      throw new Error(`Cannot import TypeScript file: ${filePath}\nesbuild was not resolved.`);
    }
    let cjsSource: string;
    try {
      cjsSource = transformSync(fileSource, {
        loader: 'ts',
        format: 'cjs',
        target: 'node18',
        sourcefile: absPath,
      }).code;
    } catch (esbuildErr: any) {
      throw new Error(
        `Cannot import TypeScript file: ${filePath}\n` +
        `esbuild (required to load .eval.ts files) failed to transpile it: ${esbuildErr.message}\n` +
        'Or pre-compile .eval.ts to .eval.js before running.'
      );
    }
    module = runAsSyntheticCjs(cjsSource, absPath);
  } else {
    // .eval.mjs: plain ESM with no TypeScript to strip, so native
    // `import()` works unconditionally on every Node version this package
    // supports — it stays the only path for this extension. Unlike .ts,
    // there is no synthetic-CJS equivalent to unify onto here (real ESM
    // files, `import.meta`, top-level `await`, etc. are all first-class
    // for .mjs, and always were).
    //
    // Same ESM cache-staleness bug class fixed for .ts above (see that
    // branch's rationale #2) applies here too: `import()` caches by
    // resolved URL, so re-loading the SAME .eval.mjs file a second time in
    // one process (a normal `agent-health benchmark -f` re-run after
    // editing the fixture) would otherwise silently return the
    // already-executed cached module without re-running its top-level
    // `test()` calls. Cache-busted with a unique query string per load --
    // there is no synthetic-CJS escape hatch available for real ESM the
    // way there is for .ts, so this is the fix here. Accepted cost: every
    // reload leaks one cached module instance under a never-reused query
    // string for the life of the process -- negligible for CLI/server
    // process lifetimes (a handful to a few hundred loads, not millions).
    try {
      const fileUrl = `${pathToFileURL(absPath).href}?ah-reload=${Date.now()}-${Math.random().toString(36).slice(2)}`;
      module = await import(fileUrl);
    } catch (err: any) {
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

  // Compute per-test-case hash. Includes fileSource (see
  // computeTestCaseHash) so ANY change to the file -- not just the
  // options fields already tracked -- invalidates the hash and triggers a
  // re-persist, keeping the stored sourceCode in sync with disk.
  const loaded: LoadedTestCase[] = testCases.map(tc => ({
    ...tc,
    hash: computeTestCaseHash(tc, fileSource),
    definition: captureTestDefinition(tc),
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

  return { testCases: loaded, filePath: absPath, benchmarks, hooks, fileSource };
}
