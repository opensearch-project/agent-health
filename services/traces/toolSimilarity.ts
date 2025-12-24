/**
 * Tool Similarity Service
 *
 * Groups tool spans by name + configurable key arguments.
 * This allows users to see "similar" tool invocations grouped together.
 */

import { CategorizedSpan, ToolSimilarityConfig, ToolGroup } from '@/types';

/**
 * Extract all unique argument keys from tool spans.
 * Used to populate the config UI with available options.
 */
export function extractCommonArgKeys(spans: CategorizedSpan[]): string[] {
  const keySet = new Set<string>();

  const collectKeys = (spanList: CategorizedSpan[]) => {
    for (const span of spanList) {
      // Only process TOOL category spans
      if (span.category === 'TOOL') {
        // Check for tool arguments in attributes
        const toolArgs = span.attributes?.['gen_ai.tool.args'];
        if (toolArgs) {
          try {
            const argsObj = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
            if (argsObj && typeof argsObj === 'object') {
              Object.keys(argsObj).forEach(key => keySet.add(key));
            }
          } catch {
            // If parsing fails, try to extract keys from the string representation
          }
        }

        // Also check for input attributes that might contain args
        const input = span.attributes?.['gen_ai.tool.input'];
        if (input) {
          try {
            const inputObj = typeof input === 'string' ? JSON.parse(input) : input;
            if (inputObj && typeof inputObj === 'object') {
              Object.keys(inputObj).forEach(key => keySet.add(key));
            }
          } catch {
            // Ignore parsing errors
          }
        }
      }

      // Recursively process children
      if (span.children && span.children.length > 0) {
        collectKeys(span.children as CategorizedSpan[]);
      }
    }
  };

  collectKeys(spans);
  return Array.from(keySet).sort();
}

/**
 * Get tool arguments from a span's attributes
 */
function getToolArgs(span: CategorizedSpan): Record<string, unknown> {
  const toolArgs = span.attributes?.['gen_ai.tool.args'];
  if (toolArgs) {
    try {
      return typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
    } catch {
      return {};
    }
  }

  const input = span.attributes?.['gen_ai.tool.input'];
  if (input) {
    try {
      return typeof input === 'string' ? JSON.parse(input) : input;
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Get the tool name from a span
 */
function getToolName(span: CategorizedSpan): string {
  return (
    span.attributes?.['gen_ai.tool.name'] as string ||
    span.name ||
    'unknown_tool'
  );
}

/**
 * Create a group key from tool name and key arg values
 */
function createGroupKey(toolName: string, keyArgsValues: Record<string, unknown>): string {
  const sortedKeys = Object.keys(keyArgsValues).sort();
  const valueParts = sortedKeys.map(k => `${k}=${JSON.stringify(keyArgsValues[k])}`);
  return `${toolName}::${valueParts.join('::')}`;
}

/**
 * Group tool spans by name + key argument values.
 * Non-tool spans are returned ungrouped.
 */
export function groupToolSpans(
  spans: CategorizedSpan[],
  config: ToolSimilarityConfig
): { groupedSpans: CategorizedSpan[]; toolGroups: ToolGroup[] } {
  if (!config.enabled || config.keyArguments.length === 0) {
    return { groupedSpans: spans, toolGroups: [] };
  }

  const groups = new Map<string, ToolGroup>();
  const resultSpans: CategorizedSpan[] = [];

  const processSpans = (spanList: CategorizedSpan[], depth: number): CategorizedSpan[] => {
    const processed: CategorizedSpan[] = [];

    for (const span of spanList) {
      if (span.category === 'TOOL') {
        const toolName = getToolName(span);
        const allArgs = getToolArgs(span);

        // Extract only the key arguments
        const keyArgsValues: Record<string, unknown> = {};
        for (const key of config.keyArguments) {
          if (key in allArgs) {
            keyArgsValues[key] = allArgs[key];
          }
        }

        const groupKey = createGroupKey(toolName, keyArgsValues);

        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            toolName,
            keyArgsValues,
            spans: [],
            count: 0,
            totalDuration: 0,
            avgDuration: 0,
          });
        }

        const group = groups.get(groupKey)!;
        const duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
        group.spans.push(span);
        group.count++;
        group.totalDuration += duration;
        group.avgDuration = group.totalDuration / group.count;

        // Add span to result (still show individual spans, but they're now grouped for reference)
        processed.push(span);
      } else {
        // Non-tool span - process children recursively
        const processedSpan = { ...span };
        if (span.children && span.children.length > 0) {
          processedSpan.children = processSpans(span.children as CategorizedSpan[], depth + 1);
        }
        processed.push(processedSpan);
      }
    }

    return processed;
  };

  const processedSpans = processSpans(spans, 0);

  return {
    groupedSpans: processedSpans,
    toolGroups: Array.from(groups.values()).sort((a, b) => b.count - a.count),
  };
}

/**
 * Calculate similarity score between two tool spans (0-1).
 * Used for comparison view to identify matching tools.
 */
export function calculateToolSimilarity(
  left: CategorizedSpan,
  right: CategorizedSpan,
  config: ToolSimilarityConfig
): number {
  // Must both be tools
  if (left.category !== 'TOOL' || right.category !== 'TOOL') {
    return 0;
  }

  const leftName = getToolName(left);
  const rightName = getToolName(right);

  // Different tool names = 0 similarity
  if (leftName !== rightName) {
    return 0;
  }

  // Same tool name with no key args config = 1.0 similarity
  if (!config.enabled || config.keyArguments.length === 0) {
    return 1.0;
  }

  // Compare key argument values
  const leftArgs = getToolArgs(left);
  const rightArgs = getToolArgs(right);

  let matchingArgs = 0;
  let totalArgs = config.keyArguments.length;

  for (const key of config.keyArguments) {
    const leftVal = JSON.stringify(leftArgs[key]);
    const rightVal = JSON.stringify(rightArgs[key]);
    if (leftVal === rightVal) {
      matchingArgs++;
    }
  }

  return totalArgs > 0 ? matchingArgs / totalArgs : 1.0;
}

/**
 * Get summary statistics for tool groups
 */
export function getToolGroupStats(groups: ToolGroup[]): {
  totalTools: number;
  uniqueTools: number;
  mostFrequent: ToolGroup | null;
  longestDuration: ToolGroup | null;
} {
  const totalTools = groups.reduce((sum, g) => sum + g.count, 0);
  const uniqueTools = groups.length;
  const mostFrequent = groups.length > 0 ? groups[0] : null; // Already sorted by count desc
  const longestDuration = groups.reduce<ToolGroup | null>(
    (max, g) => (!max || g.totalDuration > max.totalDuration ? g : max),
    null
  );

  return {
    totalTools,
    uniqueTools,
    mostFrequent,
    longestDuration,
  };
}
