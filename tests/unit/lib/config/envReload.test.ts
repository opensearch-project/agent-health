/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `.env` re-read precedence (lib/config/envReload.ts) with REAL files in a
 * temp dir and an injected env object — the rules a long-lived server applies
 * before every UI-started run (#612):
 *   shell export > `.env` (unchanged from boot), `.env` edits apply, removed
 *   keys are unset, values code changed since the last read are left alone.
 */

import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { captureShellEnvSnapshot, getShellEnvSnapshot, reloadDotenv, __resetShellEnvSnapshot } from '@/lib/config/envReload';

describe('reloadDotenv — shell > .env precedence with real files', () => {
  let dir: string;
  const envFile = () => path.join(dir, '.env');

  beforeEach(() => {
    __resetShellEnvSnapshot();
    dir = mkdtempSync(path.join(tmpdir(), 'ah-envreload-'));
  });
  afterEach(() => {
    __resetShellEnvSnapshot();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Simulate boot: shell env, then dotenv's non-overriding merge. */
  function boot(shell: Record<string, string>, dotenv: string) {
    writeFileSync(envFile(), dotenv);
    const env: NodeJS.ProcessEnv = { ...shell };
    const snapshot = captureShellEnvSnapshot(env, dir);
    // dotenv semantics: set only what the shell did not provide
    for (const line of dotenv.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
    return { env, snapshot };
  }

  it('an edited .env value is applied on reload; a shell-exported key keeps the shell value', () => {
    const { env, snapshot } = boot({ SHELL_VAR: 'from-shell' }, 'HOOK_VAR=v1\nSHELL_VAR=from-dotenv\n');
    expect(env).toMatchObject({ HOOK_VAR: 'v1', SHELL_VAR: 'from-shell' });

    writeFileSync(envFile(), 'HOOK_VAR=v2\nSHELL_VAR=from-dotenv-2\nNEW_VAR=n1\n');
    const result = reloadDotenv(dir, env, snapshot);

    expect(result).toEqual({ applied: ['HOOK_VAR', 'NEW_VAR'], skipped: ['SHELL_VAR'], removed: [] });
    expect(env).toMatchObject({ HOOK_VAR: 'v2', NEW_VAR: 'n1', SHELL_VAR: 'from-shell' });
  });

  it('a key removed from .env is unset — unless the shell provided it', () => {
    const { env, snapshot } = boot({ SHELL_VAR: 's' }, 'GONE=1\nSHELL_VAR=d\nKEEP=k\n');
    writeFileSync(envFile(), 'KEEP=k\n');
    const result = reloadDotenv(dir, env, snapshot);
    expect(result.removed).toEqual(['GONE']);
    expect(result.skipped).toEqual(expect.arrayContaining(['SHELL_VAR']));
    expect(env.GONE).toBeUndefined();
    expect(env.SHELL_VAR).toBe('s');
    expect(env.KEEP).toBe('k');
  });

  it('a value code changed since the last read is never clobbered', () => {
    const { env, snapshot } = boot({}, 'CODE_OWNED=1\nOTHER=1\n');
    env.CODE_OWNED = 'set-by-code'; // some module rewrote it after boot
    writeFileSync(envFile(), 'CODE_OWNED=2\nOTHER=2\n');
    const result = reloadDotenv(dir, env, snapshot);
    expect(result.skipped).toEqual(['CODE_OWNED']);
    expect(result.applied).toEqual(['OTHER']);
    expect(env.CODE_OWNED).toBe('set-by-code');

    // Removing it from .env does not unset the code-set value either.
    writeFileSync(envFile(), 'OTHER=3\n');
    const second = reloadDotenv(dir, env, snapshot);
    expect(second.removed).toEqual([]);
    expect(env.CODE_OWNED).toBe('set-by-code');
    expect(env.OTHER).toBe('3');
  });

  it('process-identity keys are never re-applied, even when the current value equals what .env set (the bound port case)', () => {
    // .env says 8787, the server bound 8787 (so its rewrite left the value
    // equal), then .env is edited to 9999: self-calls must keep dialling 8787.
    const { env, snapshot } = boot({}, 'AH_PORT=8787\nPORT=8787\nHOOK_VAR=a\n');
    writeFileSync(envFile(), 'AH_PORT=9999\nPORT=9999\nHOOK_VAR=b\n');
    const result = reloadDotenv(dir, env, snapshot);
    expect(result.skipped).toEqual(expect.arrayContaining(['AH_PORT', 'PORT']));
    expect(result.applied).toEqual(['HOOK_VAR']);
    expect(env.AH_PORT).toBe('8787');
    expect(env.PORT).toBe('8787');
    expect(env.HOOK_VAR).toBe('b');
  });

  it('a .env that appears after boot is applied; one that disappears unsets what it provided', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin' };
    const snapshot = captureShellEnvSnapshot(env, dir); // no .env yet
    expect(snapshot.dotenvValues).toEqual({});

    writeFileSync(envFile(), 'LATE=1\n');
    expect(reloadDotenv(dir, env, snapshot).applied).toEqual(['LATE']);
    expect(env.LATE).toBe('1');

    unlinkSync(envFile());
    expect(reloadDotenv(dir, env, snapshot).removed).toEqual(['LATE']);
    expect(env.LATE).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('without a snapshot nothing is applied (no safe way to tell a shell export from a boot-time .env value)', () => {
    writeFileSync(envFile(), 'X=1\n');
    const env: NodeJS.ProcessEnv = {};
    expect(reloadDotenv(dir, env, undefined)).toEqual({ applied: [], skipped: [], removed: [] });
    expect(env.X).toBeUndefined();
  });

  it('captureShellEnvSnapshot is first-call-wins and shared process-wide', () => {
    const a = captureShellEnvSnapshot({ A: '1' }, dir);
    const b = captureShellEnvSnapshot({ B: '2' }, dir);
    expect(b).toBe(a);
    expect(getShellEnvSnapshot()).toBe(a);
    expect([...a.shellKeys]).toEqual(['A']);
  });
});
