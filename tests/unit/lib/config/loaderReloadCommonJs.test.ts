/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #655: `loadConfig(cwd, force)` must re-evaluate an edited config that Node
 * loads as a **CommonJS** module (project `"type": "commonjs"`), not only an
 * ES module. Node's CommonJS cache is keyed by filename, so the
 * `?reload=<hash>` re-import returned the module imported first.
 *
 * Real Node module semantics are the claim here, so every scenario runs the
 * real loader in a separate `node --import tsx` process
 * (tests/helpers/configReloadProbe.ts): Jest swaps `module.createRequire`,
 * `require.cache` and dynamic `import()` for its own registry — in-process the
 * bug cannot be reproduced and the fix cannot be observed (same reason as
 * tests/unit/lib/testCases/loader.mjsReload.test.ts). Fixtures are real files
 * in a temp dir; the config appends one byte to `import-count.log` per
 * evaluation so "unchanged file ⇒ cached module" is pinned too.
 *
 * Red on main: CommonJS scenario → the names never change after the edit;
 * `evictLocalCjsModules` does not exist.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadConfig, clearConfigCache } from '@/lib/config/loader';

const REPO_ROOT = process.cwd();
const PROBE = join(REPO_ROOT, 'tests', 'helpers', 'configReloadProbe.ts');
const TSX = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function probe<T>(mode: 'load-config' | 'load-config-broken' | 'evict', ...args: string[]): T {
  const proc = spawnSync(process.execPath, ['--import', TSX, PROBE, mode, ...args], {
    cwd: REPO_ROOT, // tsx reads the repo tsconfig here (the `@/` alias)
    encoding: 'utf-8',
    env: { ...process.env, AH_SUPPRESS_EXPERIMENTAL: '1', NO_COLOR: '1' },
    timeout: 60_000,
  });
  if (proc.status !== 0) {
    throw new Error(`probe ${mode} failed (status ${proc.status}):\nSTDOUT:\n${proc.stdout}\nSTDERR:\n${proc.stderr}`);
  }
  return JSON.parse(proc.stdout) as T;
}

type Snapshot = { names: string[]; evaluations: number };

const AGENT = (key: string, name: string) =>
  `{ key: ${JSON.stringify(key)}, name: ${name}, connectorType: 'rest', endpoint: 'http://127.0.0.1:1/ask' }`;

/** CommonJS project (`"type": "commonjs"`): `agent-health.config.js` requiring a sibling `agents.js`. */
function cjsConfig(dir: string, edited: boolean): string {
  return `const { appendFileSync } = require('fs');
const { demoAgentName } = require('./agents');
appendFileSync(${JSON.stringify(join(dir, 'import-count.log'))}, 'x');
module.exports = { agents: [
  ${AGENT('fixture-demo', edited ? "demoAgentName + ' (edited)'" : 'demoAgentName')},${edited ? `
  ${AGENT('fixture-second', "'Second Agent'")},` : ''}
] };
`;
}
const cjsSibling = (version: string) => `module.exports = { demoAgentName: 'Demo Agent ${version}' };\n`;

/** ES-module project: `agent-health.config.mjs`. */
function esmConfig(dir: string, edited: boolean): string {
  return `import { appendFileSync } from 'fs';
appendFileSync(${JSON.stringify(join(dir, 'import-count.log'))}, 'x');
export default { agents: [
  ${AGENT('fixture-demo', edited ? "'Demo Agent (edited)'" : "'Demo Agent'")},${edited ? `
  ${AGENT('fixture-second', "'Second Agent'")},` : ''}
] };
`;
}

