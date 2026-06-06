/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TestCaseSource, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';
import { getCategoryFromLabels, getDifficultyFromLabels } from '@/lib/testCaseLabels';
import { debug } from '@/lib/debug';
import type { EvalResult, RegisteredHook } from '@/lib/testCases/types';

/**
 * The signature of a test body. Accepts both legacy `(result)` form and
 * the new Playwright-style fixtures object. Internally the runner passes
 * a single argument that satisfies both shapes (an EvalResult merged with
 * the fixtures), so callers downcast as needed.
 */
export type EvaluateFn = (resultOrFixtures: any) => Promise<void> | void;

export interface ResolvedSources {
  testCases: TestCase[];
  sources: TestCaseSource[];
  deduplicatedCount: number;
  evaluateFnMap: Map<string, EvaluateFn>;
  /**
   * Lifecycle hooks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`)
   * registered by code-imported eval files, keyed by the absolute file
   * path the loader resolved. Empty when no code sources or none of them
   * declared hooks. Plumbed into the runner to build a `HookOrchestrator`.
   */
  hooksByFile: Map<string, RegisteredHook[]>;
  /**
   * Per-test-case metadata the runner needs to look up the right scope
   * chain for hooks: which file it came from, and which describe path
   * (`undefined` for tests at file top level). Only populated for
   * code-imported test cases.
   */
  testHookScopes: Map<string, { sourceFile?: string; describePath?: string }>;
}

export async function resolveTestCaseSources(
  sources: TestCaseSource[],
  storage: IStorageModule
): Promise<ResolvedSources> {
  const allTestCases: TestCase[] = [];
  const updatedSources: TestCaseSource[] = [];
  const evaluateFnMap = new Map<string, EvaluateFn>();
  const hooksByFile = new Map<string, RegisteredHook[]>();
  const testHookScopes = new Map<string, { sourceFile?: string; describePath?: string }>();

  for (const source of sources) {
    switch (source.type) {
      case 'benchmark': {
        const benchmark = await storage.benchmarks.getById(source.benchmarkId);
        if (!benchmark) {
          throw new Error(`Benchmark not found: ${source.benchmarkId}`);
        }
        const testCases = await fetchTestCasesByIds(benchmark.testCaseIds, storage);
        allTestCases.push(...testCases);
        updatedSources.push(source);
        debug('SourceResolver', `Resolved ${testCases.length} test cases from benchmark ${source.benchmarkId}`);
        break;
      }

      case 'test-case-ids': {
        const testCases = await fetchTestCasesByIds(source.ids, storage);
        allTestCases.push(...testCases);
        updatedSources.push(source);
        debug('SourceResolver', `Resolved ${testCases.length} test cases from explicit IDs`);
        break;
      }

      case 'file-import': {
        const testCases = await resolveFileImport(source.filenames, storage);
        const testCaseIds = testCases.map((tc) => tc.id);
        allTestCases.push(...testCases);
        updatedSources.push({ ...source, testCaseIds });
        debug('SourceResolver', `Imported ${testCases.length} test cases from ${source.filenames.length} file(s)`);
        break;
      }

      case 'code-import': {
        const { testCases, fnMap, hooksByFile: codeHooks, testScopes } = await resolveCodeImport(source.filenames, storage);
        const testCaseIds = testCases.map((tc) => tc.id);
        allTestCases.push(...testCases);
        for (const [id, fn] of fnMap) {
          evaluateFnMap.set(id, fn);
        }
        for (const [file, hooks] of codeHooks) {
          hooksByFile.set(file, hooks);
        }
        for (const [id, scope] of testScopes) {
          testHookScopes.set(id, scope);
        }
        updatedSources.push({ ...source, testCaseIds });
        debug('SourceResolver', `Code-imported ${testCases.length} test cases from ${source.filenames.length} file(s)`);
        break;
      }

      case 'directory-import': {
        const testCases = await resolveDirectoryImport(source.dirPaths, storage);
        const testCaseIds = testCases.map((tc) => tc.id);
        allTestCases.push(...testCases);
        updatedSources.push({ ...source, testCaseIds });
        debug('SourceResolver', `Imported ${testCases.length} test cases from ${source.dirPaths.length} directory(ies)`);
        break;
      }

      case 'label-filter': {
        const result = await storage.testCases.search({ labels: source.labels });
        allTestCases.push(...result.items);
        updatedSources.push(source);
        debug('SourceResolver', `Found ${result.items.length} test cases matching labels: ${source.labels.join(', ')}`);
        break;
      }
    }
  }

  // Deduplicate by test case ID (first occurrence wins)
  const seen = new Map<string, TestCase>();
  for (const tc of allTestCases) {
    if (!seen.has(tc.id)) {
      seen.set(tc.id, tc);
    }
  }

  const deduplicatedCount = allTestCases.length - seen.size;
  debug('SourceResolver', `Deduplicated ${deduplicatedCount} test cases, ${seen.size} unique remaining`);

  return {
    testCases: Array.from(seen.values()),
    sources: updatedSources,
    deduplicatedCount,
    evaluateFnMap,
    hooksByFile,
    testHookScopes,
  };
}

