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
    expect(resolveGold(tc, PATTERN)).toEqual({ ids: ['11', '22', '33', '44'], rule: 'expected-outcomes-pattern', lineIndex: 1 });
  });

  it('empty structured ids do not block the pattern fallback', () => {
    const tc = { expected: { ids: [] }, expectedOutcomes: ['Gold id(s): 7'] };
    expect(resolveGold(tc, PATTERN)).toEqual({ ids: ['7'], rule: 'expected-outcomes-pattern', lineIndex: 0 });
  });

  it('returns null when nothing matches, when the pattern is not declared, or the test case is missing', () => {
    expect(resolveGold({ expectedOutcomes: ['some prose here'] }, PATTERN)).toBeNull();
    expect(resolveGold({ expectedOutcomes: ['Gold id(s): 7'] }, STRUCTURED)).toBeNull();
    expect(resolveGold(null, PATTERN)).toBeNull();
    expect(resolveGold({ expectedOutcomes: [42 as unknown as string] }, PATTERN)).toBeNull();
  });

  it('a matching line that captures nothing usable is EXPLICITLY no gold (first match is authoritative; later lines ignored)', () => {
    expect(resolveGold({ expectedOutcomes: ['Gold id(s):  , ;', 'Gold id(s): 5'] }, PATTERN)).toEqual({ ids: [], rule: 'expected-outcomes-pattern', lineIndex: 0 });
  });

  describe('explicitly no gold vs gold not declared', () => {
    it.each(['none', 'None', 'NONE', 'n/a', '-', '—', '[]', 'null', ''])('captured %p means explicitly no gold', (token) => {
      expect(resolveGold({ expectedOutcomes: [`Gold id(s): ${token}`] }, PATTERN)).toEqual({ ids: [], rule: 'expected-outcomes-pattern', lineIndex: 0 });
    });

    it('expected.ids = [] is explicitly no gold ONLY for the structured gold source; under the pattern source it is "unset"', () => {
      expect(resolveGold({ expected: { ids: [] } }, STRUCTURED)).toEqual({ ids: [], rule: 'expected.ids' });
      // Clients serialize [] for "unset"; a pattern evaluator never reads it as an abstain case.
      expect(resolveGold({ expected: { ids: [] }, expectedOutcomes: ['prose only'] }, PATTERN)).toBeNull();
    });

    it('expected.ids = [] does not shadow a gold line (ids from the line win)', () => {
      expect(resolveGold({ expected: { ids: [] }, expectedOutcomes: ['Gold id(s): 7'] }, PATTERN)).toEqual({ ids: ['7'], rule: 'expected-outcomes-pattern', lineIndex: 0 });
    });

    it('no expected.ids at all and no matching line → null (gold NOT declared, never an abstain case)', () => {
      expect(resolveGold({ expectedOutcomes: ['prose only'] }, PATTERN)).toBeNull();
      expect(resolveGold({}, STRUCTURED)).toBeNull();
      expect(resolveGold({ expected: {} }, STRUCTURED)).toBeNull();
    });

    // Owner incident: an abstain case whose first expectedOutcomes line reads
    // "NONE — the anchor has no … edges …" was reported as "no gold ids on
    // the test case" (not evaluable). A line that STARTS with an explicit
    // no-gold marker is a declaration: gold is EMPTY, the case is an abstain.
    it.each([
      'NONE — the anchor has no related edges in either direction; the answer recommends ZERO products.',
      'None. Nothing should be returned for this query.',
      'NONE',
      'No gold ids: the right answer is an empty list.',
      'no gold — abstain expected',
      'No gold (abstain case)',
    ])('a line that IS an explicit no-gold marker (%p) is EXPLICITLY no gold, never "not declared"', (line) => {
      expect(resolveGold({ expectedOutcomes: ['Some prose first', line] }, PATTERN)).toEqual({ ids: [], rule: 'expected-outcomes-none', lineIndex: 1 });
    });

    it('a NONE line never overrides a matching gold line (the gold line is authoritative)', () => {
      expect(resolveGold({ expectedOutcomes: ['NONE for the first sub-question', 'Gold id(s): 7'] }, PATTERN)).toEqual({ ids: ['7'], rule: 'expected-outcomes-pattern', lineIndex: 1 });
    });

    it.each([
      'The agent returns none of the distractors',
      'None of the distractors should be returned',
      'No gold standard exists for this query; judge by relevance',
      'Nothing should be returned for this query',
    ])('prose that merely begins with the word (%p) is NOT a declaration (codex_review)', (line) => {
      expect(resolveGold({ expectedOutcomes: [line] }, PATTERN)).toBeNull();
    });

    it('only the pattern source reads expectedOutcomes at all', () => {
      expect(resolveGold({ expectedOutcomes: ['NONE'] }, STRUCTURED)).toBeNull();
    });

    it('a literal id that merely contains an empty token is still an id', () => {
      expect(splitGoldIds('none-1, 2')).toEqual(['none-1', '2']);
      expect(splitGoldIds('nonesuch')).toEqual(['nonesuch']);
    });
  });

  it('splitGoldIds splits on comma / semicolon / whitespace and dedupes', () => {
    expect(splitGoldIds(' 1, 2;3\t4  1 ')).toEqual(['1', '2', '3', '4']);
  });

  // Owner incident: gold lines carry the human-readable names after the ids —
  // `Gold product id(s): 290226, 116770 (Name One; Name Two)` — and every
  // word of the names used to be split into a "gold id".
  describe('splitGoldIds drops parenthesised annotation (names after the ids)', () => {
    it('ids before a parenthesised name list', () => {
      expect(splitGoldIds('428457 (Some Product Name)')).toEqual(['428457']);
      expect(splitGoldIds('290226, 116770 (First Product Name; Second, Product Name)')).toEqual(['290226', '116770']);
    });
    it('nested / unbalanced parentheses', () => {
      expect(splitGoldIds('12 (Name (variant) here), 34')).toEqual(['12', '34']);
      expect(splitGoldIds('12, 34 (unterminated annotation, 99')).toEqual(['12', '34']);
    });
    it('an explicit empty token followed by a note is still explicitly no gold', () => {
      expect(splitGoldIds('none (this query has no gold)')).toEqual([]);
      expect(splitGoldIds('NONE — abstain expected')).toEqual([]);
    });
    it('end to end through resolveGold with a product-style pattern', () => {
      const P = { source: 'expectedOutcomes-pattern' as const, pattern: '^Gold product id\\(s\\):\\s*(.+)$' };
      expect(resolveGold({ expectedOutcomes: ['Gold product id(s): 290226, 116770 (First Product; Second Product)', 'more prose'] }, P))
        .toEqual({ ids: ['290226', '116770'], rule: 'expected-outcomes-pattern', lineIndex: 0 });
      expect(resolveGold({ expectedOutcomes: ['Gold product id(s): 428457 (Some Product Name)'] }, P))
        .toEqual({ ids: ['428457'], rule: 'expected-outcomes-pattern', lineIndex: 0 });
    });
  });

  it('compileGoldPattern surfaces invalid regexes', () => {
    expect(() => compileGoldPattern('(')).toThrow(/not a valid regular expression/);
    expect(() => resolveGold({ expectedOutcomes: ['x'] }, { source: 'expectedOutcomes-pattern', pattern: '(' })).toThrow();
  });
});
