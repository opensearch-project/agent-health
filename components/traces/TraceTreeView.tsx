/**
 * TraceTreeView
 *
 * Main tree visualization component for traces.
 * Shows hierarchical execution tree with category badges.
 * Side-by-side layout: tree on left, details panel on right.
 */

import React, { useMemo, useCallback } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Span, CategorizedSpan, SpanCategory, TimeRange } from '@/types';
import {
  categorizeSpanTree,
  filterSpanTreeByCategory,
  countByCategory,
} from '@/services/traces';
import SpanTreeNode from './SpanTreeNode';
import CategoryFilterBar from './CategoryFilterBar';
import SpanDetailsPanel from './SpanDetailsPanel';

interface TraceTreeViewProps {
  spanTree: Span[];
  timeRange: TimeRange;
  selectedSpan: Span | null;
  onSelectSpan: (span: Span | null) => void;
  expandedSpans: Set<string>;
  onToggleExpand: (spanId: string) => void;
}

/**
 * Recursively render the tree
 */
function renderTree(
  nodes: CategorizedSpan[],
  depth: number,
  totalDuration: number,
  expandedSpans: Set<string>,
  selectedSpanId: string | null,
  onToggleExpand: (spanId: string) => void,
  onSelect: (span: Span) => void
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];

  for (const span of nodes) {
    const hasChildren = (span.children?.length || 0) > 0;
    const isExpanded = expandedSpans.has(span.spanId);
    const isSelected = span.spanId === selectedSpanId;

    elements.push(
      <SpanTreeNode
        key={span.spanId}
        span={span}
        depth={depth}
        isExpanded={isExpanded}
        isSelected={isSelected}
        hasChildren={hasChildren}
        totalDuration={totalDuration}
        onToggleExpand={() => onToggleExpand(span.spanId)}
        onSelect={() => onSelect(span)}
      />
    );

    // Render children if expanded
    if (hasChildren && isExpanded && span.children) {
      elements.push(
        ...renderTree(
          span.children as CategorizedSpan[],
          depth + 1,
          totalDuration,
          expandedSpans,
          selectedSpanId,
          onToggleExpand,
          onSelect
        )
      );
    }
  }

  return elements;
}

const TraceTreeView: React.FC<TraceTreeViewProps> = ({
  spanTree,
  timeRange,
  selectedSpan,
  onSelectSpan,
  expandedSpans,
  onToggleExpand,
}) => {
  const [categoryFilter, setCategoryFilter] = React.useState<SpanCategory[]>([]);

  // Categorize the span tree
  const categorizedTree = useMemo(
    () => categorizeSpanTree(spanTree),
    [spanTree]
  );

  // Count spans by category
  const categoryCounts = useMemo(
    () => countByCategory(categorizedTree),
    [categorizedTree]
  );

  // Apply category filter
  const filteredTree = useMemo(
    () => filterSpanTreeByCategory(categorizedTree, categoryFilter),
    [categorizedTree, categoryFilter]
  );

  // Handle expand all / collapse all
  const handleExpandAll = useCallback(() => {
    const allIds = new Set<string>();
    const collectIds = (nodes: CategorizedSpan[]) => {
      for (const node of nodes) {
        if (node.children && node.children.length > 0) {
          allIds.add(node.spanId);
          collectIds(node.children as CategorizedSpan[]);
        }
      }
    };
    collectIds(categorizedTree);

    // Since we don't control expandedSpans directly, we need to expand each
    // This assumes the parent component will handle this
    allIds.forEach(id => {
      if (!expandedSpans.has(id)) {
        onToggleExpand(id);
      }
    });
  }, [categorizedTree, expandedSpans, onToggleExpand]);

  const selectedSpanId = selectedSpan?.spanId || null;

  if (spanTree.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No spans to display
      </div>
    );
  }

  return (
    <div className="flex h-[500px] gap-4" data-testid="trace-tree-view">
      {/* Left side: Tree */}
      <div className="flex-1 flex flex-col min-w-0 border rounded-lg overflow-hidden">
        {/* Category Filter Bar */}
        <CategoryFilterBar
          selectedCategories={categoryFilter}
          onChange={setCategoryFilter}
          counts={categoryCounts}
          className="border-b"
        />

        {/* Tree Content */}
        <ScrollArea className="flex-1">
          <div className="py-1">
            {renderTree(
              filteredTree,
              0,
              timeRange.duration,
              expandedSpans,
              selectedSpanId,
              onToggleExpand,
              onSelectSpan
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right side: Details Panel */}
      <div className="w-[400px] shrink-0">
        {selectedSpan ? (
          <div className="h-full border rounded-lg overflow-hidden">
            <SpanDetailsPanel
              span={selectedSpan}
              onClose={() => onSelectSpan(null)}
            />
          </div>
        ) : (
          <div className="h-full border rounded-lg flex items-center justify-center text-muted-foreground text-sm bg-muted/20">
            Select a span to view details
          </div>
        )}
      </div>
    </div>
  );
};

export default TraceTreeView;
