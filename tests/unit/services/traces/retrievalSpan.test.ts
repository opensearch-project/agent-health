/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retrieval span I/O extraction (OTel DB semconv) and the `*.hit_ids` /
 * `*.result_ids` / `retrieval.ids` id-list convention.
 */

import { Span } from '@/types';
import {
  extractRetrievalIO,
  extractRetrievalIdLists,
  extractRetrievedVsReturned,
  classifyRetrievalIdListKey,
  describeOverlap,
  isRetrievalIdListKey,
  parseIdList,
  prettyPrintIfJson,
} from '@/services/traces/retrievalSpan';
import { getKeyAttributes } from '@/services/traces/utils';

function span(attributes: Record<string, any>, name = 'search products'): Span {
  return {
    traceId: 't',
    spanId: 's',
    name,
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:00.050Z',
    duration: 50,
    status: 'OK',
    attributes,
  };
}

describe('parseIdList (strict: list-shaped values only)', () => {
  it('accepts native arrays of scalars', () => {
    expect(parseIdList(['a', 'b', 3])).toEqual(['a', 'b', '3']);
  });
  it('accepts JSON array text', () => {
    expect(parseIdList('["a","b"]')).toEqual(['a', 'b']);
    expect(parseIdList('[1, 2]')).toEqual(['1', '2']);
  });
  it('accepts a Python-style single-quoted list literal', () => {
    expect(parseIdList("['2079', '41927', '84478']")).toEqual(['2079', '41927', '84478']);
  });
  it('keeps ids that contain commas intact (no naive comma-splitting)', () => {
    expect(parseIdList('["doc,1", "doc,2"]')).toEqual(['doc,1', 'doc,2']);
  });
  it('returns null for values that are not a list', () => {
    expect(parseIdList(null)).toBeNull();
    expect(parseIdList(undefined)).toBeNull();
    expect(parseIdList('')).toBeNull();
    expect(parseIdList('(x, y ,z)')).toBeNull();
    expect(parseIdList('a, b, c')).toBeNull();
    expect(parseIdList(42)).toBeNull();
    expect(parseIdList('{"ids":[1]}')).toBeNull();
    expect(parseIdList('[not json')).toBeNull();
  });
  it('returns null for lists of structured items without a single id-like key (not ids)', () => {
    expect(parseIdList([{ title: 'x', score: 1 }])).toBeNull();
    expect(parseIdList('[{"title":"x"}]')).toBeNull();
    expect(parseIdList([[1, 2]])).toBeNull();
  });
  it('returns [] for an empty list', () => {
    expect(parseIdList('[]')).toEqual([]);
    expect(parseIdList([])).toEqual([]);
  });
});

describe('id-list key convention', () => {
  it('matches *.hit_ids, *.result_ids and retrieval.ids only', () => {
    expect(isRetrievalIdListKey('myagent.search.hit_ids')).toBe(true);
    expect(isRetrievalIdListKey('vector.result_ids')).toBe(true);
    expect(isRetrievalIdListKey('hit_ids')).toBe(true);
    expect(isRetrievalIdListKey('retrieval.ids')).toBe(true);
    expect(isRetrievalIdListKey('db.query.text')).toBe(false);
    expect(isRetrievalIdListKey('search.hit_ids_count')).toBe(false);
    expect(isRetrievalIdListKey('something.ids')).toBe(false);
  });

  it('collects every matching attribute; unparseable values are kept verbatim as raw', () => {
    const lists = extractRetrievalIdLists(
      span({ 'a.hit_ids': ['1', '2'], 'b.result_ids': '["x"]', 'retrieval.ids': '', 'c.hit_ids': [], 'd.hit_ids': 'p1, p2' })
    );
    expect(lists).toEqual([
      { attribute: 'a.hit_ids', ids: ['1', '2'], role: 'ids' },
      { attribute: 'b.result_ids', ids: ['x'], role: 'ids' },
      { attribute: 'd.hit_ids', ids: [], raw: 'p1, p2', role: 'ids' },
    ]);
  });

  it('does NOT reduce lists of objects to ids — a result object is not an id', () => {
    expect(parseIdList([{ id: 'a' }, { id: 7 }])).toBeNull();
    expect(parseIdList('[{"doc_id":"d1"}]')).toBeNull();
  });

  it('renders a raw (unparseable) id attribute verbatim in the output text', () => {
    const io = extractRetrievalIO(span({ 'db.system.name': 'x', 'search.hit_ids': 'p1, p2' }));
    expect(io.outputText).toBe('search.hit_ids: p1, p2');
  });
});