/**
 * Re-materialize the code test bodies (and hooks/scopes) for a set of
 * already-stored test cases — the benchmark-run entry point.
 *
 * Unlike {@link resolveTestCaseSources} (which is given source descriptors,
 * e.g. `code-import` filenames, and upserts), this starts from test cases
 * that were persisted by a prior `benchmark -f` import. It discovers their
 * source files from the stored `sourceFile` provenance, dynamically imports
 * each unique file, and maps `storedId → evaluate fn` by `(sourceFile, name)`.
 * It does NOT upsert/bump versions — the test cases already exist.
 *
 * This is the single home for benchmark-side code-import resolution: the
 * `POST /api/storage/benchmarks/:id/run` route used to hand-roll ~95 lines
 * of equivalent logic inline (#245/#246). Returns empty maps when none of
 * the stored test cases carry a code `sourceFile`.
 */
export async function resolveCodeFnMapForStoredTestCases(
  storedTestCases: TestCase[],
): Promise<{
  evaluateFnMap: Map<string, EvaluateFn>;
  hooksByFile: Map<string, RegisteredHook[]>;
  testHookScopes: Map<string, { sourceFile?: string; describePath?: string }>;
}> {
  const evaluateFnMap = new Map<string, EvaluateFn>();
  const hooksByFile = new Map<string, RegisteredHook[]>();
  const testHookScopes = new Map<string, { sourceFile?: string; describePath?: string }>();

  // Which stored test cases came from a code file? Collect their unique
  // source files. `.json` provenance is ignored — only executable bodies.
  const isCodeFile = (sf: string) =>
    sf.endsWith('.eval.js') || sf.endsWith('.eval.ts') || sf.endsWith('.eval.mjs') ||
    sf.endsWith('.js') || sf.endsWith('.ts') || sf.endsWith('.mjs');

  const codeFilesToLoad = new Set<string>();
  const tcByNameAndFile = new Map<string, TestCase>();
  for (const tc of storedTestCases) {
    const sf = (tc as any).sourceFile as string | undefined;
    if (sf && isCodeFile(sf)) {
      codeFilesToLoad.add(sf);
      tcByNameAndFile.set(`${sf}\u0000${tc.name}`, tc);
    }
  }
  if (codeFilesToLoad.size === 0) {
    return { evaluateFnMap, hooksByFile, testHookScopes };
  }

  const { loadTestCasesFromModule } = await import('@/lib/testCases/loader');
  for (const filePath of codeFilesToLoad) {
    try {
      const loaded = await loadTestCasesFromModule(filePath);
      // Re-derive the relative key the stored docs were keyed on.
      const relSourceFile = path.relative(process.cwd(), loaded.filePath);
      for (const tc of loaded.testCases) {
        const stored = tcByNameAndFile.get(`${relSourceFile}\u0000${tc.name}`);
        if (stored && tc.evaluate) {
          evaluateFnMap.set(stored.id, tc.evaluate as EvaluateFn);
          testHookScopes.set(stored.id, {
            sourceFile: loaded.filePath,
            describePath: tc.benchmarkPath,
          });
        }
      }
      if (loaded.hooks && loaded.hooks.length > 0) {
        hooksByFile.set(loaded.filePath, loaded.hooks);
      }
    } catch (loadErr: any) {
      // Non-fatal: a missing/!broken file just means those test cases run
      // without a code body (classic judge path). Mirrors prior behavior.
      debug('SourceResolver', `Failed to re-resolve code file ${filePath}: ${loadErr?.message ?? loadErr}`);
    }
  }

  return { evaluateFnMap, hooksByFile, testHookScopes };
}

async function fetchTestCasesByIds(ids: string[], storage: IStorageModule): Promise<TestCase[]> {
  return Promise.all(
    ids.map(async (id) => {
      const tc = await storage.testCases.getById(id);
      if (!tc) throw new Error(`Test case not found: ${id}`);
      return tc;
    })
  );
}

async function resolveFileImport(filenames: string[], storage: IStorageModule): Promise<TestCase[]> {
  const allCreated: TestCase[] = [];

  for (const filename of filenames) {
    if (!fs.existsSync(filename)) {
      throw new Error(`File not found: ${filename}`);
    }

    const content = fs.readFileSync(filename, 'utf-8');
    const parsed = JSON.parse(content);
    const validation = validateTestCasesArrayJson(parsed);

    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => e.message).join('; ');
      throw new Error(`Validation failed for ${filename}: ${errorMessages}`);
    }

    const result = await storage.testCases.bulkCreate(validation.data!);
    allCreated.push(...result.testCases);
  }

  return allCreated;
}

