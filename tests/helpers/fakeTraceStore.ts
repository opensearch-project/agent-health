/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory stand-in for the observability cluster's `client.search` over an
 * `otel-v1-apm-span-*` index, for integration tests that need the REAL query
 * builders + span attribution to run against a known span population.
 *
 * Field resolution mirrors the two index shapes agent-health reads: OSI
 * flat-@ keys (`span.attributes.gen_ai@usage@input_tokens`) are literal
 * top-level fields; dotted `attributes.*` / `resource.attributes.*` paths walk
 * the nested object; a `.keyword` sub-field on a keyword-mapped field is
 * unmapped and matches nothing; `range` on `startTime` compares ISO
 * timestamps. Supports `term`, `terms`, `range`, `bool` (must / should /
 * minimum_should_match) and the `_source` projection (exact names + `prefix.*`)
 * — exactly the DSL subset the metrics / traces services emit.
 */

export type FakeSpanDoc = Record<string, any>;

function resolveField(doc: FakeSpanDoc, field: string): unknown {
  if (field in doc) return doc[field];
  if (field.endsWith('.keyword')) return undefined;
  if (field.startsWith('attributes.')) return doc.attributes?.[field.slice('attributes.'.length)];
  if (field.startsWith('resource.attributes.')) return doc.resource?.attributes?.[field.slice('resource.attributes.'.length)];
  return doc[field];
}

export function matchesQuery(clause: any, doc: FakeSpanDoc): boolean {
  if (!clause || typeof clause !== 'object') return true;
  if (clause.term) {
    const [field, val] = Object.entries(clause.term)[0] as [string, unknown];
    return resolveField(doc, field) === val;
  }
  if (clause.terms) {
    const [field, vals] = Object.entries(clause.terms)[0] as [string, unknown[]];
    return (vals as unknown[]).includes(resolveField(doc, field) as never);
  }
  if (clause.range) {
    const [field, bounds] = Object.entries(clause.range)[0] as [string, any];
    const t = new Date(String(resolveField(doc, field))).getTime();
    if (bounds.gte !== undefined && t < new Date(bounds.gte).getTime()) return false;
    if (bounds.lte !== undefined && t > new Date(bounds.lte).getTime()) return false;
    return true;
  }
  if (clause.bool) {
    const { must = [], should = [], minimum_should_match } = clause.bool;
    const mustOk = (must as any[]).every((c) => matchesQuery(c, doc));
    const shouldOk =
      (should as any[]).length === 0 || (minimum_should_match ?? 0) === 0
        ? true
        : (should as any[]).some((c) => matchesQuery(c, doc));
    return mustOk && shouldOk;
  }
  return true;
}

/** Real-OpenSearch-like `_source` projection (exact names + `prefix.*`). */
export function applySourceProjection(doc: FakeSpanDoc, sourceFields?: string[]): FakeSpanDoc {
  if (!sourceFields || sourceFields.length === 0) return doc;
  const exact = new Set(sourceFields.filter((f) => !f.endsWith('.*')));
  const prefixes = sourceFields.filter((f) => f.endsWith('.*')).map((f) => f.slice(0, -1));
  const out: FakeSpanDoc = {};
  for (const [key, value] of Object.entries(doc)) {
    if (exact.has(key) || prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

/** Encode a dotted attribute map into OSI flat `span.attributes.<key with @>` fields. */
export function flatAttrs(attrs: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(attrs)) out[`span.attributes.${k.replace(/\./g, '@')}`] = v;
  return out;
}

/**
 * A `{ search }` client over `index`. `search` is a jest.fn so tests can
 * assert on the exact DSL the service sent.
 */
export function createFakeTraceClient(index: readonly FakeSpanDoc[]) {
  const search = jest.fn(async ({ body }: any) => {
    const hits = index.filter((d) => matchesQuery(body.query, d)).slice(0, body.size ?? 100);
    return {
      body: {
        hits: {
          hits: hits.map((doc) => ({ _source: applySourceProjection(doc, body._source) })),
          total: { value: hits.length },
        },
      },
    };
  });
  return { search };
}