describe('loadConfig(cwd, force) re-evaluates an edited config without a restart (#655)', () => {
  it('CommonJS project: the edited config AND the sibling it requires are re-evaluated; an unchanged file stays cached', () => {
    const dir = tempDir('ah-cfg-reload-cjs-');
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(join(dir, 'agents.js'), cjsSibling('v1'));
    writeFileSync(join(dir, 'agent-health.config.js'), cjsConfig(dir, false));
    writeFileSync(join(dir, 'agents.js.next'), cjsSibling('v2'));
    writeFileSync(join(dir, 'agent-health.config.js.next'), cjsConfig(dir, true));

    expect(probe<Snapshot[]>('load-config', dir)).toEqual([
      { names: ['Demo Agent v1'], evaluations: 1 },               // boot
      { names: ['Demo Agent v1'], evaluations: 1 },               // per-run reload, unchanged → cached
      { names: ['Demo Agent v1'], evaluations: 1 },
      { names: ['Demo Agent v2 (edited)', 'Second Agent'], evaluations: 2 }, // edited → both files re-evaluated
      { names: ['Demo Agent v2 (edited)', 'Second Agent'], evaluations: 2 }, // unchanged → cached
    ]);
  });

  it('CommonJS project: a config that throws at import, then repaired together with its sibling, loads the repaired sibling (not the one cached by the failed import)', () => {
    const dir = tempDir('ah-cfg-reload-broken-');
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(join(dir, 'agents.js'), cjsSibling('v1'));
    writeFileSync(join(dir, 'agent-health.config.js'), cjsConfig(dir, false));
    // Stage 1: the config requires the (edited) sibling, then throws.
    writeFileSync(join(dir, 'agents.js.next'), cjsSibling('v2'));
    writeFileSync(join(dir, 'agent-health.config.js.next'), cjsConfig(dir, false).replace('module.exports =', "throw new Error('half-edited config');\nmodule.exports ="));
    // Stage 2: repaired config, sibling edited again.
    writeFileSync(join(dir, 'agents.js.next2'), cjsSibling('v3'));
    writeFileSync(join(dir, 'agent-health.config.js.next2'), cjsConfig(dir, true));

    const [boot, broken, repaired] = probe<Array<Snapshot | { error: string }>>('load-config-broken', dir);
    expect(boot).toEqual({ names: ['Demo Agent v1'], evaluations: 1 });
    expect(broken).toEqual({ error: expect.stringContaining('half-edited config') });
    // Red without the failed-import bookkeeping: 'Demo Agent v2 (edited)' — the
    // sibling the failed import left in require.cache.
    expect(repaired).toEqual({ names: ['Demo Agent v3 (edited)', 'Second Agent'], evaluations: 3 });
  });

  it('ES-module project: the edited config is re-evaluated; an unchanged file stays cached (no regression)', () => {
    const dir = tempDir('ah-cfg-reload-esm-');
    writeFileSync(join(dir, 'agent-health.config.mjs'), esmConfig(dir, false));
    writeFileSync(join(dir, 'agent-health.config.mjs.next'), esmConfig(dir, true));

    expect(probe<Snapshot[]>('load-config', dir)).toEqual([
      { names: ['Demo Agent'], evaluations: 1 },
      { names: ['Demo Agent'], evaluations: 1 },
      { names: ['Demo Agent'], evaluations: 1 },
      { names: ['Demo Agent (edited)', 'Second Agent'], evaluations: 2 },
      { names: ['Demo Agent (edited)', 'Second Agent'], evaluations: 2 },
    ]);
  });
});

