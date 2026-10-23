/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  compactPreview,
  detectTabular,
  looksLikeJsonDocument,
  normalizeStepContent,
  summarizeValue,
  tryParseJsonDocument,
  typeOfValue,
  formatScalar,
  stringifyPretty,
} from '@/lib/trajectory/prettifyContent';

/** A synthetic search result the way a retrieval tool would return it. */
function makeHits(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc-${i}`,
    title: `Product ${i}`,
    price: i * 10,
    inStock: i % 2 === 0,
  }));
}

function mcpEnvelope(inner: unknown): string {
  return JSON.stringify([{ type: 'text', text: JSON.stringify(inner) }]);
}

describe('normalizeStepContent', () => {
  describe('plain JSON strings', () => {
    it('parses an object string into kind=json', () => {
      const r = normalizeStepContent('{"status":"ok","count":2}');
      expect(r.kind).toBe('json');
      expect(r.value).toEqual({ status: 'ok', count: 2 });
      expect(r.unwrapped).toEqual(['json-string']);
      expect(r.raw).toBe('{"status":"ok","count":2}');
    });

    it('parses an array string', () => {
      const r = normalizeStepContent('[1, 2, 3]');
      expect(r.kind).toBe('json');
      expect(r.value).toEqual([1, 2, 3]);
    });

    it('accepts an already-parsed object (tool args) and records no unwrap', () => {
      const r = normalizeStepContent({ index: 'products', size: 20 });
      expect(r.kind).toBe('json');
      expect(r.value).toEqual({ index: 'products', size: 20 });
      expect(r.unwrapped).toEqual([]);
      expect(r.raw).toBe(JSON.stringify({ index: 'products', size: 20 }, null, 2));
    });

    it('tolerates surrounding whitespace', () => {
      const r = normalizeStepContent('  \n{"a":1}\n ');
      expect(r.kind).toBe('json');
      expect(r.value).toEqual({ a: 1 });
    });
  });

  describe('content envelopes', () => {
    it('unwraps an MCP-style [{type:"text", text:"<json>"}] envelope into the inner object', () => {
      const inner = { status: 'ok', hits: makeHits(3) };
      const r = normalizeStepContent(mcpEnvelope(inner));
      expect(r.kind).toBe('json');
      expect(r.value).toEqual(inner);
      expect(r.unwrapped).toContain('mcp-content');
    });

    it('unwraps [{text}] items without a type field', () => {
      const r = normalizeStepContent(JSON.stringify([{ text: '{"ok":true}' }]));
      expect(r.kind).toBe('json');
      expect(r.value).toEqual({ ok: true });
      expect(r.unwrapped).toContain('mcp-content');
    });

    it('concatenates multiple text items when they are prose', () => {
      const r = normalizeStepContent(JSON.stringify([{ type: 'text', text: 'first line' }, { type: 'text', text: 'second line' }]));
      expect(r.kind).toBe('text');
      expect(r.value).toBe('first line\nsecond line');
      expect(r.unwrapped).toEqual(['json-string', 'mcp-content']);
    });

    it('does NOT treat a list whose items carry other data keys as an envelope', () => {
      const items = [{ text: 'a', score: 1 }, { text: 'b', score: 2 }, { text: 'c', score: 3 }];
      const r = normalizeStepContent(JSON.stringify(items));
      expect(r.kind).toBe('json');
      expect(r.value).toEqual(items);
      expect(r.unwrapped).not.toContain('mcp-content');
    });

    it('does NOT unwrap items whose type is not "text"', () => {
      const items = [{ type: 'image', text: 'caption' }];
      const r = normalizeStepContent(JSON.stringify(items));
      expect(r.value).toEqual(items);
      expect(r.unwrapped).toEqual(['json-string']);
    });

    it('unwraps a {content:[…]} wrapper (with envelope metadata keys)', () => {
      const r = normalizeStepContent(
        JSON.stringify({ role: 'tool', isError: false, content: [{ type: 'text', text: '{"total": 5}' }] })
      );
      expect(r.kind).toBe('json');
      expect(r.value).toEqual({ total: 5 });
      expect(r.unwrapped).toEqual(['json-string', 'content']);
    });

    it('does NOT unwrap when an error flag is set — `isError: true` is information', () => {
      const obj = { isError: true, content: [{ type: 'text', text: 'boom' }] };
      const r = normalizeStepContent(JSON.stringify(obj));
      expect(r.value).toEqual(obj);
      expect(r.unwrapped).toEqual(['json-string']);
      // …but a falsy flag is plain metadata.
      const ok = normalizeStepContent(JSON.stringify({ isError: false, content: [{ type: 'text', text: '{"n":1}' }] }));
      expect(ok.value).toEqual({ n: 1 });
    });

    it('keeps a {content:[…], data:…} object intact — the extra key carries information', () => {
      const obj = { content: [{ type: 'text', text: 'x' }], data: { a: 1 } };
      const r = normalizeStepContent(JSON.stringify(obj));
      expect(r.value).toEqual(obj);
      expect(r.unwrapped).toEqual(['json-string']);
    });

    it('unwraps an {output:"<string>"} wrapper', () => {
      const r = normalizeStepContent(JSON.stringify({ output: '{"rows": [1,2]}' }));
      expect(r.kind).toBe('json');
      expect(r.value).toEqual({ rows: [1, 2] });
      expect(r.unwrapped).toEqual(['json-string', 'output']);
    });

    it('an {output:"prose"} wrapper yields text', () => {
      const r = normalizeStepContent(JSON.stringify({ output: 'Command completed successfully.' }));
      expect(r.kind).toBe('text');
      expect(r.value).toBe('Command completed successfully.');
    });

    it('peels stacked envelopes (content → mcp list → json)', () => {
      const inner = { ok: true };
      const s = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify([{ type: 'text', text: JSON.stringify(inner) }]) }] });
      const r = normalizeStepContent(s);
      expect(r.kind).toBe('json');
      expect(r.value).toEqual(inner);
      expect(r.unwrapped).toEqual(['json-string', 'content', 'mcp-content']);
    });
  });

  describe('nested JSON strings', () => {
    it('parses string values that are themselves JSON documents', () => {
      const r = normalizeStepContent(JSON.stringify({ status: 'ok', result: '{"hits": [1, 2]}' }));
      expect(r.kind).toBe('json');
      expect(r.value).toEqual({ status: 'ok', result: { hits: [1, 2] } });
      expect(r.unwrapped).toContain('nested-json');
    });

    it('parses nested strings inside arrays', () => {
      const r = normalizeStepContent(JSON.stringify({ rows: ['{"a":1}', '{"a":2}'] }));
      expect(r.value).toEqual({ rows: [{ a: 1 }, { a: 2 }] });
    });

    it('stops at the depth limit (default 3 string hops)', () => {
      // 4 string hops deep: the innermost stays a string.
      const l4 = JSON.stringify({ leaf: true });
      const l3 = JSON.stringify({ l4 });
      const l2 = JSON.stringify({ l3 });
      const l1 = JSON.stringify({ l2 });
      const top = JSON.stringify({ l1 });
      const r = normalizeStepContent(top);
      const v = r.value as any;
      expect(typeof v.l1).toBe('object');
      expect(typeof v.l1.l2).toBe('object');
      expect(typeof v.l1.l2.l3).toBe('object');
      expect(typeof v.l1.l2.l3.l4).toBe('string');
      expect(r.truncated).toBe(true);
    });

    it('does not flag truncation when everything parsed', () => {
      const r = normalizeStepContent(JSON.stringify({ a: JSON.stringify({ b: 1 }) }));
      expect(r.truncated).toBeUndefined();
    });

    it('honours a custom maxDepth', () => {
      const s = JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ c: 1 }) }) });
      const r = normalizeStepContent(s, { maxDepth: 1 });
      const v = r.value as any;
      expect(typeof v.a).toBe('object');
      expect(typeof v.a.b).toBe('string');
    });

    it('leaves strings that only look partially like JSON (truncated previews) alone', () => {
      const preview = '{"color": [], "price": null, "description": "Make sure your ca';
      const r = normalizeStepContent(JSON.stringify({ _truncated: true, _preview: preview }));
      expect((r.value as any)._preview).toBe(preview);
      expect(r.unwrapped).not.toContain('nested-json');
    });

    it('does not parse scalar-looking strings ("42", "true") as JSON', () => {
      const r = normalizeStepContent(JSON.stringify({ a: '42', b: 'true', c: '"quoted"' }));
      expect(r.value).toEqual({ a: '42', b: 'true', c: '"quoted"' });
    });

    it('never mutates the input object', () => {
      const input = { nested: '{"x": 1}' };
      const copy = JSON.parse(JSON.stringify(input));
      normalizeStepContent(input);
      expect(input).toEqual(copy);
    });

    it('respects the node budget on very large payloads without throwing', () => {
      const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, s: `{"v": ${i}}` })) };
      const r = normalizeStepContent(big, { nodeBudget: 10 });
      expect(r.kind).toBe('json');
      // Budget exhausted early: later rows keep their string form.
      const rows = (r.value as any).rows as any[];
      expect(typeof rows[rows.length - 1].s).toBe('string');
      expect(r.truncated).toBe(true);
    });
  });

  describe('non-JSON', () => {
    it('classifies invalid JSON as text and keeps the original', () => {
      const r = normalizeStepContent('{"broken": ');
      expect(r.kind).toBe('text');
      expect(r.value).toBe('{"broken": ');
      expect(r.unwrapped).toEqual([]);
    });

    it('classifies plain prose as text', () => {
      const r = normalizeStepContent('The index has 12 shards.');
      expect(r.kind).toBe('text');
    });

    it('detects markdown', () => {
      const r = normalizeStepContent('## Summary\n\n- **bold** item\n- another');
      expect(r.kind).toBe('markdown');
      expect(r.value).toBe('## Summary\n\n- **bold** item\n- another');
    });

    it('detects markdown inside an unwrapped envelope', () => {
      const r = normalizeStepContent(mcpEnvelope('# Title\n\nSome **bold** text'));
      expect(r.kind).toBe('markdown');
      expect(r.unwrapped).toEqual(['json-string', 'mcp-content']);
    });

    it('handles empty string, null, undefined and numbers without throwing', () => {
      expect(normalizeStepContent('')).toEqual({ kind: 'text', value: '', unwrapped: [], raw: '' });
      expect(normalizeStepContent(null).kind).toBe('text');
      expect(normalizeStepContent(undefined).kind).toBe('text');
      expect(normalizeStepContent(42).kind).toBe('text');
      expect(normalizeStepContent(42).raw).toBe('42');
    });

    it('a top-level JSON scalar string stays text', () => {
      const r = normalizeStepContent('"just a quoted string"');
      expect(r.kind).toBe('text');
    });
  });
});

describe('looksLikeJsonDocument / tryParseJsonDocument', () => {
  it('gates on braces/brackets', () => {
    expect(looksLikeJsonDocument('{}')).toBe(true);
    expect(looksLikeJsonDocument('[]')).toBe(true);
    expect(looksLikeJsonDocument(' {"a":1} ')).toBe(true);
    expect(looksLikeJsonDocument('{')).toBe(false);
    expect(looksLikeJsonDocument('abc')).toBe(false);
    expect(looksLikeJsonDocument('{"a":1} trailing')).toBe(false);
  });

  it('returns undefined for invalid JSON and for scalars', () => {
    expect(tryParseJsonDocument('{oops}')).toBeUndefined();
    expect(tryParseJsonDocument('42')).toBeUndefined();
    expect(tryParseJsonDocument('[1]')).toEqual([1]);
  });
});

describe('detectTabular', () => {
  it('detects an array of homogeneous objects and lists the union of keys in order', () => {
    const t = detectTabular(makeHits(20));
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual(['id', 'title', 'price', 'inStock']);
    expect(t!.rows).toHaveLength(20);
  });

  it('requires at least 3 rows', () => {
    expect(detectTabular(makeHits(2))).toBeNull();
    expect(detectTabular(makeHits(3))).not.toBeNull();
  });

  it('rejects arrays containing non-objects', () => {
    expect(detectTabular([{ a: 1 }, { a: 2 }, 3])).toBeNull();
    expect(detectTabular([{ a: 1 }, { a: 2 }, null])).toBeNull();
    expect(detectTabular([1, 2, 3])).toBeNull();
  });

  it('accepts rows sharing ≥50% of the union keys (sparse but similar)', () => {
    const rows = [
      { id: 1, title: 'a', price: 1, extra: true },
      { id: 2, title: 'b' },
      { id: 3, title: 'c', price: 3 },
    ];
    const t = detectTabular(rows);
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual(['id', 'title', 'price', 'extra']);
  });

  it('rejects heterogeneous rows (one row has <50% of the union keys)', () => {
    const rows = [
      { a: 1, b: 2, c: 3, d: 4 },
      { a: 1, b: 2, c: 3, d: 4 },
      { z: 9 },
    ];
    expect(detectTabular(rows)).toBeNull();
  });

  it('rejects when the union of keys is too wide to read as a table', () => {
    const wide = Array.from({ length: 3 }, (_, r) =>
      Object.fromEntries(Array.from({ length: 40 }, (_, c) => [`k${c}`, r]))
    );
    expect(detectTabular(wide)).toBeNull();
  });

  it('rejects an array of empty objects', () => {
    expect(detectTabular([{}, {}, {}])).toBeNull();
  });
});

describe('summarizeValue', () => {
  it('describes objects, arrays, tables and scalars', () => {
    expect(summarizeValue({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })).toBe('object · 6 keys');
    expect(summarizeValue({ a: 1 })).toBe('object · 1 key');
    expect(summarizeValue([1, 2])).toBe('array · 2 items');
    expect(summarizeValue([1])).toBe('array · 1 item');
    expect(summarizeValue(makeHits(20))).toBe('table · 20 rows × 4 cols');
    expect(summarizeValue('x'.repeat(8178))).toBe('string · 8178 chars');
    expect(summarizeValue(3)).toBe('number · 3');
    expect(summarizeValue(false)).toBe('boolean · false');
    expect(summarizeValue(null)).toBe('null');
    expect(summarizeValue(undefined)).toBe('undefined');
  });
});

describe('compactPreview', () => {
  it('shows the summary and the first keys of an object', () => {
    expect(compactPreview({ status: 'ok', index: 'products', total: 91 })).toBe('object · 3 keys · status, index, total');
  });

  it('elides after six keys', () => {
    const o = Object.fromEntries('abcdefgh'.split('').map((k) => [k, 1]));
    expect(compactPreview(o)).toBe('object · 8 keys · a, b, c, d, e, f, …');
  });

  it('shows scalar array items', () => {
    expect(compactPreview(['x', 2, true])).toBe('array · 3 items · "x", 2, true');
    expect(compactPreview([1, 2, 3, 4, 5, 6, 7])).toBe('array · 7 items · 1, 2, 3, 4, 5, …');
  });

  it('shows table columns for a homogeneous array', () => {
    expect(compactPreview(makeHits(20))).toBe('table · 20 rows × 4 cols · id, title, price, inStock');
  });

  it('shows just the summary for a mixed array of objects', () => {
    expect(compactPreview([{ a: 1 }, 2])).toBe('array · 2 items');
  });

  it('never exceeds maxLength', () => {
    const o = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`a_very_long_key_name_number_${i}`, i]));
    const p = compactPreview(o, 60);
    expect(p.length).toBeLessThanOrEqual(60);
    expect(p.endsWith('…')).toBe(true);
  });
});

describe('scalar helpers', () => {
  it('typeOfValue', () => {
    expect(typeOfValue(null)).toBe('null');
    expect(typeOfValue([])).toBe('array');
    expect(typeOfValue({})).toBe('object');
    expect(typeOfValue('s')).toBe('string');
    expect(typeOfValue(1)).toBe('number');
    expect(typeOfValue(true)).toBe('boolean');
    expect(typeOfValue(undefined)).toBe('undefined');
    expect(typeOfValue(Symbol('x'))).toBe('string');
  });

  it('formatScalar quotes strings and stringifies the rest', () => {
    expect(formatScalar('a')).toBe('"a"');
    expect(formatScalar(1)).toBe('1');
    expect(formatScalar(null)).toBe('null');
    expect(formatScalar(undefined)).toBe('undefined');
  });

  it('stringifyPretty never throws', () => {
    const cyc: any = { a: 1 };
    cyc.self = cyc;
    expect(stringifyPretty(cyc)).toBe('[object Object]');
    expect(stringifyPretty({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(stringifyPretty(undefined)).toBe('');
  });
});

describe('performance', () => {
  it('normalises 500 large envelope results well under a second', () => {
    const inner = { status: 'ok', total: 20, hits: makeHits(20).map((h) => ({ ...h, description: 'x'.repeat(200) })) };
    const s = mcpEnvelope(inner);
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) normalizeStepContent(s);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
  });
});
