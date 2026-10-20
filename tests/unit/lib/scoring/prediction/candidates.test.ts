/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ordered candidate-source chain (lib/scoring/prediction/candidates.ts):
 * source order, per-attempt recording, results-tool matching by name and by
 * payload convention, the weak generic scan, the anchor filter applied AFTER
 * extraction, lenient parsing of rendered tool results.
 */

import {
  extractCandidates,
  describeCandidateSources,
  DEFAULT_RESULTS_TOOL_PATTERN,
  RETURNED_SOURCES,
  CANDIDATE_SOURCE_ORDER,
} from '@/lib/scoring/prediction/candidates';
import { parseToolResultContent } from '@/lib/scoring/prediction/toolHitsOrdered';
import type { DeterministicEvaluatorInputs } from '@/types';

const TOOL_HITS: DeterministicEvaluatorInputs['prediction'] = { source: 'tool-hits-ordered', anchorTools: [{ tool: 'expand_relations', argKey: 'seed_ids' }] };
const RESPONSE: DeterministicEvaluatorInputs['prediction'] = { source: 'response-results' };

const step = (type: string, extra: Record<string, unknown>) => ({ id: `${type}-${Math.random()}`, timestamp: 1, type, ...extra }) as any;
const toolResult = (toolName: string, payload: unknown, wrap = false) =>
  step('tool_result', { toolName, content: wrap ? JSON.stringify([{ text: JSON.stringify(payload) }]) : JSON.stringify(payload) });
const hits = (toolName: string, ...ids: string[]) => toolResult(toolName, { hits: ids.map(id => ({ id })) });
const response = (content: string) => step('response', { content });