describe('evictLocalCjsModules', () => {
  it('evicts the entry and its local children (transitively), never node_modules or modules outside the project', () => {
    const base = tempDir('ah-evict-');
    const project = join(base, 'project');
    mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(project, 'lib'));
    writeFileSync(join(base, 'shared.js'), "module.exports = { shared: 'shared-v1' };");
    writeFileSync(join(project, 'node_modules', 'dep', 'index.js'), "module.exports = { dep: 'dep-v1' };");
    writeFileSync(join(project, 'lib', 'agents.js'), "module.exports = { agents: 'agents-v1', helper: require('./helper') };");
    writeFileSync(join(project, 'lib', 'helper.js'), "module.exports = 'helper-v1';");
    writeFileSync(join(project, 'config.js'), "module.exports = { ...require('./lib/agents'), ...require('dep'), ...require('../shared') };");
    // Staged edit: every file changes on disk.
    writeFileSync(join(base, 'shared.js.next'), "module.exports = { shared: 'shared-v2' };");
    writeFileSync(join(project, 'node_modules', 'dep', 'index.js.next'), "module.exports = { dep: 'dep-v2' };");
    writeFileSync(join(project, 'lib', 'agents.js.next'), "module.exports = { agents: 'agents-v2', helper: require('./helper') };");
    writeFileSync(join(project, 'lib', 'helper.js.next'), "module.exports = 'helper-v2';");

    const result = probe<{ before: any; stale: any; evicted: string[]; stillCached: string[]; after: any; noop: string[] }>(
      'evict', join(project, 'config.js'), base);

    expect(result.before).toEqual({ agents: 'agents-v1', helper: 'helper-v1', dep: 'dep-v1', shared: 'shared-v1' });
    // Without eviction Node serves the cached graph.
    expect(result.stale).toEqual(result.before);
    expect(result.evicted).toEqual([join(project, 'config.js'), join(project, 'lib', 'agents.js'), join(project, 'lib', 'helper.js')].sort());
    expect(result.stillCached).toEqual([join(base, 'shared.js'), join(project, 'node_modules', 'dep', 'index.js')].sort());
    // Local modules re-evaluate; the dependency and the module outside the
    // project keep their (possibly stateful) instance although both changed on disk.
    expect(result.after).toEqual({ agents: 'agents-v2', helper: 'helper-v2', dep: 'dep-v1', shared: 'shared-v1' });
    expect(result.noop).toEqual([]);
  });

  it('terminates on a require cycle and is a no-op for a module Node never loaded as CommonJS', () => {
    const dir = tempDir('ah-evict-cycle-');
    writeFileSync(join(dir, 'config.js'), "exports.name = 'a'; require('./b');");
    writeFileSync(join(dir, 'b.js'), "exports.name = 'b'; require('./config');");
    const result = probe<{ evicted: string[]; stillCached: string[]; noop: string[] }>('evict', join(dir, 'config.js'), dir);
    expect(result.evicted).toEqual([join(dir, 'b.js'), join(dir, 'config.js')].sort());
    expect(result.stillCached).toEqual([]);
    expect(result.noop).toEqual([]);
  });
});

describe('loadConfig(cwd, force) evicts the CommonJS cache once per edit, not once per run (in-process)', () => {
  // Jest's module registry stands in for Node's cache here, so what is
  // observable in-process is the gating: the eviction (announced by one
  // `[Config] Re-evaluating …` line) happens only when the content hash changed.
  const serverFlag = process.env.AGENT_HEALTH_SERVER;
  beforeAll(() => { process.env.AGENT_HEALTH_SERVER = '1'; }); // startup diagnostics always print for the server
  afterAll(() => {
    if (serverFlag === undefined) delete process.env.AGENT_HEALTH_SERVER; else process.env.AGENT_HEALTH_SERVER = serverFlag;
  });
  afterEach(() => { clearConfigCache(); jest.restoreAllMocks(); });

  it('forced loads of an unchanged file evict nothing; an edit evicts once; clearConfigCache() forgets the digest', async () => {
    const dir = tempDir('ah-cfg-gating-');
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(join(dir, 'agent-health.config.js'), "module.exports = { agents: [] };");
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const evictions = () => log.mock.calls.filter(c => String(c[0]).includes('Re-evaluating') && String(c[0]).includes('CommonJS')).length;

    await loadConfig(dir);
    await loadConfig(dir, true);
    await loadConfig(dir, true);
    expect(evictions()).toBe(0);

    writeFileSync(join(dir, 'agent-health.config.js'), "module.exports = { agents: [], models: [] };");
    await loadConfig(dir, true);
    await loadConfig(dir, true);
    expect(evictions()).toBe(1);

    clearConfigCache();
    await loadConfig(dir, true);
    expect(evictions()).toBe(2);
  });
});
