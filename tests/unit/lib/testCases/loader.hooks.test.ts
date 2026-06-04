/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ah-loader-hooks-'));
});

beforeEach(() => clearRegistry());

function write(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('loader — hooks (CJS .js path)', () => {
  it('returns hooks alongside testCases when the file uses beforeEach/afterEach', async () => {
    const filePath = write('with-hooks.eval.js', `
      const ah = require('@opensearch-project/agent-health');
      ah.beforeAll(() => {});
      ah.afterAll(() => {});
      ah.beforeEach(() => {});
      ah.afterEach(() => {});
      ah.test('t', { prompt: 'p' }, () => {});
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.testCases).toHaveLength(1);
    expect(result.hooks.map(h => h.kind).sort()).toEqual(['afterAll', 'afterEach', 'beforeAll', 'beforeEach']);
    expect(result.hooks.every(h => h.sourceFile === filePath)).toBe(true);
  });

  it('test.beforeEach static form is also accepted', async () => {
    const filePath = write('static-form.eval.js', `
      const { test } = require('@opensearch-project/agent-health');
      test.beforeEach(() => {});
      test('t', { prompt: 'p' }, () => {});
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0].kind).toBe('beforeEach');
  });

  it('records describePath for hooks inside describe blocks', async () => {
    const filePath = write('describe-hook.eval.js', `
      const ah = require('@opensearch-project/agent-health');
      ah.describe('Suite A', () => {
        ah.beforeEach(() => {});
        ah.test('t', { prompt: 'p' }, () => {});
      });
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0].describePath).toBe('Suite A');
  });

  it('returns an empty hooks array when no hooks are registered', async () => {
    const filePath = write('no-hooks.eval.js', `
      const { test } = require('@opensearch-project/agent-health');
      test('t', { prompt: 'p' }, () => {});
    `);
    const result = await loadTestCasesFromModule(filePath);
    expect(result.hooks).toEqual([]);
  });

  it('clears the previous file\u2019s hooks on reload', async () => {
    const filePath = write('reload.eval.js', `
      const ah = require('@opensearch-project/agent-health');
      ah.beforeEach(() => {});
      ah.test('t1', { prompt: 'p' }, () => {});
    `);
    const r1 = await loadTestCasesFromModule(filePath);
    expect(r1.hooks).toHaveLength(1);
    // Reload (file content unchanged) — hook count must stay at 1, not double.
    const r2 = await loadTestCasesFromModule(filePath);
    expect(r2.hooks).toHaveLength(1);
  });
});
