/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  extractResponseResults,
  findResultsArray,
  idsFromResultsArray,
  idsFromTextList,
  fencedJsonBlocks,
  finalResponseStep,
  responseResultsOptionsFromInputs,
} from '@/lib/scoring/prediction/responseResults';
import type { TrajectoryStep } from '@/types';

const step = (type: TrajectoryStep['type'], content: string, extra: Partial<TrajectoryStep> = {}): TrajectoryStep =>
  ({ id: `s-${Math.random().toString(36).slice(2, 7)}`, timestamp: 1, type, content, ...extra }) as TrajectoryStep;

const results = (ids: string[], withRank = false) =>
  ids.map((id, i) => ({ id, ...(withRank ? { rank: i + 1 } : {}), score: 1 - i / 10, title: `item ${id}` }));

describe('response-results — form (a): the response IS JSON', () => {
  it('reads an ordered results[] from a JSON object (answer may be null / empty)', () => {
    const payload = { answer: null, results: results(['9', '4', '7']), results_source: 'return_results' };
    const p = extractResponseResults({ trajectory: [step('tool_result', '{}'), step('response', JSON.stringify(payload))] });
    expect(p).toMatchObject({ rule: 'response-results', ranked: ['9', '4', '7'], candidateCount: 3, parsedFrom: 'json', present: true, hasAnswer: true });
  });

  it('reads a bare JSON array', () => {
    const p = extractResponseResults({ trajectory: [step('response', JSON.stringify(results(['a', 'b'])))] });
    expect(p.ranked).toEqual(['a', 'b']);
    expect(p.parsedFrom).toBe('json');
  });

  it('orders by rankField when every item carries a numeric rank (stable on ties), else by array order', () => {
    const shuffled = [{ id: 'c', rank: 3 }, { id: 'a', rank: 1 }, { id: 'b', rank: 2 }, { id: 'b2', rank: 2 }];
    expect(idsFromResultsArray(shuffled, { idField: 'id', rankField: 'rank' })).toEqual(['a', 'b', 'b2', 'c']);
    // string ranks are accepted; a single missing rank ⇒ array order for all.
    expect(idsFromResultsArray([{ id: 'x', rank: '2' }, { id: 'y', rank: '1' }], { idField: 'id', rankField: 'rank' })).toEqual(['y', 'x']);
    expect(idsFromResultsArray([{ id: 'x', rank: 2 }, { id: 'y' }], { idField: 'id', rankField: 'rank' })).toEqual(['x', 'y']);
    // A custom rank field.
    expect(idsFromResultsArray([{ id: 'x', position: 2 }, { id: 'y', position: 1 }], { idField: 'id', rankField: 'position' })).toEqual(['y', 'x']);
  });

  it('dedupes keeping the first occurrence, accepts numeric ids, skips items without an id, caps at 100', () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: i % 120 })); // 120 distinct, 10 repeats
    const p = extractResponseResults({ trajectory: [step('response', JSON.stringify({ results: [...many, { title: 'no id' }] }))] });
    expect(p.candidateCount).toBe(130);
    expect(p.ranked).toHaveLength(100);
    expect(p.ranked[0]).toBe('0');
    expect(p.ranked[99]).toBe('99');
  });

  it('honours path / idField overrides', () => {
    const payload = { data: { recommendations: [{ doc_id: 'd2', title: 't' }, { doc_id: 'd1' }] } };
    const p = extractResponseResults(
      { trajectory: [step('response', JSON.stringify(payload))] },
      { path: 'data.recommendations', idField: 'doc_id' }
    );
    expect(p.ranked).toEqual(['d2', 'd1']);
    // Without idField / path the auto-detect finds no id-carrying list → NOT present (unevaluable), never an empty prediction.
    const q = extractResponseResults({ trajectory: [step('response', JSON.stringify(payload))] });
    expect(q).toMatchObject({ ranked: [], parsedFrom: 'none', present: false, hasAnswer: true });
    // A declared path that resolves to a non-list (or a list without the id field) is likewise not found.
    expect(extractResponseResults({ trajectory: [step('response', JSON.stringify({ data: { recs: 'x' } }))] }, { path: 'data.recs' })).toMatchObject({ present: false });
    expect(extractResponseResults({ trajectory: [step('response', JSON.stringify({ data: { recs: [{ name: 'no id' }] } }))] }, { path: 'data.recs' })).toMatchObject({ present: false });
    // …but an explicitly EMPTY array at the path is a real empty prediction.
    expect(extractResponseResults({ trajectory: [step('response', JSON.stringify({ data: { recs: [] } }))] }, { path: 'data.recs' })).toMatchObject({ ranked: [], present: true, parsedFrom: 'json' });
  });

  it('auto-detects: root array, then results / hits / items, then any root-level id-carrying array — never deeper', () => {
    expect(findResultsArray([{ id: 1 }], { idField: 'id' })).toEqual([{ id: 1 }]);
    expect(findResultsArray({ hits: [{ id: 1 }], other: [{ id: 2 }] }, { idField: 'id' })).toEqual([{ id: 1 }]);
    expect(findResultsArray({ candidates: [{ id: 2 }] }, { idField: 'id' })).toEqual([{ id: 2 }]);
    // Nested shapes need an explicit path (auto-detect does not recurse into unrelated objects).
    expect(findResultsArray({ data: { results: [{ id: 3 }] } }, { idField: 'id' })).toBeUndefined();
    expect(findResultsArray({ data: { results: [{ id: 3 }] } }, { idField: 'id', path: 'data.results' })).toEqual([{ id: 3 }]);
    // Arrays of scalars / arrays of objects without the id field are not result lists.
    expect(findResultsArray({ tags: ['a', 'b'] }, { idField: 'id' })).toBeUndefined();
    expect(findResultsArray({ rows: [{ name: 'x' }] }, { idField: 'id' })).toBeUndefined();
    expect(findResultsArray([{ name: 'x' }], { idField: 'id' })).toBeUndefined();
    expect(findResultsArray('text', { idField: 'id' })).toBeUndefined();
    expect(findResultsArray({ results: 'not an array' }, { idField: 'id', path: 'results' })).toBeUndefined();
    // An empty conventional key is the list (explicit abstention); an empty unconventional key is not picked.
    expect(findResultsArray({ answer: 'none', results: [] }, { idField: 'id' })).toEqual([]);
    expect(findResultsArray({ answer: 'none', foo: [] }, { idField: 'id' })).toBeUndefined();
  });

  it('an explicitly EMPTY results[] is an empty prediction with parsedFrom json (scorable, not unevaluable)', () => {
    const p = extractResponseResults({ trajectory: [step('response', JSON.stringify({ answer: null, results: [], results_source: 'abstain' }))] });
    expect(p).toMatchObject({ ranked: [], candidateCount: 0, parsedFrom: 'json', present: true });
  });
});