describe('extractCandidates — source order', () => {
  it('declares the chain order and which sources count as RETURNED', () => {
    expect(CANDIDATE_SOURCE_ORDER).toEqual(['report.output', 'response-results', 'results-tool', 'tool-hits', 'generic-scan']);
    expect(RETURNED_SOURCES).toEqual(['report.output', 'response-results', 'results-tool']);
  });

  it('1. typed report.output wins over everything and is a RETURNED source', () => {
    const r = extractCandidates(
      { output: { results: [{ id: 'o2', rank: 2 }, { id: 'o1', rank: 1 }] }, trajectory: [hits('search', 't1'), toolResult('return_results', { records: [{ id: 'r1' }] }), response('[{"id":"a1"}]')] },
      { prediction: TOOL_HITS },
    );
    expect(r).toMatchObject({ ranked: ['o1', 'o2'], sourceUsed: 'report.output', present: true, returned: true, weak: false, candidateCount: 2 });
    expect(r.sourceTried[0]).toEqual({ source: 'report.output', count: 2, detail: 'report.output.results' });
    // Every later source is still recorded, so a surprising winner is explainable.
    expect(r.sourceTried.map(a => a.source)).toEqual(['report.output', 'response-results', 'results-tool', 'tool-hits', 'tool-hits']);
  });

  it('report.output as a bare id array / { ids } works; an output with no list is recorded as a miss and skipped', () => {
    expect(extractCandidates({ output: ['x', 'y'], trajectory: [] }, { prediction: RESPONSE })).toMatchObject({ ranked: ['x', 'y'], sourceUsed: 'report.output' });
    expect(extractCandidates({ output: { ids: [] }, trajectory: [hits('search', 't1')] }, { prediction: RESPONSE })).toMatchObject({ ranked: [], sourceUsed: 'report.output', present: true, returned: true });
    const miss = extractCandidates({ output: { status: 'ok' }, trajectory: [hits('search', 't1')] }, { prediction: TOOL_HITS });
    expect(miss.sourceUsed).toBe('tool-hits');
    expect(miss.sourceTried[0]).toEqual({ source: 'report.output', count: 0, detail: 'report.output (no id list recognised)' });
  });

  it('2. the final answer (json / fenced / raw-event / labelled text) beats the results tool and the hits', () => {
    const r = extractCandidates(
      { trajectory: [hits('search', 't1', 't2'), toolResult('return_results', { records: [{ id: 'r1' }] }), response('Ranked:\n1. id a1 — one\n2. id a2 — two')] },
      { prediction: TOOL_HITS },
    );
    expect(r).toMatchObject({ ranked: ['a1', 'a2'], sourceUsed: 'response-results', parsedFrom: 'text', returned: true });
    expect(r.sourceTried).toEqual([
      { source: 'response-results', count: 2, detail: 'final response (text)' },
      { source: 'results-tool', count: 1, detail: "tool 'return_results' records" },
      { source: 'tool-hits', count: 2, detail: "tool 'search' hits (hits / results)" },
      { source: 'tool-hits', count: 0, detail: "tool 'return_results' hits (hits / results)" },
    ]);
    const raw = extractCandidates(
      { trajectory: [response('Ranked results (2): see above')], rawEvents: [{ results: [{ id: 'z', rank: 1 }] }] },
      { prediction: RESPONSE },
    );
    expect(raw).toMatchObject({ ranked: ['z'], sourceUsed: 'response-results', parsedFrom: 'raw-event' });
  });

  it('an EXPLICITLY empty final answer is a real (abstaining) result — later sources are not consulted', () => {
    const r = extractCandidates({ trajectory: [hits('search', 't1'), response('{"results": []}')] }, { prediction: TOOL_HITS });
    expect(r).toMatchObject({ ranked: [], present: true, sourceUsed: 'response-results', returned: true, candidateCount: 0 });
  });

  it('3. results tool by NAME (default pattern), reading records / items / ids / hits, last call wins', () => {
    for (const name of ['return_results', 'final_results', 'submit_results', 'commitResults', 'results', 'result']) {
      expect(new RegExp(DEFAULT_RESULTS_TOOL_PATTERN, 'i').test(name)).toBe(true);
    }
    expect(new RegExp(DEFAULT_RESULTS_TOOL_PATTERN, 'i').test('search_results_cache')).toBe(false);
    const r = extractCandidates(
      { trajectory: [hits('search', 't1'), toolResult('return_results', { records: [{ id: 'old' }] }), toolResult('return_results', { records: [{ id: 'r2' }, { id: 'r3' }] }, true), response('Done.')] },
      { prediction: TOOL_HITS },
    );
    expect(r).toMatchObject({ ranked: ['r2', 'r3'], sourceUsed: 'results-tool', returned: true, candidateCount: 2 });
    expect(r.sourceTried.filter(a => a.source === 'results-tool')).toEqual([{ source: 'results-tool', count: 2, detail: "tool 'return_results' records" }]);
  });

  it('3. results tool by PAYLOAD convention (returned_ids / recommended_ids / result_ids) regardless of tool name — but never a plain `results` / `hits` list on an arbitrary tool', () => {
    const r = extractCandidates(
      { trajectory: [hits('search', 't1'), toolResult('rank_candidates', { status: 'ok', result_ids: ['p1', 'p2'] }), response('Done.')] },
      { prediction: TOOL_HITS },
    );
    expect(r).toMatchObject({ ranked: ['p1', 'p2'], sourceUsed: 'results-tool' });
    expect(r.sourceTried.find(a => a.source === 'results-tool')).toEqual({ source: 'results-tool', count: 2, detail: "tool 'rank_candidates' result_ids" });
    // A search tool's `results[]` is what it RETRIEVED, not a returned ranking (codex_review):
    // it stays a tool-hits candidate (retrieved), never a RETURNED source.
    const search = extractCandidates({ trajectory: [toolResult('search_catalog', { results: [{ id: 'a' }, { id: 'b' }] }), response('Nothing final.')] }, { prediction: TOOL_HITS });
    expect(search).toMatchObject({ ranked: ['a', 'b'], sourceUsed: 'tool-hits', returned: false });
    expect(search.sourceTried.some(a => a.source === 'results-tool')).toBe(false);
    // …and a random tool's EMPTY `result_ids: []` is not an abstention.
    const empty = extractCandidates({ trajectory: [toolResult('lookup', { result_ids: [] }), hits('search', 't1')] }, { prediction: TOOL_HITS });
    expect(empty.sourceUsed).toBe('tool-hits');
  });

  it('the evaluator can override the results-tool pattern; an invalid pattern falls back to the default', () => {
    const custom = { ...TOOL_HITS, resultsTool: '^answer$' } as DeterministicEvaluatorInputs['prediction'];
    const r = extractCandidates({ trajectory: [toolResult('answer', { items: [{ id: 'a' }] }), hits('search', 't1')] }, { prediction: custom });
    expect(r).toMatchObject({ ranked: ['a'], sourceUsed: 'results-tool' });
    const broken = { ...TOOL_HITS, resultsTool: '(' } as DeterministicEvaluatorInputs['prediction'];
    expect(extractCandidates({ trajectory: [toolResult('return_results', { records: [{ id: 'b' }] })] }, { prediction: broken })).toMatchObject({ ranked: ['b'], sourceUsed: 'results-tool' });
  });

  it('4. configured tool hits (most recent call first, cited first) when nothing was RETURNED; per-tool counts are recorded', () => {
    const r = extractCandidates(
      { trajectory: [hits('search', 'a', 'b'), hits('lookup', 'c'), response('I think c and a are best.')] },
      { prediction: TOOL_HITS },
    );
    expect(r).toMatchObject({ ranked: ['c', 'a', 'b'], sourceUsed: 'tool-hits', returned: false, weak: false, citedCount: 2, candidateCount: 3 });
    expect(r.sourceTried.filter(a => a.source === 'tool-hits')).toEqual([
      { source: 'tool-hits', count: 2, detail: "tool 'search' hits (hits / results)" },
      { source: 'tool-hits', count: 1, detail: "tool 'lookup' hits (hits / results)" },
    ]);
    expect(r.toolsScanned).toEqual(['search', 'lookup']);
  });

  it('5. generic scan is the last resort and is flagged weak', () => {
    const r = extractCandidates(
      { trajectory: [toolResult('expand_relations', { forward: { neighbours: [{ id: 'n1' }, { id: 'n2' }] } }), toolResult('lookup', { data: { record: { _id: 'n3' } } })] },
      { prediction: TOOL_HITS },
    );
    expect(r).toMatchObject({ ranked: ['n3', 'n1', 'n2'], sourceUsed: 'generic-scan', weak: true, returned: false });
    expect(r.sourceTried.at(-1)).toEqual({ source: 'generic-scan', count: 3, detail: "every 'id' / '_id' value in 2 tool results (weak)" });
  });

  it('nothing anywhere → present false, sourceUsed none, every attempt recorded', () => {
    const r = extractCandidates({ trajectory: [toolResult('search', { status: 'ok', total: 0 }), response('Nothing found.')] }, { prediction: TOOL_HITS });
    expect(r).toMatchObject({ ranked: [], present: false, sourceUsed: 'none', hasAnswer: true });
    expect(r.sourceTried.map(a => [a.source, a.count])).toEqual([['response-results', 0], ['tool-hits', 0], ['generic-scan', 0]]);
    expect(extractCandidates({ trajectory: [] }, { prediction: TOOL_HITS })).toMatchObject({ present: false, sourceUsed: 'none', hasAnswer: false, toolsScanned: [] });
  });
});

