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

  it('a matching line that captures nothing usable is EXPLICITLY no gold (first match is authoritative; later lines ignored)', () => {
    expect(resolveGold({ expectedOutcomes: ['Gold id(s):  , ;', 'Gold id(s): 5'] }, PATTERN)).toEqual({ ids: [], rule: 'expected-outcomes-pattern' });
  });

  describe('explicitly no gold vs gold not declared', () => {
    it.each(['none', 'None', 'NONE', 'n/a', '-', '—', '[]', 'null', ''])('captured %p means explicitly no gold', (token) => {
      expect(resolveGold({ expectedOutcomes: [`Gold id(s): ${token}`] }, PATTERN)).toEqual({ ids: [], rule: 'expected-outcomes-pattern' });
    });

    it('expected.ids = [] is explicitly no gold ONLY for the structured gold source; under the pattern source it is "unset"', () => {
      expect(resolveGold({ expected: { ids: [] } }, STRUCTURED)).toEqual({ ids: [], rule: 'expected.ids' });
      // Clients serialize [] for "unset"; a pattern evaluator never reads it as an abstain case.
      expect(resolveGold({ expected: { ids: [] }, expectedOutcomes: ['prose only'] }, PATTERN)).toBeNull();
    });

    it('expected.ids = [] does not shadow a gold line (ids from the line win)', () => {
      expect(resolveGold({ expected: { ids: [] }, expectedOutcomes: ['Gold id(s): 7'] }, PATTERN)).toEqual({ ids: ['7'], rule: 'expected-outcomes-pattern' });
    });

    it('no expected.ids at all and no matching line → null (gold NOT declared, never an abstain case)', () => {
      expect(resolveGold({ expectedOutcomes: ['prose only'] }, PATTERN)).toBeNull();
      expect(resolveGold({}, STRUCTURED)).toBeNull();
      expect(resolveGold({ expected: {} }, STRUCTURED)).toBeNull();
    });

    it('a literal id that merely contains an empty token is still an id', () => {
      expect(splitGoldIds('none-1, 2')).toEqual(['none-1', '2']);
      expect(splitGoldIds('nonesuch')).toEqual(['nonesuch']);
    });
  });

  it('splitGoldIds splits on comma / semicolon / whitespace and dedupes', () => {
    expect(splitGoldIds(' 1, 2;3\t4  1 ')).toEqual(['1', '2', '3', '4']);
  });

  it('compileGoldPattern surfaces invalid regexes', () => {
    expect(() => compileGoldPattern('(')).toThrow(/not a valid regular expression/);
    expect(() => resolveGold({ expectedOutcomes: ['x'] }, { source: 'expectedOutcomes-pattern', pattern: '(' })).toThrow();
  });
});
