/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real `bin/cli.js`, real child processes: the Node.js version guard.
 *
 * `engines.node` only makes npm WARN, so before this guard the CLI started on
 * an end-of-life Node 20 (CVE-2026-111497) and then died somewhere deep inside
 * (`Unknown file extension ".ts"` while loading agent-health.config.ts). The
 * shim must now refuse with one explained message BEFORE it loads anything
 * else, and keep working on supported versions.
 *
 * Three real-process angles, all through the staged production package (bin/
 * cli.js takes the dist path when it lives under node_modules):
 *   1. the Node running this suite (always in range, see package.json) → runs;
 *   2. the same binary with `process.versions.node` redefined by a `--require`
 *      preload (test-side only; the shim reads process.versions.node exactly as
 *      in production) → refuses, exit 1, nothing else loads, `serve` included;
 *   3. a REAL older Node binary when one is installed on the machine
 *      (`AH_TEST_LEGACY_NODE_BIN`, or auto-discovered under mise / nvm) →
 *      refuses. Skipped with a logged reason when none runs here (CI images
 *      only ship the matrix version).
 *
 * Build first: npm run build:all
 */
import { spawn, spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../../bin/nodeVersionGuard.cjs') as {
  readEnginesRange: (packageJsonPath: string) => string;
  satisfiesRange: (version: string, range: string) => boolean;
};

const ROOT = join(__dirname, '../../..');
const FAKE_VERSION_PRELOAD = join(__dirname, 'fixtures/fakeNodeVersion.cjs');
const TEST_TIMEOUT = 120_000;

interface Staged { project: string; cli: string }

