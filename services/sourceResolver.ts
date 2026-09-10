/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
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
  // Test cases that came from STORED sources (benchmark / explicit ids /
  // label filter) rather than a fresh file import. Any of these carrying a
  // code `sourceFile` must have its body re-materialized below — the same
  // stored test case must dispatch the same way no matter which route or
  // source descriptor selected it.
  const storedSourceTestCases: TestCase[] = [];
  let sawCodeImport = false;

  for (const source of sources) {
    switch (source.type) {
      case 'benchmark': {
        const benchmark = await storage.benchmarks.getById(source.benchmarkId);
        if (!benchmark) {
          throw new Error(`Benchmark not found: ${source.benchmarkId}`);
        }
        const testCases = await fetchTestCasesByIds(benchmark.testCaseIds, storage);
        allTestCases.push(...testCases);
        storedSourceTestCases.push(...testCases);
        updatedSources.push(source);
        debug('SourceResolver', `Resolved ${testCases.length} test cases from benchmark ${source.benchmarkId}`);
        break;
      }

      case 'test-case-ids': {
        const testCases = await fetchTestCasesByIds(source.ids, storage);
        allTestCases.push(...testCases);
        storedSourceTestCases.push(...testCases);
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
        sawCodeImport = true;
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
        storedSourceTestCases.push(...result.items);
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

  // Re-materialize code bodies for stored test cases that reference a code
  // `sourceFile` and weren't already mapped by a `code-import` source in this
  // same request. Pre-fix only the legacy `/execute` route did this (and
  // swallowed failures), so a benchmark of code-SDK test cases dispatched to
  // the SDK body or to the classic eager-judge path depending on WHICH route
  // launched it and on the server's cwd. Unresolvable bodies are a hard error
  // (see resolveCodeFnMapForStoredTestCases) surfaced through the callers'
  // existing pre-start error path.
  const needBodies: TestCase[] = [];
  const needSeen = new Set<string>();
  for (const tc of storedSourceTestCases) {
    if (evaluateFnMap.has(tc.id) || needSeen.has(tc.id)) continue;
    needSeen.add(tc.id);
    needBodies.push(tc);
  }
  if (needBodies.length > 0) {
    const stored = await resolveCodeFnMapForStoredTestCases(needBodies, {
      // A code-import in this same request already reset the evaluator
      // registry and registered its evaluators — don't wipe them.
      clearEvaluatorRegistry: !sawCodeImport,
    });
    for (const [id, fn] of stored.evaluateFnMap) evaluateFnMap.set(id, fn);
    for (const [file, hooks] of stored.hooksByFile) {
      if (!hooksByFile.has(file)) hooksByFile.set(file, hooks);
    }
    for (const [id, scope] of stored.testHookScopes) testHookScopes.set(id, scope);
  }

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
 * Code-file extensions whose stored `sourceFile` implies an executable test
 * body that must be re-materialized before a run. `.json` provenance is not
 * code.
 */
function isCodeSourceFile(sf: string): boolean {
  return sf.endsWith('.eval.js') || sf.endsWith('.eval.ts') || sf.endsWith('.eval.mjs') ||
    sf.endsWith('.js') || sf.endsWith('.ts') || sf.endsWith('.mjs');
}

/**
 * Canonical lookup key for a source file: cwd-relative, forward-slash
 * separated, resolved against `process.cwd()` whether the input is the
 * stored relative `sourceFile` (possibly with Windows separators from the
 * importing machine) or the absolute path the loader resolved. Both sides of
 * the `(sourceFile, name)` join go through this so a separator or `./`
 * difference can never silently miss.
 */
export function sourceFileKey(p: string, cwd: string = process.cwd()): string {
  const posix = p.replace(/\\/g, '/');
  const abs = path.isAbsolute(posix) ? posix : path.resolve(cwd, posix);
  return path.relative(cwd, abs).split(path.sep).join('/');
}

/** One stored test case whose code body could not be re-materialized. */
export interface UnresolvableSourceFile {
  testCaseId: string;
  testCaseName: string;
  sourceFile: string;
  reason: 'load-failed' | 'no-matching-test';
  detail?: string;
}

/**
 * Error thrown when stored code-SDK test cases cannot be re-materialized
 * from the server's cwd. Carries the structured list so routes/CLI can
 * render it; `message` is the human-readable form.
 */
export class UnresolvableSourceFilesError extends Error {
  readonly cwd: string;
  readonly unresolvable: UnresolvableSourceFile[];
  constructor(unresolvable: UnresolvableSourceFile[], cwd: string = process.cwd()) {
    super(formatUnresolvableSourceFiles(unresolvable, cwd));
    this.name = 'UnresolvableSourceFilesError';
    this.cwd = cwd;
    this.unresolvable = unresolvable;
  }
}

export function formatUnresolvableSourceFiles(unresolvable: UnresolvableSourceFile[], cwd: string): string {
  const lines = unresolvable.map(u => {
    if (u.reason === 'load-failed') {
      return `Test case "${u.testCaseName}" references source file "${u.sourceFile}" which is not resolvable from cwd ${cwd}` +
        (u.detail ? ` (${u.detail})` : '');
    }
    return `Test case "${u.testCaseName}" references source file "${u.sourceFile}" which loaded from cwd ${cwd} but defines no test named "${u.testCaseName}"`;
  });
  return (
    `Cannot run ${unresolvable.length} code-SDK test case(s): their source files could not be re-materialized from cwd ${cwd}.\n` +
    lines.map(l => `  - ${l}`).join('\n') +
    `\nStart the server from the eval project root or re-import the test cases (benchmark -f <file>).`
  );
}

/**
 * Re-materialize the code test bodies (and hooks/scopes) for a set of
 * already-stored test cases — the benchmark-run entry point.
 *
 * Unlike {@link resolveTestCaseSources} (which is given source descriptors,
 * e.g. `code-import` filenames, and upserts), this starts from test cases
 * that were persisted by a prior `benchmark -f` import. It discovers their
 * source files from the stored `sourceFile` provenance, dynamically imports
 * each unique file (resolved against `process.cwd()`), and maps
 * `storedId → evaluate fn` by the normalised `(sourceFile, name)` key. It
 * does NOT upsert/bump versions — the test cases already exist.
 *
 * **Hard error on any unresolvable body.** A stored test case that carries a
 * code `sourceFile` MUST run its body. If the file cannot be loaded from the
 * server's cwd (ENOENT, import error) or loads but defines no test of that
 * name, this throws {@link UnresolvableSourceFilesError} listing every
 * offender and the cwd — BEFORE the run starts. Pre-fix this logged at
 * `debug` level and fell through, so the same stored test cases were judged
 * by the SDK body on a server started from the eval repo and by the classic
 * eager judge (a different verdict path) on any other server, with nothing
 * in the report saying which.
 *
 * Returns empty maps when none of the stored test cases carry a code
 * `sourceFile`.
 */
export async function resolveCodeFnMapForStoredTestCases(
  storedTestCases: TestCase[],
  options?: {
    /**
     * Reset the process-global custom-evaluator registry before loading (the
     * loader re-registers `defineEvaluator()` ids and a stale registration
     * from a prior load trips its duplicate-id guard). Default true; callers
     * that already loaded code in this same request pass false.
     */
    clearEvaluatorRegistry?: boolean;
  },
): Promise<{
  evaluateFnMap: Map<string, EvaluateFn>;
  hooksByFile: Map<string, RegisteredHook[]>;
  testHookScopes: Map<string, { sourceFile?: string; describePath?: string }>;
}> {
  const evaluateFnMap = new Map<string, EvaluateFn>();
  const hooksByFile = new Map<string, RegisteredHook[]>();
  const testHookScopes = new Map<string, { sourceFile?: string; describePath?: string }>();

  // Which stored test cases came from a code file? Collect their unique
  // source files (by normalised key) and index the stored docs by
  // (key, name).
  const cwd = process.cwd();
  const codeTestCases: Array<{ tc: TestCase; sourceFile: string; key: string }> = [];
  for (const tc of storedTestCases) {
    const sf = (tc as any).sourceFile as string | undefined;
    if (sf && isCodeSourceFile(sf)) {
      codeTestCases.push({ tc, sourceFile: sf, key: sourceFileKey(sf, cwd) });
    }
  }
  if (codeTestCases.length === 0) {
    return { evaluateFnMap, hooksByFile, testHookScopes };
  }

  const filesByKey = new Map<string, string>(); // key → first stored sourceFile spelling
  const tcByKeyAndName = new Map<string, TestCase>();
  for (const { tc, sourceFile, key } of codeTestCases) {
    if (!filesByKey.has(key)) filesByKey.set(key, sourceFile);
    tcByKeyAndName.set(`${key}\u0000${tc.name}`, tc);
  }

  if (options?.clearEvaluatorRegistry !== false) {
    const { clearEvaluators } = await import('@/lib/testCases/evaluators');
    clearEvaluators();
  }

  const { loadTestCasesFromModule } = await import('@/lib/testCases/loader');
  const loadErrors = new Map<string, string>(); // key → error detail
  for (const [key, sourceFile] of filesByKey) {
    try {
      const loaded = await loadTestCasesFromModule(path.resolve(cwd, sourceFile.replace(/\\/g, '/')));
      // Re-derive the relative key the stored docs were keyed on — through
      // the SAME normaliser, so the join cannot miss on separators.
      const loadedKey = sourceFileKey(loaded.filePath, cwd);
      const drifted: string[] = [];
      for (const tc of loaded.testCases) {
        const stored = tcByKeyAndName.get(`${loadedKey}\u0000${tc.name}`) ?? tcByKeyAndName.get(`${key}\u0000${tc.name}`);
        if (stored && tc.evaluate) {
          evaluateFnMap.set(stored.id, tc.evaluate as EvaluateFn);
          testHookScopes.set(stored.id, {
            sourceFile: loaded.filePath,
            describePath: tc.benchmarkPath,
          });
          // The file on disk is the executable truth (that is the SDK's
          // contract), but the stored doc remembers the hash it was
          // imported at. Say so loudly when they disagree — the run is
          // executing a body the stored test case never saw. Not fatal:
          // editing an eval file and re-running from the UI is a normal
          // loop; re-import (`benchmark -f`) refreshes the stored hash.
          const storedHash = (stored as any).sourceHash as string | undefined;
          if (storedHash && tc.hash && storedHash !== tc.hash) drifted.push(tc.name);
        }
      }
      if (drifted.length > 0) {
        console.warn(
          `[SourceResolver] source drift: "${sourceFile}" on disk no longer matches the stored sourceHash for ` +
          `${drifted.length} test case(s) (${drifted.map(n => JSON.stringify(n)).join(', ')}) — running the CURRENT file; ` +
          `re-import with \`benchmark -f ${sourceFile}\` to refresh the stored definition.`
        );
      }
      if (loaded.hooks && loaded.hooks.length > 0) {
        hooksByFile.set(loaded.filePath, loaded.hooks);
      }
    } catch (loadErr: any) {
      loadErrors.set(key, String(loadErr?.message ?? loadErr).split('\n')[0]);
    }
  }

  // Every stored code test case must now have a body. Anything left over is
  // a hard error — fail the run before it starts rather than silently
  // switching that case to the classic judge path.
  const unresolvable: UnresolvableSourceFile[] = [];
  for (const { tc, sourceFile, key } of codeTestCases) {
    if (evaluateFnMap.has(tc.id)) continue;
    const detail = loadErrors.get(key);
    unresolvable.push({
      testCaseId: tc.id,
      testCaseName: tc.name,
      sourceFile,
      reason: detail !== undefined ? 'load-failed' : 'no-matching-test',
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  if (unresolvable.length > 0) {
    const err = new UnresolvableSourceFilesError(unresolvable, cwd);
    debug('SourceResolver', err.message);
    throw err;
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

const IMPORT_METADATA_FIELDS = new Set([
  'id', 'version', 'currentVersion', 'versions', 'createdAt', 'updatedAt',
  'sourceFile', 'sourceHash',
]);

function canonicalDefinition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDefinition);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, field]) => !IMPORT_METADATA_FIELDS.has(key) && field !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => [key, canonicalDefinition(field)])
    );
  }
  return value;
}

function definitionHash(testCase: Partial<TestCase>): string {
  return createHash('sha256').update(JSON.stringify(canonicalDefinition(testCase))).digest('hex');
}

/**
 * Static JSON imports are declarative definitions, not requests to mint new
 * identities. Reuse an existing document when its name/category and semantic
 * content match. This preserves stable test-case IDs across repeated -f/-d
 * CLI runs while deliberately leaving changed definitions as new documents.
 */
async function reuseOrCreateImportedTestCases(
  definitions: Partial<TestCase>[],
  storage: IStorageModule
): Promise<TestCase[]> {
  const scanLimit = 10_000;
  const { items, total } = await storage.testCases.getAll({ size: scanLimit });
  if (total > items.length) {
    throw new Error(
      `Cannot safely match imported test cases: ${total} existing cases exceed the ${scanLimit}-case scan limit. ` +
      'No cases were imported. Reduce the stored case count and retry; import matching needs a complete scan to avoid duplicates.'
    );
  }
  const candidates = [...items];
  const resolved: TestCase[] = [];

  for (const definition of definitions) {
    const hash = definitionHash(definition);
    if (definition.sourceHash && definition.sourceHash !== hash) {
      debug('SourceResolver', `Ignoring stale sourceHash for imported test case ${definition.name ?? '<unnamed>'}`);
    }
    const canonical = JSON.stringify(canonicalDefinition(definition));
    const existing = candidates.find(candidate =>
      candidate.name === definition.name &&
      candidate.category === definition.category &&
      ((candidate.sourceHash && candidate.sourceHash === hash) ||
        JSON.stringify(canonicalDefinition(candidate)) === canonical)
    );

    if (existing) {
      resolved.push(existing);
      continue;
    }

    const created = await storage.testCases.create({ ...definition, sourceHash: hash });
    candidates.push(created);
    resolved.push(created);
  }

  return resolved;
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

    const testCases = await reuseOrCreateImportedTestCases(validation.data!, storage);
    allCreated.push(...testCases);
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
  const { loadTestCasesFromModule, detectSourceLanguage } = await import('@/lib/testCases/loader');
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
    const sourceFileName = path.basename(sourceFile);
    const sourceLanguage = detectSourceLanguage(sourceFile);

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
        // See cli/commands/benchmark.ts for rationale -- full eval-file text
        // + provenance so the Test Case detail page can render an
        // IDE-style source view regardless of which import path produced
        // the test case.
        sourceCode: loaded.fileSource,
        sourceFileName,
        sourceLanguage,
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
