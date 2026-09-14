/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveGold, splitGoldIds, compileGoldPattern } from '@/lib/scoring/gold';

const PATTERN = { source: 'expectedOutcomes-pattern' as const, pattern: '^Gold id\\(s\\):\\s*(.+)$' };
const STRUCTURED = { source: 'testCase.expected.ids' as const };

describe('lib/scoring/gold — resolveGold', () => {
  it('structured expected.ids wins over everything', () => {
    const tc = { expected: { ids: ['a', 'b', 'a'] }, expectedOutcomes: ['Gold id(s): z'] };
    expect(resolveGold(tc, PATTERN)).toEqual({ ids: ['a', 'b'], rule: 'expected.ids' });
    expect(resolveGold(tc, STRUCTURED)).toEqual({ ids: ['a', 'b'], rule: 'expected.ids' });
  });

  it('falls back to the FIRST matching expectedOutcomes line when declared', () => {
    const tc = {
      expectedOutcomes: ['Some prose about the case', 'Gold id(s): 11, 22; 33 44', 'Gold id(s): 99'],
    };
    expect(resolveGold(tc, PATTERN)).toEqual({ ids: ['11', '22', '33', '44'], rule: 'expected-outcomes-pattern' });
  });

  it('empty structured ids do not block the pattern fallback', () => {
    const tc = { expected: { ids: [] }, expectedOutcomes: ['Gold id(s): 7'] };
    expect(resolveGold(tc, PATTERN)).toEqual({ ids: ['7'], rule: 'expected-outcomes-pattern' });
  });

  it('returns null when nothing matches, when the pattern is not declared, or the test case is missing', () => {
    expect(resolveGold({ expectedOutcomes: ['no gold here'] }, PATTERN)).toBeNull();
    expect(resolveGold({ expectedOutcomes: ['Gold id(s): 7'] }, STRUCTURED)).toBeNull();
    expect(resolveGold(null, PATTERN)).toBeNull();
    expect(resolveGold({ expectedOutcomes: [42 as unknown as string] }, PATTERN)).toBeNull();
  });

  it('a matching line that captures nothing usable yields null (first match is authoritative)', () => {
    expect(resolveGold({ expectedOutcomes: ['Gold id(s):  , ;', 'Gold id(s): 5'] }, PATTERN)).toBeNull();
  });

  it('splitGoldIds splits on comma / semicolon / whitespace and dedupes', () => {
    expect(splitGoldIds(' 1, 2;3\t4  1 ')).toEqual(['1', '2', '3', '4']);
  });

  it('compileGoldPattern surfaces invalid regexes', () => {
    expect(() => compileGoldPattern('(')).toThrow(/not a valid regular expression/);
    expect(() => resolveGold({ expectedOutcomes: ['x'] }, { source: 'expectedOutcomes-pattern', pattern: '(' })).toThrow();
  });
});
