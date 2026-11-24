/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Probe for tests/unit/lib/config/loaderReloadCommonJs.test.ts — runs the REAL
 * `lib/config/loader.ts` in a real Node process (spawned with `--import tsx`),
 * because Jest replaces `module.createRequire` / `require.cache` and dynamic
 * `import()` with its own registry, which has none of the Node caching the
 * test is about (#655).
 *
 *   node --import tsx tests/helpers/configReloadProbe.ts load-config <projectDir>
 *     loadConfig(dir) · loadConfig(dir, true) ×2 · apply the staged edit ·
 *     loadConfig(dir, true) ×2; prints one JSON array of
 *     `{ names, evaluations }` (fixture agents' names, `import-count.log` length).
 *
 *   node --import tsx tests/helpers/configReloadProbe.ts load-config-broken <projectDir>
 *     loadConfig(dir) · apply the staged edit (`.next`: a config that throws)
 *     · loadConfig(dir, true) → `{ error }` · apply the second staged edit
 *     (`.next2`: repaired) · loadConfig(dir, true); prints the JSON array.
 *
 *   node --import tsx tests/helpers/configReloadProbe.ts evict <entryFile> <stageRoot>
 *     require(entryFile) · apply the staged edit · require again (stale) ·
 *     evictLocalCjsModules(entryFile) · require again; prints JSON
 *     `{ before, stale, evicted, stillCached, after, noop }` (`stillCached`:
 *     cache keys under stageRoot after eviction; `noop`: eviction of a file
 *     under stageRoot that was never loaded).
 *
 * "Apply the staged edit" renames every `<file>.next` (`.next2` for the second
 * stage) under the directory (recursively) over `<file>`, so the test controls
 * every version.
 */

import { readdirSync, renameSync, existsSync, readFileSync, statSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

import { loadConfig, evictLocalCjsModules } from '@/lib/config/loader';

const [mode, dir, stageRoot] = process.argv.slice(2);
if (!mode || !dir || (mode === 'evict' && !stageRoot)) {
  process.stderr.write('usage: configReloadProbe.ts load-config|load-config-broken <projectDir> | evict <entryFile> <stageRoot>\n');
  process.exit(2);
}

function applyStagedEdit(root: string, suffix = '.next'): void {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) applyStagedEdit(full, suffix);
    else if (name.endsWith(suffix)) renameSync(full, full.slice(0, -suffix.length));
  }
}

type Snapshot = { names: string[]; evaluations: number } | { error: string };
const out: Snapshot[] = [];
const evaluations = () => {
  const log = join(dir, 'import-count.log');
  return existsSync(log) ? readFileSync(log, 'utf-8').length : 0;
};
const snapshot = async (force: boolean) => {
  try {
    const config = await loadConfig(dir, force);
    out.push({ names: config.agents.filter(a => a.key.startsWith('fixture-')).map(a => a.name), evaluations: evaluations() });
  } catch (err) {
    out.push({ error: (err as Error).message });
  }
};

if (mode === 'load-config') {
  await snapshot(false);
  await snapshot(true);
  await snapshot(true);
  applyStagedEdit(dir);
  await snapshot(true);
  await snapshot(true);
  process.stdout.write(JSON.stringify(out));
} else if (mode === 'load-config-broken') {
  await snapshot(false);
  applyStagedEdit(dir, '.next');
  await snapshot(true);
  applyStagedEdit(dir, '.next2');
  await snapshot(true);
  process.stdout.write(JSON.stringify(out));
} else if (mode === 'evict') {
  const entry = dir;
  const req = createRequire(entry);
  const before = req(entry);
  applyStagedEdit(stageRoot);
  const stale = req(entry);
  const evicted = evictLocalCjsModules(entry).sort();
  const stillCached = Object.keys(req.cache).filter(k => k.startsWith(stageRoot)).sort();
  const after = req(entry);
  const noop = evictLocalCjsModules(join(stageRoot, 'never-loaded.js'));
  process.stdout.write(JSON.stringify({ before, stale, evicted, stillCached, after, noop }));
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