describe('response-results — form (b): fenced JSON inside prose', () => {
  it('parses the first fenced block that carries a list (```json and bare ```)', () => {
    const text = 'Here are the results:\n```json\n{"results":[{"id":"11"},{"id":"22"}]}\n```\nAnything else?';
    const p = extractResponseResults({ trajectory: [step('response', text)] });
    expect(p).toMatchObject({ ranked: ['11', '22'], parsedFrom: 'fenced' });
    const bare = 'Answer:\n```\n[{"id":"5"}]\n```';
    expect(extractResponseResults({ trajectory: [step('response', bare)] }).ranked).toEqual(['5']);
  });

  it('skips fenced blocks that are not JSON or carry no list', () => {
    const text = '```js\nconsole.log(1)\n```\n```json\n{"note":"none"}\n```\n```json\n{"items":[{"id":"z"}]}\n```';
    expect(fencedJsonBlocks(text)).toHaveLength(2);
    expect(extractResponseResults({ trajectory: [step('response', text)] })).toMatchObject({ ranked: ['z'], parsedFrom: 'fenced' });
  });
});

describe('response-results — raw payload of a non-streaming connector', () => {
  const payload = { answer: null, results: results(['301', '302'], true), results_source: 'return_results' };
  it('uses the single raw payload when the response step is only a rendering of it', () => {
    const p = extractResponseResults({
      trajectory: [step('response', 'Ranked results (2):\n1. id 301 — item (score 0.9)\n2. id 302 — item')],
      rawEvents: [payload],
    });
    expect(p).toMatchObject({ ranked: ['301', '302'], parsedFrom: 'raw-event', present: true, hasAnswer: true });
  });
  it('never stands in for a missing answer (payload only, no response step → absent)', () => {
    const p = extractResponseResults({ trajectory: [step('tool_result', '{}')], rawEvents: [payload] });
    expect(p).toMatchObject({ ranked: [], parsedFrom: 'none', present: false, hasAnswer: false });
  });
  it('never consults streaming event lists (more than one raw event) or non-object payloads', () => {
    const streaming = [{ type: 'RUN_STARTED' }, { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'm1' }] }];
    const p = extractResponseResults({ trajectory: [step('response', 'done')], rawEvents: streaming });
    expect(p).toMatchObject({ ranked: [], parsedFrom: 'none' });
    expect(extractResponseResults({ trajectory: [], rawEvents: [[{ id: 'x' }]] })).toMatchObject({ ranked: [], present: false });
    expect(extractResponseResults({ trajectory: [], rawEvents: ['text'] })).toMatchObject({ present: false });
  });
  it('JSON in the response step wins over the raw payload', () => {
    const p = extractResponseResults({ trajectory: [step('response', JSON.stringify({ results: [{ id: 'r1' }] }))], rawEvents: [payload] });
    expect(p).toMatchObject({ ranked: ['r1'], parsedFrom: 'json' });
  });
});

