/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ViewToggle
 *
 * Toggle between Timeline and Intent view modes.
 */

import React from 'react';
import { BarChart3, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ViewMode = 'timeline' | 'flow';

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
        <BarChart3 size={14} />
        Timeline
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          viewMode === 'flow' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('flow')}
      >
        <GitBranch size={14} />
        Intent
      </Button>
    </div>
  );
};

export default ViewToggle;
