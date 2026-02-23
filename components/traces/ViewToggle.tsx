/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ViewToggle
 *
 * Toggle between Info, Trace Tree, Agent Graph, and Timeline view modes.
 */

import React from 'react';
import { Info, Network, GitBranch, GanttChart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ViewMode = 'info' | 'timeline' | 'tree' | 'flow' | 'gantt' | 'agent-map' | 'stats';

interface ViewToggleProps {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
  className?: string;
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  viewMode,
  onChange,
  className,
}) => {
  return (
    <div className={cn('flex items-center gap-1 p-1 bg-muted rounded-md', className)}>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          viewMode === 'info' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('info')}
      >
        <Info size={14} />
        Info
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          viewMode === 'timeline' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('timeline')}
      >
        <Network size={14} />
        Trace Tree
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          viewMode === 'agent-map' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('agent-map')}
      >
        <GitBranch size={14} />
        Agent Map
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          viewMode === 'gantt' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('gantt')}
      >
        <GanttChart size={14} />
        Timeline
      </Button>
    </div>
  );
};

export default ViewToggle;
