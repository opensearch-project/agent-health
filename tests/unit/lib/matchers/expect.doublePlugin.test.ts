/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for #621: a failing `expect.soft(...)` was recorded as
 * `pass: true` whenever TWO compiled copies of the recording plugin wrapped
 * the SAME chai instance.
 *
 * How that happens in a real run: the runner is an esbuild bundle
 * (`server/dist` / `cli/dist`, chai external) with its own copy of
 * `lib/matchers/expect.ts` + `session.ts`, and the process ALSO imports the
 * package entry (`lib/dist/lib/index.js`) — `agent-health.config.ts` does
 * `import { defineConfig } from '@opensearch-project/agent-health'`, and so
 * does any `.eval.mjs` file. Both copies resolve the same `chai`, so both
 * wrapped `Assertion.prototype.assert`. On a failing soft assertion the
 * inner wrapper recorded `pass: false` into a session nobody reads and
 * RETURNED (soft), so the outer wrapper — the runner's — saw a normal return
 * and recorded `pass: true`.
 *
 * The fix: the wrapper records chai's own verdict (`negate ? !expr : expr`)
 * instead of inferring it from whether `assert()` threw, so the runner's
 * (outer) copy is correct no matter what sits beneath it — including an
 * OLDER package copy that still swallows soft failures.
 *
 * Two layers of test:
 *  1. In-process: an "older copy" stand-in wrapper that swallows soft
 *     failures is installed beneath ours on the jest chai shim.
 *  2. Real `node` subprocess reproducing the exact layering (jest's module
 *     registry maps `chai` to a CJS shim and cannot hold two ESM copies):
 *     the package entry is imported first through a symlinked
 *     `node_modules/@opensearch-project/agent-health` the way a config/eval
 *     file resolves it, then a bundle built from the TS sources with the
 *     same esbuild settings as `npm run build:server` stands in for the
 *     runner. Needs `lib/dist` built (`npm run build:lib`).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = process.cwd();
const PACKAGE_ENTRY = join(REPO_ROOT, 'lib/dist/lib/index.js');

