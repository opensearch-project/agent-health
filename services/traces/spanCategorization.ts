/**
 * Span Categorization Service
 *
 * Categorizes spans based on OTel GenAI semantic conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */

import { Span, SpanCategory, CategorizedSpan, OTelComplianceResult } from '@/types';

/**
 * OTel operation names that map to AGENT category
 */
const AGENT_OPERATIONS = ['create_agent', 'invoke_agent'];

/**
 * OTel operation names that map to LLM category
 */
const LLM_OPERATIONS = ['chat', 'text_completion', 'generate_content'];

/**
 * OTel operation names that map to TOOL category
 */
const TOOL_OPERATIONS = ['execute_tool'];

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
 * Determine span category based on OTel gen_ai.operation.name attribute,
 * with fallback to name-based pattern matching for legacy agents (e.g., Pulsar).
 */
export function getSpanCategory(span: Span): SpanCategory {
  // Error status takes precedence
  if (span.status === 'ERROR') {
    return 'ERROR';
  }

  // 1. Standards-first: OTel GenAI semantic conventions
  const operationName = span.attributes?.['gen_ai.operation.name'];

  if (operationName) {
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

  // 2. Fallback: Name-based pattern matching (for Pulsar, legacy agents)
  const name = span.name?.toLowerCase() || '';

  // LLM patterns - check first as they're most specific
  if (name.includes('bedrock') || name.includes('converse') || name.includes('callmodel') || name.includes('llm')) {
    return 'LLM';
  }

  // Tool patterns - check before agent since tool spans may contain 'agent' prefix
  if (name.includes('executetool') || name.includes('tool.execute')) {
    return 'TOOL';
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
  const operationName = attrs['gen_ai.operation.name'] || '';

  switch (category) {
    case 'AGENT': {
      const agentName = attrs['gen_ai.agent.name'] || span.name;
      return operationName ? `${operationName} ${agentName}` : agentName;
    }

    case 'LLM': {
      const provider = attrs['gen_ai.provider.name'] || '';
      const model = attrs['gen_ai.request.model'] || '';
      // Get short model name (last part after dots)
      const shortModel = model.split('.').pop() || model;
      const parts = [operationName, provider, shortModel].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : span.name;
    }

    case 'TOOL': {
      const toolName = attrs['gen_ai.tool.name'] || span.name;
      return operationName ? `${operationName} ${toolName}` : toolName;
    }

    case 'ERROR':
    case 'OTHER':
    default:
      return span.name;
  }
}

/**
 * Categorize a single span with full metadata
 */
export function categorizeSpan(span: Span): CategorizedSpan {
  const category = getSpanCategory(span);
  const meta = getCategoryMeta(category);

  return {
    ...span,
    category,
    categoryLabel: meta.label,
    categoryColor: meta.color,
    categoryIcon: meta.icon,
    displayName: buildDisplayName(span, category),
  };
}

/**
 * Categorize an array of spans
 */
export function categorizeSpans(spans: Span[]): CategorizedSpan[] {
  return spans.map(categorizeSpan);
}

/**
 * Categorize a span tree (preserving hierarchy)
 */
export function categorizeSpanTree(spans: Span[]): CategorizedSpan[] {
  return spans.map(span => {
    const categorized = categorizeSpan(span);
    if (span.children && span.children.length > 0) {
      categorized.children = categorizeSpanTree(span.children);
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
 * Expected OTEL GenAI attributes by category
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
const EXPECTED_ATTRIBUTES: Record<SpanCategory, string[]> = {
  LLM: ['gen_ai.operation.name', 'gen_ai.request.model', 'gen_ai.system'],
  TOOL: ['gen_ai.operation.name', 'gen_ai.tool.name'],
  AGENT: ['gen_ai.operation.name', 'gen_ai.agent.name'],
  ERROR: [],  // Errors just need status
  OTHER: [],  // No expectations for OTHER
};

/**
 * Check if a span follows OTEL GenAI semantic conventions
 */
export function checkOTelCompliance(span: CategorizedSpan): OTelComplianceResult {
  const expected = EXPECTED_ATTRIBUTES[span.category] || [];
  const missing = expected.filter(attr => !span.attributes?.[attr]);

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