function stagePackage(): Staged {
  for (const file of ['bin/cli.js', 'bin/nodeVersionGuard.cjs', 'cli/dist/index.js']) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Missing ${file}; run npm run build:all first`);
  }
  const scratchRoot = join(ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(join(scratchRoot, 'node-version-guard-'));
  const packageDir = join(project, 'node_modules/@opensearch-project/agent-health');
  mkdirSync(packageDir, { recursive: true });
  for (const file of ['package.json', 'bin', 'cli/dist']) {
    cpSync(join(ROOT, file), join(packageDir, file), { recursive: true });
  }
  return { project, cli: join(packageDir, 'bin/cli.js') };
}

interface CliResult { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function runCli(
  execPath: string,
  nodeArgs: string[],
  cli: string,
  cliArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, [...nodeArgs, cli, ...cliArgs], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI ${cliArgs.join(' ')} did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

/** A clean env: no AH_* leaking from the runner, a scratch HOME-independent cwd. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR' || key === 'NODE_OPTIONS') env[key] = value;
  }
  return { ...env, NO_COLOR: '1', ...extra };
}

/**
 * Find a REAL Node binary outside the engines range that actually executes on
 * this machine. Explicit `AH_TEST_LEGACY_NODE_BIN` wins; otherwise probe the
 * usual version-manager install roots. Returns undefined when nothing usable
 * exists (the common case on CI).
 */
function findLegacyNode(range: string): { bin: string; version: string } | undefined {
  const candidates: string[] = [];
  if (process.env.AH_TEST_LEGACY_NODE_BIN) candidates.push(process.env.AH_TEST_LEGACY_NODE_BIN);
  const roots = [
    join(homedir(), '.local/share/mise/installs/node'),
    join(homedir(), '.nvm/versions/node'),
    join(homedir(), '.fnm/node-versions'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // mise aliases like "20" → "20.10.0"
      for (const rel of ['bin/node', 'installation/bin/node']) {
        const bin = join(root, entry.name, rel);
        if (existsSync(bin)) candidates.push(bin);
      }
    }
  }
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 10_000 });
    if (probe.status !== 0) continue; // e.g. built against a newer glibc than this host has
    const version = probe.stdout.trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(version)) continue;
    if (!guard.satisfiesRange(version, range)) return { bin, version };
  }
  return undefined;
}

describe('bin/cli.js Node.js version guard (real processes)', () => {
  const range = guard.readEnginesRange(join(ROOT, 'package.json'));
  let staged: Staged;

  beforeAll(() => {
    staged = stagePackage();
  });

  afterAll(() => {
    if (staged) rmSync(staged.project, { recursive: true, force: true });
  });

  it('runs normally on the Node this suite runs on', async () => {
    expect(guard.satisfiesRange(process.versions.node, range)).toBe(true);
    const result = await runCli(process.execPath, [], staged.cli, ['--version'], staged.project, cleanEnv(), TEST_TIMEOUT);
    expect(result.stderr).not.toContain('unsupported Node.js version');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, TEST_TIMEOUT);

  describe('with process.versions.node redefined to an out-of-range release (same binary)', () => {
    it.each(['20.19.0', '22.23.3'])('`--version` on %s: exit 1, message on stderr, nothing on stdout', async (fake) => {
      const result = await runCli(
        process.execPath,
        ['--require', FAKE_VERSION_PRELOAD],
        staged.cli,
        ['--version'],
        staged.project,
        cleanEnv({ AH_TEST_FAKE_NODE_VERSION: fake }),
        TEST_TIMEOUT
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`agent-health: unsupported Node.js version v${fake}.`);
      expect(result.stderr).toContain(`engines.node: "${range}"`);
      expect(result.stderr).toContain('CVE-2026-111497');
      expect(result.stderr).toContain('agent-health.config.ts');
      expect(result.stderr).toContain('nvm install 24');
      // The message is the ONLY thing printed: the bundle was never loaded, so
      // no stack trace / Node error banner follows it.
      expect(result.stderr).not.toMatch(/at .*cli\/dist\/index\.js/);
      expect(result.stderr).not.toMatch(/^Node\.js v/m);
      expect(result.stderr).not.toMatch(/Error: Unknown file extension/);
      expect(result.stderr.trimEnd().endsWith('https://nodejs.org/')).toBe(true);
    }, TEST_TIMEOUT);

    it('`serve` goes through the same guard — no server is started', async () => {
      const port = 5623;
      const result = await runCli(
        process.execPath,
        ['--require', FAKE_VERSION_PRELOAD],
        staged.cli,
        ['serve', '--port', String(port)],
        staged.project,
        cleanEnv({ AH_TEST_FAKE_NODE_VERSION: '20.19.0', AH_PORT: String(port), PORT: String(port) }),
        TEST_TIMEOUT
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unsupported Node.js version v20.19.0');
      expect(result.stdout).toBe('');
      await expect(
        fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })
      ).rejects.toBeTruthy();
    }, TEST_TIMEOUT);

    it('a redefined IN-range version still runs (the preload itself is not what refuses)', async () => {
      const result = await runCli(
        process.execPath,
        ['--require', FAKE_VERSION_PRELOAD],
        staged.cli,
        ['--version'],
        staged.project,
        cleanEnv({ AH_TEST_FAKE_NODE_VERSION: '26.12.1' }),
        TEST_TIMEOUT
      );
      expect(result.stderr).not.toContain('unsupported Node.js version');
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }, TEST_TIMEOUT);
  });

  describe('with a REAL older Node binary', () => {
    const legacy = findLegacyNode(range);
    const maybe = legacy ? it : it.skip;
    if (!legacy) {
      // eslint-disable-next-line no-console
      console.log('[node-version-guard] no runnable out-of-range Node binary found; set AH_TEST_LEGACY_NODE_BIN to enable');
    }

    maybe(`refuses on ${legacy?.version ?? 'n/a'} (${legacy?.bin ?? 'n/a'})`, async () => {
      const result = await runCli(legacy!.bin, [], staged.cli, ['--version'], staged.project, cleanEnv(), TEST_TIMEOUT);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`agent-health: unsupported Node.js version v${legacy!.version}.`);
      expect(result.stderr).toContain('CVE-2026-111497');
      expect(result.stderr).not.toMatch(/^Node\.js v/m);
      expect(result.stderr).not.toMatch(/Error: Unknown file extension/);
    }, TEST_TIMEOUT);
  });
});
