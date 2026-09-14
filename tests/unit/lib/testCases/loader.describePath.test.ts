/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The loader captures each test's describe() chain as an ARRAY
 * (`describePath`, outermost first) alongside the joined `benchmarkPath`,
 * so importers can persist it on the TestCase for grouping.
 */

import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'ah-loader-describe-path-')); });
beforeEach(() => clearRegistry());

function write(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('loader — describePath capture', () => {
  it('records nested describes outermost-first and [] for a top-level test', async () => {
    const filePath = write('describe-path.eval.js', `
      const { test, describe } = require('@opensearch-project/agent-health');
      test('top-level', { prompt: 'p' }, () => {});
      describe('Outer > with arrow', () => {
        test('one-deep', { prompt: 'p' }, () => {});
        describe('Inner', () => {
          test('two-deep', { prompt: 'p' }, () => {});
        });
      });
    `);
    const result = await loadTestCasesFromModule(filePath);
    const byName = new Map(result.testCases.map(tc => [tc.name, tc]));

    expect(byName.get('top-level')?.describePath).toEqual([]);
    expect(byName.get('top-level')?.benchmarkPath).toBeUndefined();

    expect(byName.get('one-deep')?.describePath).toEqual(['Outer > with arrow']);
    expect(byName.get('two-deep')?.describePath).toEqual(['Outer > with arrow', 'Inner']);
    // The joined form is lossy when a title contains ' > '; the array is not.
    expect(byName.get('two-deep')?.benchmarkPath).toBe('Outer > with arrow > Inner');
  });

  it('each test gets its own array (mutating one does not leak into siblings)', async () => {
    const filePath = write('describe-path-isolation.eval.js', `
      const { test, describe } = require('@opensearch-project/agent-health');
      describe('S', () => {
        test('a', { prompt: 'p' }, () => {});
        test('b', { prompt: 'p' }, () => {});
      });
    `);
    const result = await loadTestCasesFromModule(filePath);
    const [a, b] = result.testCases;
    expect(a.describePath).not.toBe(b.describePath);
    expect(a.describePath).toEqual(['S']);
    expect(b.describePath).toEqual(['S']);
  });
});
