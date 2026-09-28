/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leaf-usage invariant for token accounting.
 *
 * Some frameworks stamp `gen_ai.usage.*` on an AGGREGATE span (e.g. an
 * `invoke_agent` span whose usage equals the sum of its `chat` children) as
 * well as on the individual LLM-call spans. Summing every span that carries
 * usage then counts those tokens twice. The rule shared by every token reader:
 *
 *   A span contributes only the usage NOT already accounted for by its
 *   descendants (same trace, via the `parentSpanId` chain):
 *
 *     counted(span) = max(0, usage(span) − Σ counted(descendants))
 *
 *   - Exact roll-up (parent == sum of children): the parent contributes 0 and
 *     is reported as a skipped aggregate; the leaves are counted once.
 *   - Parent carries usage while no descendant does: counted in full (it is
 *     the only record of that work).
 *   - Parent carries MORE than its descendants (e.g. a real request span whose
 *     nested spans only record part of the usage): the remainder is counted,
 *     so tokens are never dropped.
 *
 * Input and output tokens are attributed independently.
 */

export interface UsageSpanLike {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface AttributedUsage extends TokenUsage {
  /**
   * True when the span carried usage but ALL of it was already accounted for
   * by descendants (a pure roll-up). Such a span is not an LLM call.
   */
  isAggregate: boolean;
}

function nodeKey(traceId: string | undefined, spanId: string): string {
  return `${traceId ?? ''}:${spanId}`;
}

/**
 * Attribute token usage to spans so nested roll-ups are not double-counted.
 * `readUsage` returns a span's raw stamped usage (readers differ in the
 * attribute keys they accept).
 *
 * Spans without a `spanId` can never be identified as a parent and keep their
 * raw usage. Cycles / missing parents terminate the descendant walk.
 */
export function attributeLeafUsage<T extends UsageSpanLike>(
  spans: readonly T[],
  readUsage: (span: T) => TokenUsage,
): Map<T, AttributedUsage> {
  const childrenByParent = new Map<string, T[]>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const key = nodeKey(span.traceId, span.parentSpanId);
    const siblings = childrenByParent.get(key);
    if (siblings) siblings.push(span);
    else childrenByParent.set(key, [span]);
  }

  const raw = new Map<T, TokenUsage>();
  for (const span of spans) raw.set(span, readUsage(span));

  // subtreeCounted(span) = counted(span) + Σ subtreeCounted(children); memoised.
  const subtree = new Map<T, TokenUsage>();
  const result = new Map<T, AttributedUsage>();

  const visit = (span: T, path: Set<T>): TokenUsage => {
    const memo = subtree.get(span);
    if (memo) return memo;
    // Provisional entry breaks cycles: a span re-entered along its own path
    // contributes nothing to its ancestor's descendant total.
    if (path.has(span)) return { input: 0, output: 0 };
    path.add(span);

    const children = span.spanId ? childrenByParent.get(nodeKey(span.traceId, span.spanId)) ?? [] : [];
    let descInput = 0;
    let descOutput = 0;
    for (const child of children) {
      const c = visit(child, path);
      descInput += c.input;
      descOutput += c.output;
    }
    path.delete(span);

    const own = raw.get(span) ?? { input: 0, output: 0 };
    const counted: TokenUsage = {
      input: Math.max(0, own.input - descInput),
      output: Math.max(0, own.output - descOutput),
    };
    const hadUsage = own.input > 0 || own.output > 0;
    const hasDescendantUsage = descInput > 0 || descOutput > 0;
    result.set(span, {
      ...counted,
      isAggregate: hadUsage && hasDescendantUsage && counted.input === 0 && counted.output === 0,
    });
    const total: TokenUsage = { input: counted.input + descInput, output: counted.output + descOutput };
    subtree.set(span, total);
    return total;
  };

  for (const span of spans) visit(span, new Set());
  return result;
}

/**
 * Convenience: the spans whose usage was entirely a roll-up of descendants
 * (see {@link AttributedUsage.isAggregate}).
 */
export function findUsageAggregateSpans<T extends UsageSpanLike>(
  spans: readonly T[],
  readUsage: (span: T) => TokenUsage,
): Set<T> {
  const attributed = attributeLeafUsage(spans, readUsage);
  const out = new Set<T>();
  attributed.forEach((u, span) => { if (u.isAggregate) out.add(span); });
  return out;
}
