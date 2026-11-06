/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span Categorization Service
 *
 * Categorizes spans based on OTel GenAI semantic conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */

import { Span, SpanCategory, CategorizedSpan, OTelComplianceResult } from '@/types';
import { debug } from '@/lib/debug';
import {
  // Attribute names
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  // OTel DB semconv (stable + legacy)
  ATTR_DB_SYSTEM_NAME,
  ATTR_DB_SYSTEM,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_NAMESPACE,
  ATTR_DB_COLLECTION_NAME,
  // OTel HTTP semconv (stable + legacy)
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_METHOD,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_HTTP_TARGET,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_STATUS_CODE,
  // Operation name values
  GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from '@opentelemetry/semantic-conventions/incubating';

/**
 * OTel operation names that map to AGENT category
 */
const AGENT_OPERATIONS = [
  GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
];

/**
 * OTel operation names that map to LLM category
 */
const LLM_OPERATIONS = [
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
];

/**
 * OTel operation names that map to TOOL category
 */
const TOOL_OPERATIONS = [GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL];

/**
 * A span is a database / search client call when it carries the OTel DB
 * semconv system attribute (stable `db.system.name`, or legacy `db.system`).
 * @see https://opentelemetry.io/docs/specs/semconv/db/db-spans/
 */
export function isDbSpan(span: Span): boolean {
  const attrs = span.attributes || {};
  return Boolean(attrs[ATTR_DB_SYSTEM_NAME] || attrs[ATTR_DB_SYSTEM]);
}

/**
 * True when the span carries GenAI context beyond `gen_ai.operation.name`
 * (a provider / system / agent identity). Used to classify framework-specific
 * operation names (e.g. an agent-loop iteration span) as AGENT orchestration
 * rather than OTHER.
 */
function hasGenAiContext(attrs: Record<string, any>): boolean {
  return Boolean(
    attrs[ATTR_GEN_AI_PROVIDER_NAME] || attrs[ATTR_GEN_AI_SYSTEM] || attrs[ATTR_GEN_AI_AGENT_NAME]
  );
}

/**
 * A span with an unknown operation name that nevertheless reports a model or
 * token usage is a model call, not orchestration — e.g. a provider-specific
 * `gen_ai.operation.name` such as `rerank` or `moderation`.
 */
function hasModelCallSignals(attrs: Record<string, any>): boolean {
  return Boolean(
    attrs[ATTR_GEN_AI_REQUEST_MODEL] ||
    attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS] !== undefined ||
    attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] !== undefined
  );
}

/**
 * Strict check of the persisted span kind (`attributes.spanKind`). Accepts
 * exactly the OTLP enum name `SPAN_KIND_SERVER` (what the OpenSearch and OTLP
 * ingest paths store), the OTel API name `SERVER`, or the numeric OTLP code 2.
 * Anything else — including look-alikes such as `API_SERVER` — is not SERVER.
 */
function isServerKind(attrs: Record<string, any>): boolean {
  const kind = attrs['spanKind'];
  if (kind === 2) return true;
  if (typeof kind !== 'string') return false;
  const upper = kind.toUpperCase();
  return upper === 'SPAN_KIND_SERVER' || upper === 'SERVER';
}

/**
 * An entrypoint span is the inbound request boundary of the agent service: an
 * HTTP SERVER span (`http.request.method`, or legacy `http.method`, with
 * kind SERVER) that has no HTTP SERVER ancestor in the tree — i.e. the
 * outermost request of this trace. Nested server spans (an agent calling
 * another instrumented service in-process) are not entrypoints. Such spans
 * are the agent invocation itself, so they are categorised as AGENT — but
 * their wall-clock duration is the whole request, so consumers attributing
 * time per category should only count their SELF time (the `isEntrypoint`
 * flag on `CategorizedSpan` signals this).
 *
 * Note: the eval `test_case` span is usually the W3C parent of this span, so
 * "has no parent" is deliberately NOT part of the check.
 *
 * @param ancestors - the span's ancestors (root first) when the caller knows
 *   the tree; omitted for flat / per-span callers.
 */
export function isEntrypointSpan(span: Span, ancestors: readonly Span[] = []): boolean {
  if (!isHttpServerSpan(span)) return false;
  return !ancestors.some(isHttpServerSpan);
}

