/**
 * SpanNode - Custom React Flow node for span visualization
 *
 * Displays a span with category icon, name, duration bar, and status.
 * Used as the base node type for all span categories.
 */

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Bot, Zap, Wrench, AlertCircle, Circle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/services/traces/utils';
import { SpanNodeData, SpanCategory, CategorizedSpan } from '@/types';

/** Props for SpanNode component */
interface SpanNodeProps {
  data: {
    span: CategorizedSpan;
    totalDuration: number;
    [key: string]: unknown;
  };
  selected?: boolean;
}

/**
 * Category-specific styling configuration
 */
const CATEGORY_CONFIG: Record<SpanCategory, {
  icon: React.ElementType;
  borderColor: string;
  bgColor: string;
  iconColor: string;
  barColor: string;
}> = {
  AGENT: {
    icon: Bot,
    borderColor: 'border-indigo-500',
    bgColor: 'bg-indigo-500/10',
    iconColor: 'text-indigo-400',
    barColor: 'bg-indigo-500',
  },
  LLM: {
    icon: Zap,
    borderColor: 'border-purple-500',
    bgColor: 'bg-purple-500/10',
    iconColor: 'text-purple-400',
    barColor: 'bg-purple-500',
  },
  TOOL: {
    icon: Wrench,
    borderColor: 'border-amber-500',
    bgColor: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
    barColor: 'bg-amber-500',
  },
  ERROR: {
    icon: AlertCircle,
    borderColor: 'border-red-500',
    bgColor: 'bg-red-500/10',
    iconColor: 'text-red-400',
    barColor: 'bg-red-500',
  },
  OTHER: {
    icon: Circle,
    borderColor: 'border-slate-500',
    bgColor: 'bg-slate-500/10',
    iconColor: 'text-slate-400',
    barColor: 'bg-slate-500',
  },
};

/**
 * SpanNode component for React Flow
 */
function SpanNodeComponent({ data, selected }: SpanNodeProps) {
  const { span, totalDuration } = data;
  const config = CATEGORY_CONFIG[span.category];
  const Icon = config.icon;

  // Calculate duration
  const duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
  const durationPercent = totalDuration > 0
    ? Math.min((duration / totalDuration) * 100, 100)
    : 0;

  return (
    <div
      className={cn(
        'px-3 py-2 rounded-lg border-2 shadow-md transition-all',
        'min-w-[180px] max-w-[200px]',
        config.bgColor,
        config.borderColor,
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background shadow-lg',
        span.status === 'ERROR' && 'border-red-500 bg-red-500/10'
      )}
    >
      {/* Input handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2 !h-2 !bg-slate-400 !border-slate-600"
      />

      {/* Header: Icon + Category Badge */}
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} className={cn('shrink-0', config.iconColor)} />
        <Badge
          variant="outline"
          className={cn(
            'text-[9px] h-4 px-1.5 font-medium',
            config.bgColor,
            config.iconColor
          )}
        >
          {span.categoryLabel}
        </Badge>
        {span.status === 'ERROR' && (
          <Badge variant="destructive" className="text-[9px] h-4 px-1">
            ERR
          </Badge>
        )}
      </div>

      {/* Display Name */}
      <div
        className={cn(
          'text-xs font-mono truncate mb-2',
          span.status === 'ERROR' ? 'text-red-400' : 'text-foreground'
        )}
        title={span.displayName}
      >
        {span.displayName}
      </div>

      {/* Duration Bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', config.barColor)}
            style={{ width: `${Math.max(durationPercent, 5)}%` }}
          />
        </div>
        <span className="text-[9px] font-mono text-muted-foreground whitespace-nowrap">
          {formatDuration(duration)}
        </span>
      </div>

      {/* Output handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !bg-slate-400 !border-slate-600"
      />
    </div>
  );
}

// Memoize for performance
export const SpanNode = memo(SpanNodeComponent);

export default SpanNode;
