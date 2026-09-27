/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The labelled legacy extractor: ordering (most recent call first, cited
 * ids first), anchor removal, dedupe, cap, wrapped `[{text}]` content,
 * `hitsPaths` / `idFields` variants, and the no-candidates case. All tool
 * names / fields here are GENERIC fixtures.
 */

import type { TrajectoryStep } from '@/types';
import {
  extractToolHitsOrdered,
  parseToolResultContent,
  citedIdsInText,
  getPath,
  idsFromToolResult,
  toolHitsOptionsFromInputs,
  MAX_CANDIDATES,
} from '@/lib/scoring/prediction/toolHitsOrdered';

let n = 0;
const step = (partial: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'type'>): TrajectoryStep =>
  ({ id: `s${++n}`, timestamp: n, content: '', ...partial }) as TrajectoryStep;
const action = (toolName: string, toolArgs: Record<string, unknown>) => step({ type: 'action', toolName, toolArgs, content: JSON.stringify(toolArgs) });
const result = (toolName: string, payload: unknown, wrap = false) =>
  step({ type: 'tool_result', toolName, content: wrap ? JSON.stringify([{ text: JSON.stringify(payload) }]) : JSON.stringify(payload) });
const response = (text: string) => step({ type: 'response', content: text });
const hits = (...ids: string[]) => ({ hits: ids.map(id => ({ id, title: `t-${id}` })) });