/** HTTP semconv SERVER span: an HTTP method attribute + kind SERVER. */
export function isHttpServerSpan(span: Span): boolean {
  const attrs = span.attributes || {};
  const hasHttpMethod = Boolean(attrs[ATTR_HTTP_REQUEST_METHOD] || attrs[ATTR_HTTP_METHOD]);
  return hasHttpMethod && isServerKind(attrs);
}

/**
 * Category metadata (color, icon, label)
 */
interface CategoryMeta {
  color: string;      // Tailwind color class
  bgColor: string;    // Background color class for badges
  icon: string;       // lucide-react icon name
  label: string;      // Display label
}

const CATEGORY_META: Record<SpanCategory, CategoryMeta> = {
  AGENT: {
    color: 'text-indigo-400',
    bgColor: 'bg-indigo-500/20',
    icon: 'Bot',
    label: 'Agent',
  },
  LLM: {
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
    icon: 'Zap',
    label: 'LLM',
  },
  TOOL: {
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
    icon: 'Wrench',
    label: 'Tool',
  },
  RETRIEVAL: {
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
    icon: 'Database',
    label: 'Retrieval',
  },
  EVAL: {
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20',
    icon: 'ClipboardCheck',
    label: 'Eval',
  },
  ERROR: {
    color: 'text-red-400',
    bgColor: 'bg-red-500/20',
    icon: 'AlertCircle',
    label: 'Error',
  },
  OTHER: {
    color: 'text-slate-400',
    bgColor: 'bg-slate-500/20',
    icon: 'Circle',
    label: 'Other',
  },
};

/**
 * Get category metadata for a given category
 */
export function getCategoryMeta(category: SpanCategory): CategoryMeta {
  return CATEGORY_META[category];
}

/**
 * Determine span category, standards-first:
 *
 *  0. `status === 'ERROR'`                       → ERROR
 *  1. OTel GenAI `gen_ai.operation.name` with a **known** value
 *                                                → EVAL / AGENT / LLM / TOOL
 *     A span the instrumentation explicitly declared as a tool / model / agent
 *     operation keeps that meaning even if it also carries `db.*` attributes
 *     (a tool that IS the database call stays in tool stats and similarity
 *     grouping; its DB details are still surfaced in the span detail views).
 *  2. OTel DB semconv (`db.system.name` / legacy `db.system`) → RETRIEVAL —
 *     the span's own leaf semantic when no known GenAI operation claims it.
 *  3. Unknown (framework-specific) `gen_ai.operation.name` **with** GenAI
 *     context (`gen_ai.provider.name` / `gen_ai.system` / `gen_ai.agent.name`):
 *       - reporting a model or token usage      → LLM (a model call)
 *       - otherwise                              → AGENT (orchestration)
 *     An unknown value without that context falls through to (5).
 *  4. HTTP SERVER span (inbound request boundary)  → AGENT (see isEntrypointSpan)
 *  5. Name-based pattern matching for legacy agents (e.g. Langgraph)
 *  6. Otherwise                                   → OTHER ("we do not know")
 */
export function getSpanCategory(span: Span): SpanCategory {
  // Error status takes precedence
  if (span.status === 'ERROR') {
    return 'ERROR';
  }

  const attrs = span.attributes || {};

  // 1. Standards-first: a known OTel GenAI operation is authoritative
  const operationName = attrs[ATTR_GEN_AI_OPERATION_NAME];

  if (operationName) {
    if (operationName === 'evaluation') {
      return 'EVAL';
    }
    if (AGENT_OPERATIONS.includes(operationName)) {
      return 'AGENT';
    }
    if (LLM_OPERATIONS.includes(operationName)) {
      return 'LLM';
    }
    if (TOOL_OPERATIONS.includes(operationName)) {
      return 'TOOL';
    }
  }

  // 2. OTel DB semantic conventions — the span's own leaf semantic
  if (isDbSpan(span)) {
    return 'RETRIEVAL';
  }

  // 3. Framework-specific operation name that still identifies itself as GenAI
  if (operationName && hasGenAiContext(attrs)) {
    return hasModelCallSignals(attrs) ? 'LLM' : 'AGENT';
  }

  // 4. Inbound HTTP request boundary of the agent service
  if (isHttpServerSpan(span)) {
    return 'AGENT';
  }

  // 5. Fallback: Name-based pattern matching (for Langgraph, legacy agents)
  const name = span.name?.toLowerCase() || '';

  // LLM patterns - check first as they're most specific
  if (name.includes('bedrock') || name.includes('converse') || name.includes('callmodel') || name.includes('llm')) {
    return 'LLM';
  }

  // Tool patterns - check before agent since tool spans may contain 'agent' prefix
  if (name.includes('executetool') || name.includes('tool.execute')) {
    return 'TOOL';
  }

  // Eval patterns - evaluation spans from agent-health telemetry
  if (name.includes('test_suite_run') || name.includes('test_case')) {
    return 'EVAL';
  }

  // Agent patterns - root spans, orchestration, and internal processing
  if (name.includes('agent.run') || name.includes('invoke_agent') ||
      name.includes('generateresponse') || name.includes('processinput')) {
    return 'AGENT';
  }

  return 'OTHER';
}