describe('extractCandidates — a response-results evaluator never falls through to RETRIEVED sources', () => {
  it('records the tool-hit counts (annotated) but does not claim them; the generic scan is skipped', () => {
    const r = extractCandidates({ trajectory: [hits('search', 't1', 't2'), response('Nothing definitive; product t1 might be relevant.')] }, { prediction: RESPONSE });
    expect(r).toMatchObject({ present: false, sourceUsed: 'none', ranked: [] });
    expect(r.sourceTried).toEqual([
      { source: 'response-results', count: 0, detail: 'final response (no ranked list recognised)' },
      { source: 'tool-hits', count: 2, detail: "tool 'search' hits (hits / results) (not used: this evaluator scores returned lists only)" },
    ]);
    // …while the RETURNED sources (typed output, results tool) still count for it.
    expect(extractCandidates({ trajectory: [hits('search', 't1'), toolResult('return_results', { records: [{ id: 'r1' }] })] }, { prediction: RESPONSE })).toMatchObject({ sourceUsed: 'results-tool', ranked: ['r1'] });
  });
});

describe('extractCandidates — anchor filter AFTER extraction', () => {
  const anchorCall = step('action', { toolName: 'expand_relations', toolArgs: { seed_ids: ['anchor'] } });

  it('removes anchors from the winning source and reports the count; a list emptied by the filter still names its source', () => {
    const r = extractCandidates({ trajectory: [anchorCall, hits('search', 'anchor', 'x')] }, { prediction: TOOL_HITS });
    expect(r).toMatchObject({ ranked: ['x'], candidateCount: 2, anchorRemoved: 1, sourceUsed: 'tool-hits' });
    const emptied = extractCandidates({ trajectory: [anchorCall, hits('search', 'anchor')] }, { prediction: TOOL_HITS });
    expect(emptied).toMatchObject({ ranked: [], present: true, candidateCount: 1, anchorRemoved: 1, sourceUsed: 'tool-hits' });
    expect(describeCandidateSources(emptied)).toBe("0 from no final response step, 1 from tool 'search' hits (hits / results) (used); anchor removed 1");
  });

  it('applies to RETURNED sources too', () => {
    const r = extractCandidates({ trajectory: [anchorCall, response('[{"id":"anchor"},{"id":"y"}]')] }, { prediction: TOOL_HITS });
    expect(r).toMatchObject({ ranked: ['y'], anchorRemoved: 1, sourceUsed: 'response-results', returned: true });
  });
});