describe('toolHitsOrdered — parsing helpers', () => {
  it('parseToolResultContent handles JSON strings, [{text}] wrapping, parsed objects and garbage', () => {
    expect(parseToolResultContent('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolResultContent(JSON.stringify([{ text: '{"a":2}' }]))).toEqual({ a: 2 });
    expect(parseToolResultContent([{ text: 'not json' }, { text: '{"a":3}' }])).toEqual({ a: 3 });
    expect(parseToolResultContent({ a: 4 })).toEqual({ a: 4 });
    expect(parseToolResultContent('plain text')).toBeUndefined();
    expect(parseToolResultContent('   ')).toBeUndefined();
    expect(parseToolResultContent([{ text: 'nope' }])).toBeUndefined();
  });

  it('getPath walks dotted paths', () => {
    expect(getPath({ a: { b: [1] } }, 'a.b')).toEqual([1]);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });

  it('idsFromToolResult reads every hitsPath in declared order and accepts bare ids', () => {
    const parsed = { hits: [{ id: '1' }, { _id: '2' }, { nope: 3 }, '4', 5], results: [{ id: '6' }] };
    expect(idsFromToolResult(parsed, { idFields: ['id', '_id'], hitsPaths: ['hits', 'results'] })).toEqual(['1', '2', '4', '5', '6']);
    expect(idsFromToolResult(parsed, { idFields: ['id'], hitsPaths: ['results', 'hits'] })).toEqual(['6', '1', '4', '5']);
    expect(idsFromToolResult({ hits: 'not an array' }, { idFields: ['id'], hitsPaths: ['hits'] })).toEqual([]);
  });

  it('citedIdsInText matches whole tokens only, ordered by first mention', () => {
    const text = 'Recommended: (id: 22), then id 7 and finally 1234. Not 122 or 70.';
    expect(citedIdsInText(text, ['7', '22', '1234', '12', '70x'])).toEqual(['22', '7', '1234']);
    expect(citedIdsInText('', ['1'])).toEqual([]);
    expect(citedIdsInText('a.b', ['a.b'])).toEqual(['a.b']); // regex metachars escaped
  });

  it('citedIdsInText: numeric ids inside prices, decimals, versions and hyphenated codes are NOT citations (codex_review)', () => {
    const text = 'Item (id: 41) costs $41.16; see v1.2024-01 and SKU 55-7; ends with (id: 202).';
    expect(citedIdsInText(text, ['16', '2024', '01', '1', '55', '7'])).toEqual([]);
    expect(citedIdsInText(text, ['41', '202'])).toEqual(['41', '202']); // sentence-ending period is a boundary
  });
});

describe('toolHitsOrdered — extraction rule', () => {
  it('(a) most recent tool call first, within-call order preserved; deduped', () => {
    const out = extractToolHitsOrdered([
      action('search', { q: 'x' }),
      result('search', hits('1', '2', '3')),
      action('search', { q: 'y' }),
      result('search', hits('3', '4')),
    ]);
    expect(out.rule).toBe('tool-hits-ordered');
    expect(out.ranked).toEqual(['3', '4', '1', '2']);
    expect(out.candidateCount).toBe(4);
    expect(out.citedCount).toBe(0);
    expect(out.anchorsRemoved).toBe(0);
    expect(out.hasAnswer).toBe(false);
  });

  it('(b) anchors named in the configured tool arg (string or string[]) are removed', () => {
    const out = extractToolHitsOrdered(
      [
        action('search', { q: 'x' }),
        result('search', hits('1', '2', '9')),
        action('expand', { seed_ids: ['1'], relation: 'related' }),
        result('expand', hits('5', '1', '6')),
        action('expand', { seed_ids: '9' }),
        result('expand', hits('7')),
      ],
      { anchorTools: [{ tool: 'expand', argKey: 'seed_ids' }] }
    );
    expect(out.ranked).toEqual(['7', '5', '6', '2']);
    expect(out.anchorsRemoved).toBe(2);
    expect(out.candidateCount).toBe(6);
  });

  it('(c) ids cited in the LAST response go first (by first mention), then the rest in retrieval order', () => {
    const out = extractToolHitsOrdered([
      result('search', hits('1', '2', '3', '4')),
      response('draft mentioning 4'),
      result('search', hits('5')),
      response('Final answer: item (id: 3) and item (id: 1). Also 99 which was never retrieved.'),
    ]);
    expect(out.ranked).toEqual(['3', '1', '5', '2', '4']);
    expect(out.citedCount).toBe(2);
    expect(out.hasAnswer).toBe(true);
  });

  it('cited anchors are not resurrected by the citation pass', () => {
    const out = extractToolHitsOrdered(
      [action('expand', { seed: 'A' }), result('expand', hits('A', 'B')), response('Try A then B')],
      { anchorTools: [{ tool: 'expand', argKey: 'seed' }] }
    );
    expect(out.ranked).toEqual(['B']);
    expect(out.citedCount).toBe(1);
    expect(out.anchorsRemoved).toBe(1);
  });

  it('supports [{text}]-wrapped content, dotted hitsPaths and custom idFields', () => {
    const out = extractToolHitsOrdered(
      [
        result('graph', { forward: { records: [{ node: 'n1' }, { node: 'n2' }] }, reverse: { records: [{ node: 'n3' }] } }, true),
        result('search', { docs: [{ node: 'n4' }] }, true),
      ],
      { hitsPaths: ['forward.records', 'reverse.records', 'docs'], idFields: ['node'] }
    );
    expect(out.ranked).toEqual(['n4', 'n1', 'n2', 'n3']);
  });

  it('falls back to toolOutput when content is empty, ignores unparseable results and non-hit tools', () => {
    const out = extractToolHitsOrdered([
      step({ type: 'tool_result', toolName: 'search', content: '', toolOutput: hits('a') } as any),
      step({ type: 'tool_result', toolName: 'status', content: 'ok' }),
      step({ type: 'tool_result', toolName: 'profile', content: JSON.stringify({ status: 'ok', profile: 'text' }) }),
      step({ type: 'thinking', content: 'hmm' }),
      null as unknown as TrajectoryStep,
    ]);
    expect(out.ranked).toEqual(['a']);
  });

  it('caps at MAX_CANDIDATES after ordering', () => {
    const ids = Array.from({ length: MAX_CANDIDATES + 25 }, (_, i) => `id${i}`);
    const out = extractToolHitsOrdered([result('search', hits(...ids)), response(`best is id${MAX_CANDIDATES + 20}`)]);
    expect(out.ranked).toHaveLength(MAX_CANDIDATES);
    expect(out.ranked[0]).toBe(`id${MAX_CANDIDATES + 20}`);
    expect(out.candidateCount).toBe(MAX_CANDIDATES + 25);
  });

  it('no candidates → empty ranking with honest counters', () => {
    expect(extractToolHitsOrdered([]).ranked).toEqual([]);
    expect(extractToolHitsOrdered(undefined).ranked).toEqual([]);
    const only = extractToolHitsOrdered([response('nothing retrieved')]);
    expect(only).toMatchObject({ ranked: [], candidateCount: 0, citedCount: 0, anchorsRemoved: 0, hasAnswer: true });
    // Every retrieved id was an anchor.
    const allAnchors = extractToolHitsOrdered(
      [action('expand', { seed: ['1'] }), result('expand', hits('1'))],
      { anchorTools: [{ tool: 'expand', argKey: 'seed' }] }
    );
    expect(allAnchors).toMatchObject({ ranked: [], candidateCount: 1, anchorsRemoved: 1 });
  });

  it('toolHitsOptionsFromInputs passes the evaluator-declared fields through', () => {
    expect(toolHitsOptionsFromInputs(undefined)).toEqual({ idFields: undefined, hitsPaths: undefined, anchorTools: undefined });
    expect(
      toolHitsOptionsFromInputs({ source: 'tool-hits-ordered', idFields: ['x'], hitsPaths: ['y'], anchorTools: [{ tool: 't', argKey: 'a' }] })
    ).toEqual({ idFields: ['x'], hitsPaths: ['y'], anchorTools: [{ tool: 't', argKey: 'a' }] });
  });
});