/**
 * Build display name for a span using OTel attributes
 */
export function buildDisplayName(span: Span, category: SpanCategory): string {
  const attrs = span.attributes || {};
  const operationName = attrs[ATTR_GEN_AI_OPERATION_NAME] || '';

  switch (category) {
    case 'AGENT': {
      const agentName = attrs[ATTR_GEN_AI_AGENT_NAME] || span.name;
      return operationName ? `${operationName} ${agentName}` : agentName;
    }

    case 'LLM': {
      const provider = attrs[ATTR_GEN_AI_PROVIDER_NAME] || '';
      const model = attrs[ATTR_GEN_AI_REQUEST_MODEL] || '';
      // Get short model name (last part after dots)
      const shortModel = model.split('.').pop() || model;
      const parts = [operationName, provider, shortModel].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : span.name;
    }

    case 'TOOL': {
      const toolName = attrs[ATTR_GEN_AI_TOOL_NAME] || span.name;
      return operationName ? `${operationName} ${toolName}` : toolName;
    }

    case 'RETRIEVAL': {
      // OTel DB span-name convention: `{db.operation.name} {target}` where the
      // target is the collection (table / index) or, failing that, the namespace.
      const op = attrs[ATTR_DB_OPERATION_NAME] || '';
      const target = attrs[ATTR_DB_COLLECTION_NAME] || attrs[ATTR_DB_NAMESPACE] || '';
      const parts = [op, target].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : span.name;
    }

    case 'EVAL': {
      const testName = attrs['test.case.name'] || attrs['test.suite.name'] || '';
      return testName ? `evaluation ${testName}` : span.name;
    }

    case 'ERROR':
    case 'OTHER':
    default:
      return span.name;
  }
}

/**
 * The category-derived fields added to a span by categorization. Shared by
 * `categorizeSpan` and the single-pass `preprocessSpanTree` so both produce
 * identical metadata.
 *
 * @param ancestors - the span's ancestors when categorizing a tree (used to
 *   decide `isEntrypoint`: only the outermost HTTP SERVER span qualifies).
 */
export function buildCategoryFields(
  span: Span,
  ancestors: readonly Span[] = []
): Pick<CategorizedSpan, 'category' | 'categoryLabel' | 'categoryColor' | 'categoryIcon' | 'displayName' | 'isEntrypoint'> {
  const category = getSpanCategory(span);
  const meta = getCategoryMeta(category);
  const fields = {
    category,
    categoryLabel: meta.label,
    categoryColor: meta.color,
    categoryIcon: meta.icon,
    displayName: buildDisplayName(span, category),
  };
  return isEntrypointSpan(span, ancestors) ? { ...fields, isEntrypoint: true } : fields;
}

/**
 * Categorize a single span with full metadata
 */
export function categorizeSpan(span: Span, ancestors: readonly Span[] = []): CategorizedSpan {
  return {
    ...span,
    ...buildCategoryFields(span, ancestors),
  };
}

/**
 * Categorize an array of spans
 */
export function categorizeSpans(spans: Span[]): CategorizedSpan[] {
  debug('SpanCategorization', 'Categorizing', spans.length, 'spans');
  return spans.map(span => categorizeSpan(span));
}

/**
 * Categorize a span tree (preserving hierarchy)
 */
export function categorizeSpanTree(spans: Span[], ancestors: readonly Span[] = []): CategorizedSpan[] {
  return spans.map(span => {
    const categorized = categorizeSpan(span, ancestors);
    if (span.children && span.children.length > 0) {
      categorized.children = categorizeSpanTree(span.children, [...ancestors, span]);
    }
    return categorized;
  });
}