function makeProjectDir(): string {
  // Scratch dir INSIDE the repo (gitignored), so the stand-in runner bundle
  // resolves its external `chai` by walking up to the repo's node_modules —
  // the same physical chai the package entry resolves, as in a real install.
  const scratchRoot = join(REPO_ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  const projectDir = mkdtempSync(join(scratchRoot, 'expect-double-plugin-'));
  const scopeDir = join(projectDir, 'node_modules', '@opensearch-project');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(REPO_ROOT, join(scopeDir, 'agent-health'), 'dir');
  // Entry for the stand-in runner bundle: one esbuild bundle holding its OWN
  // copy of expect.ts + session.ts (chai stays external, exactly like
  // server/dist and cli/dist).
  writeFileSync(
    join(projectDir, 'runner-entry.ts'),
    `export { expect } from ${JSON.stringify(join(REPO_ROOT, 'lib/matchers/expect.ts'))};\n` +
      `export { runInSession } from ${JSON.stringify(join(REPO_ROOT, 'lib/matchers/session.ts'))};\n`
  );
  return projectDir;
}

function runInSubprocess(projectDir: string, script: string): string {
  const scriptPath = join(projectDir, 'repro.mjs');
  writeFileSync(scriptPath, script);
  const proc = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8', cwd: projectDir, timeout: 60_000 });
  if (proc.status !== 0) {
    throw new Error(`Subprocess failed (status ${proc.status}):\nSTDOUT:\n${proc.stdout}\nSTDERR:\n${proc.stderr}`);
  }
  return proc.stdout || '';
}

describe('expect.soft beneath a second wrapper that swallows soft failures (#621, in-process)', () => {
  // Stand-in for the OTHER compiled copy of the plugin, installed first (so
  // it sits beneath ours): records nothing we can see, swallows the error
  // when the assertion is soft — exactly what the pre-fix wrapper did.
  function loadWithInnerSwallowingWrapper() {
    let mod: typeof import('@/lib/matchers/expect') & typeof import('@/lib/matchers/session');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const chai = require('chai');
      const inner = chai.Assertion.prototype.assert;
      chai.Assertion.prototype.assert = function (this: any, ...args: unknown[]) {
        try {
          return inner.apply(this, args);
        } catch (err) {
          if (chai.util.flag(this, 'ahSoft')) return;
          throw err;
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = { ...require('@/lib/matchers/expect'), ...require('@/lib/matchers/session') };
    });
    return mod!;
  }

  it('records pass: false with a chai-style errorMessage even though nothing reached our catch', async () => {
    const { expect: ahExpect, runInSession } = loadWithInnerSwallowingWrapper();
    const { results } = await runInSession(async () => {
      ahExpect.soft([], 'want X').to.include('X');
      ahExpect.soft(false).to.equal(true);
      ahExpect.soft(1, 'must differ').to.not.equal(1);
      ahExpect.soft(['X']).to.include('X');
    });
    expect(results.map(r => r.pass)).toEqual([false, false, false, true]);
    expect(results[0].description).toBe("[] to include 'X'");
    // The rebuilt message is chai's own: custom message, negation, placeholders.
    expect(results[0].errorMessage).toBe("want X: expected [] to include 'X'");
    expect(results[1].errorMessage).toBe('expected false to equal true');
    expect(results[2].errorMessage).toBe('must differ: expected 1 to not equal 1');
    expect(results[3].errorMessage).toBeUndefined();
  });

  it('a hard expect still throws and records pass: false', async () => {
    const { expect: ahExpect, runInSession } = loadWithInnerSwallowingWrapper();
    const { results, error } = await runInSession(async () => {
      ahExpect([], 'want X').to.include('X');
    });
    expect(error).toBeInstanceOf(Error);
    expect(results.map(r => r.pass)).toEqual([false]);
    expect((error as Error).message).toContain('want X');
  });
});

describe('expect.soft with two compiled copies of the recording plugin on one chai (#621, real node)', () => {
  let projectDir: string;

  beforeAll(() => {
    if (!existsSync(PACKAGE_ENTRY)) {
      throw new Error(`Missing ${PACKAGE_ENTRY}; run npm run build:lib first`);
    }
    projectDir = makeProjectDir();
  });

  afterAll(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it('a failing expect.soft records pass: false (once) when the package entry was imported before the runner bundle', () => {
    const out = runInSubprocess(
      projectDir,
      `
        import { createRequire } from 'module';
        const { build } = createRequire(${JSON.stringify(join(REPO_ROOT, 'package.json'))})('esbuild');
        // 1. What agent-health.config.ts / an .eval.mjs file does: import the
        //    package entry through node_modules. Installs the first plugin copy.
        const pkg = await import('@opensearch-project/agent-health');
        if (typeof pkg.expect !== 'function') throw new Error('package entry did not export expect');

        // 2. The runner: a separate esbuild bundle of the same sources, chai
        //    external (same flags as build:server). Installs the second copy.
        await build({
          entryPoints: ['./runner-entry.ts'], bundle: true, platform: 'node', format: 'esm',
          packages: 'external', outfile: './runner-bundle.mjs', logLevel: 'silent',
        });
        const runner = await import('./runner-bundle.mjs');

        const results = {};
        results.softFail = (await runner.runInSession(async () => {
          runner.expect.soft([], 'want X').to.include('X');
        })).results;
        results.softFailEqual = (await runner.runInSession(async () => {
          runner.expect.soft(false, 'want hit').to.equal(true);
        })).results;
        results.softPass = (await runner.runInSession(async () => {
          runner.expect.soft(['X']).to.include('X');
        })).results;
        results.hardFail = (await runner.runInSession(async () => {
          try { runner.expect([], 'want X').to.include('X'); } catch {}
        })).results;
        // The eval file's own expect (from the package entry) must record
        // into the runner's session too — it is the same chai.
        results.packageExpectSoftFail = (await runner.runInSession(async () => {
          pkg.expect.soft([], 'want X').to.include('X');
        })).results;
        console.log(JSON.stringify(results));
      `
    );
    const results = JSON.parse(out.trim().split('\n').pop()!) as Record<string, Array<{ pass: boolean; description: string; errorMessage?: string }>>;

    // The bug: these two came back as [{ pass: true }].
    expect(results.softFail.map(r => r.pass)).toEqual([false]);
    expect(results.softFail[0].errorMessage).toContain('want X');
    expect(results.softFailEqual.map(r => r.pass)).toEqual([false]);
    expect(results.packageExpectSoftFail.map(r => r.pass)).toEqual([false]);

    // Unchanged behaviour, and exactly ONE record per assertion in the
    // runner's session (the inner copy records into its own store).
    expect(results.softPass.map(r => r.pass)).toEqual([true]);
    expect(results.hardFail.map(r => r.pass)).toEqual([false]);
  });
});
