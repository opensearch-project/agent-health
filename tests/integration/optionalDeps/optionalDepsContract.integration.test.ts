/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contract tests for the two ESM-only optionalDependencies, run against the
 * REAL installed packages (no jest.mock virtual modules).
 *
 * Why this exists: the unit suites for the trace judge / comparison deep-dive
 * and the PDF formatter mock the optional packages, so they keep passing even
 * when the real SDK surface drifts. That is exactly what happened with pi
 * 0.80.8 (removed `AuthStorage` + the `authStorage`/`modelRegistry` session
 * options — inside our old `^0.80.2` range) and with pi 0.85.0 (a publish whose
 * entry point imports an undeclared package and throws at `import()`).
 *
 * Both packages are ESM-only, and Jest here runs a CJS/ts-jest transform, so
 * each probe is a tiny ESM script executed in a child `node` process — the
 * same runtime (and the same `createRequire` path the PDF formatter uses) as
 * production. No network: the pi probe asks `ModelRuntime` not to refresh
 * catalogs, and never prompts a model; the puppeteer probe never launches a
 * browser.
 *
 * Skipped (not failed) when a package is genuinely not installed, since both
 * are optional — `npm ci --no-optional`, or a platform where puppeteer's
 * Chrome download failed, must not turn this red.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Presence check by directory, not `require.resolve(pkg + '/package.json')`:
 * pi's `exports` map does not expose `./package.json`, so a resolve-based check
 * reports ERR_PACKAGE_PATH_NOT_EXPORTED (a false "not installed").
 */
function isInstalled(pkg: string): boolean {
  return existsSync(path.join(REPO_ROOT, 'node_modules', ...pkg.split('/'), 'package.json'));
}

/** Run an ESM snippet in a fresh node process from the repo root; returns parsed JSON stdout. */
function runEsmProbe(source: string): { ok: true; result: any } | { ok: false; stderr: string } {
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' },
  });
  if (proc.status !== 0) return { ok: false, stderr: `${proc.stderr}\n${proc.stdout}`.trim() };
  const lastLine = proc.stdout.trim().split('\n').pop() ?? '';
  return { ok: true, result: JSON.parse(lastLine) };
}

const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

describeIf(isInstalled('@earendil-works/pi-coding-agent'))(
  '@earendil-works/pi-coding-agent — SDK surface used by the trace judge & comparison deep-dive',
  () => {
    it(
      'imports, exposes ModelRuntime/createAgentSession/SessionManager/DefaultResourceLoader/getAgentDir, ' +
        'and createAgentSession({ modelRuntime, tools }) enables exactly the scoped tools',
      () => {
        const out = runEsmProbe(`
          const sdk = await import('@earendil-works/pi-coding-agent');
          const surface = Object.fromEntries(
            ['createAgentSession', 'SessionManager', 'ModelRuntime', 'DefaultResourceLoader', 'getAgentDir']
              .map((k) => [k, typeof sdk[k]])
          );
          // Static catalog only — no network, no auth prompts.
          const modelRuntime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
          const models = modelRuntime.getModels();
          const model = models[0];
          const resourceLoader = new sdk.DefaultResourceLoader({
            cwd: process.cwd(),
            agentDir: sdk.getAgentDir(),
            systemPromptOverride: () => 'contract probe',
            appendSystemPromptOverride: () => [],
            extensionFactories: [
              (pi) => {
                pi.registerTool({
                  name: 'query_spans', label: 'query_spans', description: 'probe',
                  parameters: { type: 'object', properties: {} },
                  execute: async () => ({ content: [{ type: 'text', text: '[]' }], details: {} }),
                });
                pi.registerTool({
                  name: 'query_logs', label: 'query_logs', description: 'probe',
                  parameters: { type: 'object', properties: {} },
                  execute: async () => ({ content: [{ type: 'text', text: '[]' }], details: {} }),
                });
              },
            ],
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          });
          await resourceLoader.reload();
          const { session } = await sdk.createAgentSession({
            model,
            modelRuntime,
            resourceLoader,
            tools: ['query_spans', 'query_logs'],
            sessionManager: sdk.SessionManager.inMemory(),
          });
          const enabledTools = (session.agent?.state?.tools ?? []).map((t) => t.name).sort();
          const shape = { prompt: typeof session.prompt, messages: Array.isArray(session.messages) };
          session.dispose?.();
          console.log(JSON.stringify({
            surface,
            hasModelWithProviderAndId: !!model && typeof model.provider === 'string' && typeof model.id === 'string',
            modelCount: models.length,
            enabledTools,
            shape,
          }));
          process.exit(0);
        `);
        if (!out.ok) throw new Error(`pi SDK probe failed:\n${out.stderr}`);
        const r = out.result;
        expect(r.surface).toEqual({
          createAgentSession: 'function',
          SessionManager: 'function',
          ModelRuntime: 'function',
          DefaultResourceLoader: 'function',
          getAgentDir: 'function',
        });
        expect(r.hasModelWithProviderAndId).toBe(true);
        expect(r.modelCount).toBeGreaterThan(0);
        // The core scoping guarantee of the trace judge: built-ins (read/bash/
        // edit/write/...) are OFF, only the run-scoped trace tools are on.
        expect(r.enabledTools).toEqual(['query_logs', 'query_spans']);
        expect(r.shape).toEqual({ prompt: 'function', messages: true });
      },
      90_000
    );
  }
);

describeIf(isInstalled('puppeteer'))('puppeteer — loadable the way PdfFormatter loads it (createRequire on an ESM-only package)', () => {
  it('createRequire(...)("puppeteer") returns a namespace with launch()', () => {
    // Mirrors services/report/pdf/esmRequire.ts + PdfFormatter.loadPuppeteer():
    // in the ESM server bundle `require` is unavailable, so the formatter falls
    // back to createRequire(import.meta.url)('puppeteer'). Since puppeteer 25 is
    // ESM-only this relies on Node's require(esm); if a future puppeteer adds
    // top-level await this probe fails (ERR_REQUIRE_ASYNC_MODULE) — which is
    // exactly the signal we want before a release, not in a user's PDF export.
    const out = runEsmProbe(`
      import { createRequire } from 'module';
      const esmRequire = createRequire(import.meta.url);
      const puppeteer = esmRequire('puppeteer');
      const version = esmRequire('puppeteer/package.json').version;
      console.log(JSON.stringify({ launch: typeof puppeteer.launch, major: Number(version.split('.')[0]) }));
    `);
    if (!out.ok) throw new Error(`puppeteer probe failed:\n${out.stderr}`);
    expect(out.result.launch).toBe('function');
    // @puppeteer/browsers < 3 (puppeteer < 25) pulls extract-zip, which has an
    // unpatched high-severity advisory; guard against a lockfile regression.
    expect(out.result.major).toBeGreaterThanOrEqual(25);
  }, 60_000);
});