async function resolveCodeImport(
  filenames: string[],
  storage: IStorageModule
): Promise<{
  testCases: TestCase[];
  fnMap: Map<string, EvaluateFn>;
  hooksByFile: Map<string, RegisteredHook[]>;
  testScopes: Map<string, { sourceFile?: string; describePath?: string }>;
}> {
  const { loadTestCasesFromModule } = await import('@/lib/testCases/loader');
  const { clearEvaluators } = await import('@/lib/testCases/evaluators');
  // Evaluators register into a process-global registry. Clear it before
  // loading this batch so (a) evaluators from a prior run don't leak into
  // this one, and (b) re-loading the same file (fresh fn identity each load)
  // doesn't trip defineEvaluator's duplicate-id guard. Genuine collisions
  // *within* this batch (two files, same id, different fn) still throw.
  clearEvaluators();
  const allTestCases: TestCase[] = [];
  const fnMap = new Map<string, EvaluateFn>();
  const hooksByFile = new Map<string, RegisteredHook[]>();
  const testScopes = new Map<string, { sourceFile?: string; describePath?: string }>();

  for (const filename of filenames) {
    if (!fs.existsSync(filename)) {
      throw new Error(`Code file not found: ${filename}`);
    }

    const loaded = await loadTestCasesFromModule(filename);
    const sourceFile = path.relative(process.cwd(), loaded.filePath);

    const upsertInput = loaded.testCases.map(tc => {
      // Labels are the source of truth in the new SDK. Derive the legacy
      // top-level fields for back-compat with existing storage / UI that
      // still reads them. Cold-start migration folds these the other way
      // for documents created before labels existed.
      const labels = tc.options.labels;
      const category = getCategoryFromLabels(labels);
      const difficulty = getDifficultyFromLabels(labels);
      return {
        name: tc.name,
        // Derived from labels for back-compat. Optional now — the storage
        // layer accepts undefined and the UI falls back to label lookups.
        ...(category ? { category } : {}),
        ...(difficulty ? { difficulty } : {}),
        initialPrompt: tc.options.prompt,
        context: tc.options.context,
        labels,
        sourceFile,
        sourceHash: tc.hash,
        // Forward expectedOutcomes / expectedTrajectory so server-side
        // evaluators (`-e <evaluator>`, /api/evaluate) can grade the run
        // even when the test was authored as a code-based .eval.js. Inline
        // judge() inside the body still works without these (it ships
        // claims directly in the request payload), but persisting them on
        // the test case is what closes issue #245's missing-validation
        // path: without forwarding, the server evaluator throws
        // "Missing required field: expectedOutcomes" and the run is
        // reported as a `completed` 0% pass-rate with a misleading reason.
        ...(tc.options.expectedOutcomes ? { expectedOutcomes: tc.options.expectedOutcomes } : {}),
        ...(tc.options.expectedTrajectory ? { expectedTrajectory: tc.options.expectedTrajectory } : {}),
        // Description fed in via test() options also flows here — it was
        // already supported in the type but never forwarded.
        ...(tc.options.description ? { description: tc.options.description } : {}),
      };
    });

    const result = await storage.testCases.bulkUpsert(upsertInput as Parameters<typeof storage.testCases.bulkUpsert>[0]);
    allTestCases.push(...result.testCases);

    result.testCases.forEach((stored, i) => {
      const loadedTc = loaded.testCases[i];
      if (loadedTc?.evaluate) {
        fnMap.set(stored.id, loadedTc.evaluate);
      }
      // Record the (file, describePath) scope for every code-imported test
      // case so the orchestrator can look up the right hook chain at run
      // time. We key on the absolute file path the loader resolved —
      // matches `RegisteredHook.sourceFile` exactly.
      if (loadedTc) {
        testScopes.set(stored.id, {
          sourceFile: loaded.filePath,
          describePath: loadedTc.benchmarkPath,
        });
      }
    });

    // `loaded.hooks` is guaranteed by the loader, but be defensive for
    // older mocks / partial loaders that don't return it.
    if (loaded.hooks && loaded.hooks.length > 0) {
      hooksByFile.set(loaded.filePath, loaded.hooks);
    }
  }

  return { testCases: allTestCases, fnMap, hooksByFile, testScopes };
}

async function resolveDirectoryImport(dirPaths: string[], storage: IStorageModule): Promise<TestCase[]> {
  const allCreated: TestCase[] = [];

  for (const dirPath of dirPaths) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const entries = fs.readdirSync(dirPath);
    const jsonFiles = entries.filter((entry) => entry.endsWith('.json'));

    if (jsonFiles.length === 0) {
      throw new Error(`No JSON files found in directory: ${dirPath}`);
    }

    const filePaths = jsonFiles.map((file) => path.join(dirPath, file));
    const testCases = await resolveFileImport(filePaths, storage);
    allCreated.push(...testCases);
  }

  return allCreated;
}