describe('parseToolResultContent — lenient', () => {
  it('parses a rendered `tool(args) -> [{text}]` string past its prefix — and never falls back to the ARGUMENTS when the result part does not parse', () => {
    const payload = { hits: [{ id: '1' }] };
    const rendered = `search({"q":"x"}) -> ${JSON.stringify([{ text: JSON.stringify(payload) }])}`;
    expect(parseToolResultContent(rendered)).toEqual(payload);
    expect(parseToolResultContent(`prefix text ${JSON.stringify(payload)}`)).toEqual(payload);
    // codex_review: the first `{` in a rendering is the call's args — an unparseable result must be undefined, not the args.
    expect(parseToolResultContent('search({"ids":["42"]}) -> <truncated>')).toBeUndefined();
    expect(parseToolResultContent('no json here')).toBeUndefined();
    expect(parseToolResultContent('')).toBeUndefined();
  });
});

describe('describeCandidateSources', () => {
  it('marks the used attempt once and appends the anchor count', () => {
    const text = describeCandidateSources({
      sourceTried: [
        { source: 'response-results', count: 0, detail: 'final response (no ranked list recognised)' },
        { source: 'tool-hits', count: 0, detail: "tool 'search' hits (hits / results)" },
        { source: 'tool-hits', count: 12, detail: "tool 'return_results' hits (hits / results)" },
      ],
      sourceUsed: 'tool-hits',
      candidateCount: 12,
      anchorRemoved: 1,
    });
    expect(text).toBe("0 from final response (no ranked list recognised), 0 from tool 'search' hits (hits / results), 12 from tool 'return_results' hits (hits / results) (used); anchor removed 1");
    expect(describeCandidateSources({ sourceTried: [], sourceUsed: 'none', candidateCount: 0, anchorRemoved: 0 })).toBe('no source produced candidates');
  });
});