describe('retrieved vs returned (labelled pair)', () => {
  it('classifies keys: `retrieved` segment → retrieved; results*/returned/recommended → returned; hit_ids stay neutral', () => {
    expect(classifyRetrievalIdListKey('retrieval.retrieved.ids')).toBe('retrieved');
    expect(classifyRetrievalIdListKey('myagent.retrieved.doc_ids')).toBe('retrieved');
    expect(classifyRetrievalIdListKey('retrieved.candidates')).toBe('retrieved');
    expect(classifyRetrievalIdListKey('retrieval.results.ids')).toBe('returned');
    expect(classifyRetrievalIdListKey('myagent.results')).toBe('returned');
    expect(classifyRetrievalIdListKey('myagent.results_ids')).toBe('returned');
    expect(classifyRetrievalIdListKey('myagent.results_doc_ids')).toBe('returned');
    expect(classifyRetrievalIdListKey('x.returned.ids')).toBe('returned');
    expect(classifyRetrievalIdListKey('x.returned_ids')).toBe('returned');
    expect(classifyRetrievalIdListKey('x.recommended.ids')).toBe('returned');
    expect(classifyRetrievalIdListKey('x.retrieved_ids')).toBe('retrieved');
    expect(classifyRetrievalIdListKey('x.docs_retrieved')).toBe('retrieved');
    expect(classifyRetrievalIdListKey('x.top_retrieved.ids')).toBe('retrieved');
    // Counts / metadata siblings are not id lists.
    expect(classifyRetrievalIdListKey('x.results_count')).toBeNull();
    expect(classifyRetrievalIdListKey('x.results_metadata')).toBeNull();
    expect(classifyRetrievalIdListKey('http.response.returned_bytes')).toBeNull();
    expect(classifyRetrievalIdListKey('search.hit_ids')).toBe('ids');
    expect(classifyRetrievalIdListKey('search.result_ids')).toBe('ids');
    expect(classifyRetrievalIdListKey('retrieval.ids')).toBe('ids');
    // Not the pattern: `results` must be a whole segment start, `retrieved` a whole segment.
    expect(classifyRetrievalIdListKey('db.query.text')).toBeNull();
    expect(classifyRetrievalIdListKey('unretrieved.ids')).toBeNull();
    expect(classifyRetrievalIdListKey('x.myresults')).toBeNull();
    expect(isRetrievalIdListKey('retrieval.retrieved.ids')).toBe(true);
  });

  it('splits a root span into the two sides and computes the overlap (distinct ids)', () => {
    const rr = extractRetrievedVsReturned(span({
      'agent.retrieved.doc_ids': ['1', '2', '3', '4', '4'],
      'agent.results': ['2', '4', '9'],
    }, 'POST /ask'));
    expect(rr.retrieved.map(l => l.attribute)).toEqual(['agent.retrieved.doc_ids']);
    expect(rr.returned.map(l => l.attribute)).toEqual(['agent.results']);
    expect(rr.retrievedIds).toEqual(['1', '2', '3', '4']);
    expect(rr.returnedIds).toEqual(['2', '4', '9']);
    expect(rr.overlap).toEqual({ returnedFromRetrieved: 2, returnedNotRetrieved: 1 });
    expect(describeOverlap(rr)).toBe('2 of 4 retrieved were returned; 1 returned id was not in the retrieved set');
  });

  it('phrases a clean subset without the extra clause and returns null overlap when one side is missing', () => {
    const both = extractRetrievedVsReturned(span({ 'retrieval.retrieved.ids': ['a', 'b', 'c'], 'retrieval.results.ids': ['a', 'b'] }));
    expect(describeOverlap(both)).toBe('2 of 3 retrieved were returned');
    const only = extractRetrievedVsReturned(span({ 'retrieval.retrieved.ids': ['a'] }));
    expect(only.returned).toEqual([]);
    expect(only.overlap).toBeNull();
    expect(describeOverlap(only)).toBeNull();
    const none = extractRetrievedVsReturned(span({ 'db.system.name': 'x', 'search.hit_ids': ['a'] }));
    expect(none.retrieved).toEqual([]);
    expect(none.returned).toEqual([]);
  });

  it('only list-shaped values join the pair: scalar siblings, object lists and unparseable blobs are left to the attribute table', () => {
    const rr = extractRetrievedVsReturned(span({
      'agent.results': ['1'],
      'agent.results.source': 'return_results',
      'agent.results_count': 1,
      'agent.results_metadata': [{ id: '1', score: 0.9 }],
      'agent.returned.ids': '[oops',
    }));
    expect(rr.returned.map(l => l.attribute)).toEqual(['agent.results']);
    // …whereas the neutral hit_ids keys still keep an unparseable value verbatim (#527).
    expect(extractRetrievalIdLists(span({ 'search.hit_ids': 'p1, p2' }))).toEqual([
      { attribute: 'search.hit_ids', ids: [], raw: 'p1, p2', role: 'ids' },
    ]);
  });

  it('labels the sides in the RETRIEVAL output text', () => {
    const io = extractRetrievalIO(span({ 'db.system.name': 'x', 'q.retrieved.ids': ['a'], 'q.results.ids': ['a'] }));
    expect(io.outputText).toBe('Retrieved (seen) q.retrieved.ids (1):\n  - a\nReturned (recommended) q.results.ids (1):\n  - a');
  });
});