/**
 * Filter spans by categories
 */
export function filterSpansByCategory(
  spans: CategorizedSpan[],
  categories: SpanCategory[]
): CategorizedSpan[] {
  if (categories.length === 0) {
    return spans;
  }

  return spans.filter(span => categories.includes(span.category));
}

/**
 * Filter span tree by categories (preserves hierarchy, hides non-matching)
 */
export function filterSpanTreeByCategory(
  spans: CategorizedSpan[],
  categories: SpanCategory[]
): CategorizedSpan[] {
  if (categories.length === 0) {
    return spans;
  }

  const filterTree = (nodes: CategorizedSpan[]): CategorizedSpan[] => {
    return nodes
      .map(span => {
        const matchesCategory = categories.includes(span.category);
        const filteredChildren = span.children
          ? filterTree(span.children as CategorizedSpan[])
          : [];

        // Include span if it matches OR if any children match
        if (matchesCategory || filteredChildren.length > 0) {
          return {
            ...span,
            children: filteredChildren.length > 0 ? filteredChildren : span.children,
          };
        }
        return null;
      })
      .filter((span): span is NonNullable<typeof span> => span !== null) as CategorizedSpan[];
  };

  return filterTree(spans);
}

/**
 * Count spans by category
 */
export function countByCategory(spans: CategorizedSpan[]): Record<SpanCategory, number> {
  const counts: Record<SpanCategory, number> = {
    AGENT: 0,
    LLM: 0,
    TOOL: 0,
    RETRIEVAL: 0,
    EVAL: 0,
    ERROR: 0,
    OTHER: 0,
  };

  const countRecursive = (nodes: CategorizedSpan[]) => {
    for (const span of nodes) {
      counts[span.category]++;
      if (span.children) {
        countRecursive(span.children as CategorizedSpan[]);
      }
    }
  };

  countRecursive(spans);
  return counts;
}

// ============ OTEL Compliance Checking ============

/**
 * Expected OTEL attributes by category. Each entry is either a single
 * attribute name or a list of alternatives (any one satisfies the expectation;
 * reported as `a|b` when all are missing).
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 * @see https://opentelemetry.io/docs/specs/semconv/db/db-spans/
 */
type ExpectedAttribute = string | string[];

const EXPECTED_ATTRIBUTES: Record<SpanCategory, ExpectedAttribute[]> = {
  LLM: [ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_REQUEST_MODEL, ATTR_GEN_AI_SYSTEM],
  TOOL: [ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_TOOL_NAME],
  AGENT: [ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_AGENT_NAME],
  // DB semconv: the system is required; a span should describe WHAT it did via
  // the query text (Recommended) or at least the operation name.
  RETRIEVAL: [ATTR_DB_SYSTEM_NAME, [ATTR_DB_QUERY_TEXT, ATTR_DB_OPERATION_NAME]],
  EVAL: [ATTR_GEN_AI_OPERATION_NAME],
  ERROR: [],  // Errors just need status
  OTHER: [],  // No expectations for OTHER
};

/**
 * Check if a span follows OTEL semantic conventions for its category
 */
export function checkOTelCompliance(span: CategorizedSpan): OTelComplianceResult {
  // The HTTP SERVER entrypoint is categorised AGENT but is an HTTP-semconv
  // span, not a GenAI one — judge it against the HTTP server-span convention
  // (method + route/path + status) instead of flagging missing gen_ai.*.
  const expected: ExpectedAttribute[] = span.isEntrypoint
    ? [
        [ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_METHOD],
        [ATTR_HTTP_ROUTE, ATTR_URL_PATH, ATTR_HTTP_TARGET],
        [ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_HTTP_STATUS_CODE],
      ]
    : EXPECTED_ATTRIBUTES[span.category] || [];
  const attrs = span.attributes || {};
  const missing = expected
    .filter(attr => (Array.isArray(attr) ? !attr.some(a => attrs[a]) : !attrs[attr]))
    .map(attr => (Array.isArray(attr) ? attr.join('|') : attr));

  return {
    isCompliant: missing.length === 0,
    missingAttributes: missing,
  };
}

/**
 * Check if any span in array has OTEL compliance warnings
 */
export function hasAnyWarnings(spans: CategorizedSpan[]): boolean {
  return spans.some(span => !checkOTelCompliance(span).isCompliant);
}
