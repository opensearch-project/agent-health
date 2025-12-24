/**
 * ViewToggle
 *
 * Toggle between Timeline and Tree view modes.
 */

import React from 'react';
import { Activity, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ViewMode = 'timeline' | 'tree';

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
          viewMode === 'timeline' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('timeline')}
      >
        <Activity size={14} />
        Timeline
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          viewMode === 'tree' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('tree')}
      >
        <GitBranch size={14} />
        Tree
      </Button>
    </div>
  );
};

export default ViewToggle;