describe('prettyPrintIfJson', () => {
  it('pretty-prints JSON objects and arrays', () => {
    expect(prettyPrintIfJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyPrintIfJson(' [1,2] ')).toBe('[\n  1,\n  2\n]');
  });
  it('returns non-JSON and malformed JSON verbatim', () => {
    expect(prettyPrintIfJson('SELECT * FROM t')).toBe('SELECT * FROM t');
    expect(prettyPrintIfJson('{not json}')).toBe('{not json}');
  });
});

describe('extractRetrievalIO', () => {
  it('extracts query, caption, rows, status and id lists from a DB semconv span', () => {
    const io = extractRetrievalIO(
      span({
        'db.system.name': 'opensearch',
        'db.operation.name': 'search',
        'db.namespace': 'catalog',
        'db.collection.name': 'products',
        'db.query.text': '{"query":{"match_all":{}}}',
        'db.response.returned_rows': '20',
        'db.response.status_code': '200',
        'retrieval-agent.search.hit_ids': "['p1', 'p2']",
      })
    );
    expect(io.system).toBe('opensearch');
    expect(io.operation).toBe('search');
    expect(io.target).toBe('products');
    expect(io.namespace).toBe('catalog');
    expect(io.caption).toBe('search products (opensearch)');
    expect(io.queryText).toBe('{\n  "query": {\n    "match_all": {}\n  }\n}');
    expect(io.returnedRows).toBe(20);
    expect(io.statusCode).toBe('200');
    expect(io.idLists).toEqual([{ attribute: 'retrieval-agent.search.hit_ids', ids: ['p1', 'p2'], role: 'ids' }]);
    expect(io.outputText).toBe(
      ['returned_rows: 20', 'status_code: 200', 'retrieval-agent.search.hit_ids (2):', '  - p1', '  - p2'].join('\n')
    );
  });

  it('falls back to legacy db.system / db.statement and numeric rows', () => {
    const io = extractRetrievalIO(span({ 'db.system': 'postgresql', 'db.statement': 'SELECT id FROM users', 'db.response.returned_rows': 3 }));
    expect(io.system).toBe('postgresql');
    expect(io.queryText).toBe('SELECT id FROM users');
    expect(io.returnedRows).toBe(3);
    expect(io.caption).toBe('postgresql');
    expect(io.outputText).toBe('returned_rows: 3');
  });

  it('uses db.namespace as the target when there is no collection and hides the duplicate', () => {
    const io = extractRetrievalIO(span({ 'db.system.name': 'redis', 'db.operation.name': 'GET', 'db.namespace': '0' }));
    expect(io.target).toBe('0');
    expect(io.namespace).toBeNull();
    expect(io.caption).toBe('GET 0 (redis)');
  });

  it('serialises a structured (object) query text', () => {
    const io = extractRetrievalIO(span({ 'db.system.name': 'mongodb', 'db.query.text': { find: 'users' } }));
    expect(io.queryText).toBe('{\n  "find": "users"\n}');
  });

  it('returns nulls for a span without any DB attributes', () => {
    const io = extractRetrievalIO(span({ 'gen_ai.operation.name': 'chat' }));
    expect(io).toEqual({
      system: null,
      operation: null,
      target: null,
      namespace: null,
      caption: null,
      queryText: null,
      returnedRows: null,
      statusCode: null,
      idLists: [],
      outputText: null,
    });
    expect(extractRetrievalIO({ ...span({}), attributes: undefined }).queryText).toBeNull();
  });

  it('ignores unparseable returned_rows', () => {
    expect(extractRetrievalIO(span({ 'db.system.name': 'x', 'db.response.returned_rows': 'many' })).returnedRows).toBeNull();
  });
});

describe('getKeyAttributes for DB spans', () => {
  it('keeps TOOL key attributes on a hybrid execute_tool + db.* span', () => {
    const attrs = getKeyAttributes(
      span({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_index', 'db.system.name': 'opensearch' }, 'execute_tool search_index')
    );
    expect(attrs.Tool).toBe('search_index');
    expect(attrs.System).toBeUndefined();
  });

  it('surfaces system / operation / collection / namespace / rows / status', () => {
    const attrs = getKeyAttributes(
      span({
        'db.system.name': 'opensearch',
        'db.operation.name': 'search',
        'db.collection.name': 'products',
        'db.namespace': 'catalog',
        'db.response.returned_rows': '20',
        'db.response.status_code': '200',
      })
    );
    expect(attrs).toEqual({
      System: 'opensearch',
      Operation: 'search',
      Collection: 'products',
      Namespace: 'catalog',
      'Returned Rows': '20',
      'Status Code': '200',
    });
  });

  it('uses the legacy db.system value', () => {
    expect(getKeyAttributes(span({ 'db.system': 'mysql' })).System).toBe('mysql');
  });
});
