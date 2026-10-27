/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proves the CLI coverage pipeline end to end with the REAL tools, no mocks
 * (c8 maps the bundle back onto the cli/ TypeScript sources):
 *
 *   real `cli/dist/index.js` process started with NODE_V8_COVERAGE
 *     → Node writes a raw V8 coverage dump for that process only
 *     → `c8 report --config .c8rc.json` maps it through the esbuild source map
 *     → lcov records keyed by cli/<...>.ts source paths
 *
 * The assertions are chosen so a FAKE result fails:
 *   - a function the command never calls (`killServerOnPort` in
 *     cli/utils/serverLifecycle.ts) must be reported with 0 hits, and the file
 *     must be strictly below 100% lines — the c8 `--exclude-after-remap`
 *     path-matching bug this repo works around (see .c8rc.json) reports every
 *     file as 100%, which this test would catch;
 *   - a function the command does call (the `list` command module) must have
 *     hits > 0, so the numbers are not all-zero either;
 *   - nothing outside cli/** leaks into the report.
 *
 * Only the child written by this test is killed/waited on (spawnSync), and all
 * dumps go to a per-test temp dir that is removed afterwards.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withCliCoverage, CLI_COVERAGE_DIR_VAR } from '../../helpers/cliCoverage';

const TEST_TIMEOUT = 180_000;
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CLI_BUNDLE = join(REPO_ROOT, 'cli', 'dist', 'index.js');
const CLI_BUNDLE_MAP = `${CLI_BUNDLE}.map`;

function ensureSourceMappedCliBundle(): void {
  if (existsSync(CLI_BUNDLE) && existsSync(CLI_BUNDLE_MAP)) return;
  const built = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
  if (built.status !== 0) throw new Error('npm run build:cli failed; cannot continue');
  if (!existsSync(CLI_BUNDLE_MAP)) {
    throw new Error(`build:cli did not emit ${CLI_BUNDLE_MAP} — the CLI bundle must be built with --sourcemap for cli coverage`);
  }
}

function resolveC8Bin(): string {
  try {
    return require.resolve('c8/bin/c8.js', { paths: [REPO_ROOT] });
  } catch {
    // Local dev escape hatch when c8 is not installed in node_modules
    // (CI always has it: it is a devDependency installed by `npm ci`).
    if (process.env.AH_C8_BIN) return process.env.AH_C8_BIN;
    throw new Error('c8 is not resolvable from the repo root; run "npm ci" (or set AH_C8_BIN to a c8 bin for local runs)');
  }
}

/** Minimal lcov reader: SF → { fnHits: Map<name, hits>, da: Map<line, hits> }. */
function parseLcov(text: string): Map<string, { fnHits: Map<string, number>; da: Map<number, number> }> {
  const out = new Map<string, { fnHits: Map<string, number>; da: Map<number, number> }>();
  let cur: { fnHits: Map<string, number>; da: Map<number, number> } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      cur = { fnHits: new Map(), da: new Map() };
      out.set(line.slice(3).trim(), cur);
    } else if (cur && line.startsWith('FNDA:')) {
      const [hits, name] = line.slice(5).split(',');
      cur.fnHits.set(name, Number(hits));
    } else if (cur && line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',');
      cur.da.set(Number(ln), Number(hits));
    } else if (line === 'end_of_record') {
      cur = null;
    }
  }
  return out;
}

describe('CLI coverage pipeline (NODE_V8_COVERAGE → c8 → lcov on cli/**/*.ts)', () => {
  let dumpDir: string;
  let reportDir: string;
  const savedVar = process.env[CLI_COVERAGE_DIR_VAR];

  beforeAll(() => {
    ensureSourceMappedCliBundle();
    dumpDir = mkdtempSync(join(tmpdir(), 'ah-cli-v8-'));
    reportDir = mkdtempSync(join(tmpdir(), 'ah-cli-cov-'));
  }, TEST_TIMEOUT);

  afterAll(() => {
    if (savedVar === undefined) delete process.env[CLI_COVERAGE_DIR_VAR];
    else process.env[CLI_COVERAGE_DIR_VAR] = savedVar;
    rmSync(dumpDir, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
  });

  it(
    'a real CLI process writes a V8 dump, and c8 maps it to real (non-100%) cli/**/*.ts coverage',
    () => {
      // Opt in exactly the way CI does: the variable is set for the test process,
      // and withCliCoverage() turns it into NODE_V8_COVERAGE on the child.
      process.env[CLI_COVERAGE_DIR_VAR] = dumpDir;
      const env = withCliCoverage({ ...process.env, AH_SUPPRESS_EXPERIMENTAL: '1' });
      expect(env.NODE_V8_COVERAGE).toBe(dumpDir);

      const cli = spawnSync(process.execPath, [CLI_BUNDLE, 'list', 'connectors', '--output', 'json'], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(cli.status).toBe(0);

      // 1. Node wrote exactly one dump — for the CLI child, not for this jest process.
      const dumps = readdirSync(dumpDir).filter((f) => f.endsWith('.json'));
      expect(dumps).toHaveLength(1);
      const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]), 'utf8'));
      const bundleEntry = dump.result.find((r: { url: string }) => r.url.endsWith('/cli/dist/index.js'));
      expect(bundleEntry).toBeDefined();
      // Precise block coverage: some functions were never entered.
      const zeroFns = bundleEntry.functions.filter((f: { ranges: { count: number }[] }) =>
        f.ranges.some((r) => r.count === 0),
      );
      expect(zeroFns.length).toBeGreaterThan(0);

      // 2. The real c8, with the repo's config, maps the dump onto cli/**/*.ts.
      const c8 = spawnSync(
        process.execPath,
        [
          resolveC8Bin(), 'report',
          '--config', join(REPO_ROOT, '.c8rc.json'),
          '--temp-directory', dumpDir,
          '--reports-dir', reportDir,
          '--reporter', 'lcov',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
      );
      expect(c8.status).toBe(0);
      const lcovPath = join(reportDir, 'lcov.info');
      expect(existsSync(lcovPath)).toBe(true);
      const lcov = parseLcov(readFileSync(lcovPath, 'utf8'));

      // 3. Scope: cli/** only.
      const files = [...lcov.keys()];
      expect(files.length).toBeGreaterThan(10);
      expect(files.every((f) => f.startsWith('cli/'))).toBe(true);
      expect(files.some((f) => f.startsWith('cli/dist/'))).toBe(false);

      // 4. Not fake: serverLifecycle.ts is loaded (module-level lines hit) but
      //    `list connectors` never kills a server → killServerOnPort has 0 hits
      //    and the file is strictly below 100%.
      const lifecycle = lcov.get('cli/utils/serverLifecycle.ts');
      expect(lifecycle).toBeDefined();
      expect(lifecycle!.fnHits.get('killServerOnPort')).toBe(0);
      const lifecycleLines = [...lifecycle!.da.values()];
      const lifecycleHit = lifecycleLines.filter((h) => h > 0).length;
      expect(lifecycleHit).toBeGreaterThan(0);
      expect(lifecycleHit).toBeLessThan(lifecycleLines.length);

      // 5. Not all-zero either: the list command's module ran.
      const list = lcov.get('cli/commands/list.ts');
      expect(list).toBeDefined();
      expect([...list!.fnHits.values()].some((h) => h > 0)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