describe('response-results — form (c): rendered text list (best-effort)', () => {
  it('reads list lines with an explicit id label, in line order', () => {
    const text = [
      'Ranked results (3, source=return_results):',
      '1. id 2079 — Some belt (score 6.32)',
      '2. id 41927 — Another belt (score 5.19)',
      '3. Third belt (ID: 84478)',
      'Anchor ids (excluded): 33287, 404983',
    ].join('\n');
    expect(idsFromTextList(text)).toEqual(['2079', '41927', '84478']);
    const p = extractResponseResults({ trajectory: [step('response', text)] });
    expect(p).toMatchObject({ ranked: ['2079', '41927', '84478'], candidateCount: 3, parsedFrom: 'text' });
  });

  it('accepts -, *, • and 1) bullets and id=/id#/`id`/**id** spellings at the item start or in brackets; ignores prose and null-ish tokens', () => {
    const text = [
      '- id: A-77',
      '* id=B_8',
      '• Item nine (id #9)',
      '4) `id` 10.',
      '5. **id**: 11 — bold label',
      '6. Item twelve [ID: 12]',
      '- 42 is a number, not an id',
      '- user id 123 was checked (mid-sentence label is prose, not a list item id)',
      'The price was $41.16 and id 999 is prose, not a list line',
      '1. ids 55 are plural, not a label',
      '2. id: none',
      '3. id: null',
    ].join('\n');
    expect(idsFromTextList(text)).toEqual(['A-77', 'B_8', '9', '10', '11', '12']);
  });

  it('dedupes text ids', () => {
    expect(extractResponseResults({ trajectory: [step('response', '1. id 7\n2. id 7\n3. id 8')] }).ranked).toEqual(['7', '8']);
  });
});

describe('response-results — empty vs absent', () => {
  it('a response with no recognisable list → ABSENT (unevaluable): "could not extract" is never "returned nothing"', () => {
    const p = extractResponseResults({ trajectory: [step('response', 'I could not find anything relevant.')] });
    expect(p).toMatchObject({ ranked: [], candidateCount: 0, parsedFrom: 'none', present: false, hasAnswer: true });
    // JSON without a list is equally absent.
    expect(extractResponseResults({ trajectory: [step('response', JSON.stringify({ answer: 'nothing relevant' }))] })).toMatchObject({ present: false, hasAnswer: true });
  });
  it('an explicit EMPTY list is a present, empty prediction (scorable abstention)', () => {
    expect(extractResponseResults({ trajectory: [step('response', '[]')] })).toMatchObject({ ranked: [], present: true, parsedFrom: 'json' });
    expect(extractResponseResults({ trajectory: [step('response', 'Nothing.\n```json\n{"results": []}\n```')] })).toMatchObject({ ranked: [], present: true, parsedFrom: 'fenced' });
  });
  it('no response / assistant step → absent (unevaluable)', () => {
    const p = extractResponseResults({ trajectory: [step('tool_result', JSON.stringify({ hits: [{ id: 'h1' }] }))] });
    expect(p).toMatchObject({ ranked: [], parsedFrom: 'none', present: false, hasAnswer: false });
    expect(extractResponseResults({ trajectory: [] })).toMatchObject({ present: false });
    expect(extractResponseResults({ trajectory: undefined as any })).toMatchObject({ present: false });
  });
  it('tool results are NEVER read as the prediction (that is tool-hits-ordered\'s job)', () => {
    const p = extractResponseResults({
      trajectory: [step('tool_result', JSON.stringify({ results: [{ id: 'retrieved-only' }] })), step('response', JSON.stringify({ results: [{ id: 'recommended' }] }))],
    });
    expect(p.ranked).toEqual(['recommended']);
  });
});

describe('response-results — final response step', () => {
  it('uses the LAST response step; falls back to the last assistant step; ignores non-string content', () => {
    const t = [step('assistant', '[{"id":"a1"}]'), step('response', '[{"id":"r1"}]'), step('tool_result', '{}'), step('response', '[{"id":"r2"}]')];
    expect(finalResponseStep(t)?.content).toBe('[{"id":"r2"}]');
    expect(finalResponseStep([step('assistant', '[{"id":"a1"}]'), step('assistant', '[{"id":"a2"}]')])?.content).toBe('[{"id":"a2"}]');
    expect(finalResponseStep([step('response', 42 as any), step('assistant', 'x')])?.content).toBe('x');
    expect(finalResponseStep([null as any, step('thinking', 'hmm')])).toBeUndefined();
    expect(extractResponseResults({ trajectory: [step('assistant', '[{"id":"a2"}]')] })).toMatchObject({ ranked: ['a2'], parsedFrom: 'json' });
  });
});

describe('responseResultsOptionsFromInputs', () => {
  it('maps the evaluator inputs; other sources yield defaults', () => {
    expect(responseResultsOptionsFromInputs({ source: 'response-results', path: 'a.b', idField: 'doc', rankField: 'pos' })).toEqual({ path: 'a.b', idField: 'doc', rankField: 'pos' });
    expect(responseResultsOptionsFromInputs({ source: 'tool-hits-ordered' })).toEqual({});
    expect(responseResultsOptionsFromInputs(undefined)).toEqual({});
  });
});
