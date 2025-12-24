/**
 * SpanTreeNode
 *
 * Individual tree node component showing span with category badge,
 * duration bar, and expand/collapse controls.
 */

import React from 'react';
import { ChevronRight, ChevronDown, Bot, Zap, Wrench, AlertCircle, Circle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { CategorizedSpan, SpanCategory } from '@/types';
import { formatDuration } from '@/services/traces/utils';
import { getCategoryMeta } from '@/services/traces';

interface SpanTreeNodeProps {
  span: CategorizedSpan;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  hasChildren: boolean;
  totalDuration: number; // Total trace duration for proportional bar
  onToggleExpand: () => void;
  onSelect: () => void;
}

/**
 * Get the icon component for a category
 */
function getCategoryIcon(category: SpanCategory): React.ReactNode {
  const iconProps = { size: 12, className: 'shrink-0' };
  switch (category) {
    case 'AGENT':
      return <Bot {...iconProps} />;
    case 'LLM':
      return <Zap {...iconProps} />;
    case 'TOOL':
      return <Wrench {...iconProps} />;
    case 'ERROR':
      return <AlertCircle {...iconProps} />;
    case 'OTHER':
    default:
      return <Circle {...iconProps} />;
  }
}

/**
 * Get tailwind bar color class for a category
 */
function getBarColor(category: SpanCategory): string {
  switch (category) {
    case 'AGENT':
      return 'bg-indigo-500';
    case 'LLM':
      return 'bg-purple-500';
    case 'TOOL':
      return 'bg-amber-500';
    case 'ERROR':
      return 'bg-red-500';
    case 'OTHER':
    default:
      return 'bg-slate-500';
  }
}

const SpanTreeNode: React.FC<SpanTreeNodeProps> = ({
  span,
  depth,
  isExpanded,
  isSelected,
  hasChildren,
  totalDuration,
  onToggleExpand,
  onSelect,
}) => {
  const meta = getCategoryMeta(span.category);
  const spanDuration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
  const durationPercent = totalDuration > 0 ? Math.min((spanDuration / totalDuration) * 100, 100) : 0;

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand();
  };

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-muted/50 transition-colors',
        isSelected && 'bg-muted/80 ring-1 ring-primary/30',
        span.status === 'ERROR' && 'bg-red-500/5'
      )}
      style={{ paddingLeft: `${depth * 20 + 8}px` }}
      onClick={onSelect}
      data-testid={`span-tree-node-${span.spanId}`}
    >
      {/* Expand/Collapse Chevron */}
      <button
        className={cn(
          'w-4 h-4 flex items-center justify-center rounded hover:bg-muted',
          !hasChildren && 'invisible'
        )}
        onClick={handleChevronClick}
        disabled={!hasChildren}
      >
        {hasChildren && (
          isExpanded ? (
            <ChevronDown size={14} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={14} className="text-muted-foreground" />
          )
        )}
      </button>

      {/* Category Badge */}
      <Badge
        variant="outline"
        className={cn(
          'h-5 px-1.5 gap-1 text-[10px] font-medium shrink-0',
          meta.bgColor,
          meta.color
        )}
      >
        {getCategoryIcon(span.category)}
        <span className="hidden sm:inline">{span.categoryLabel}</span>
      </Badge>

      {/* Span Display Name */}
      <span
        className={cn(
          'flex-1 text-xs font-mono truncate',
          span.status === 'ERROR' ? 'text-red-400' : 'text-foreground'
        )}
        title={span.displayName}
      >
        {span.displayName}
      </span>

      {/* Duration Bar */}
      <div className="w-24 h-2 bg-muted rounded-full overflow-hidden shrink-0 hidden md:block">
        <div
          className={cn('h-full rounded-full transition-all', getBarColor(span.category))}
          style={{ width: `${Math.max(durationPercent, 2)}%` }}
        />
      </div>

      {/* Duration Text */}
      <span className="text-[10px] font-mono text-muted-foreground w-16 text-right shrink-0">
        {formatDuration(spanDuration)}
      </span>

      {/* Status Badge for errors */}
      {span.status === 'ERROR' && (
        <Badge variant="destructive" className="h-4 px-1 text-[9px]">
          ERROR
        </Badge>
      )}
    </div>
  );
};

export default SpanTreeNode;
