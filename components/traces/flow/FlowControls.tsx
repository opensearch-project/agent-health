/**
 * FlowControls - Custom controls for React Flow
 *
 * Provides zoom, fit view, and layout direction controls.
 */

import React from 'react';
import { useReactFlow } from '@xyflow/react';
import { ZoomIn, ZoomOut, Maximize2, ArrowDown, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FlowControlsProps {
  direction: 'TB' | 'LR';
  onDirectionChange: (direction: 'TB' | 'LR') => void;
  className?: string;
}

export const FlowControls: React.FC<FlowControlsProps> = ({
  direction,
  onDirectionChange,
  className,
}) => {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div
      className={cn(
        'absolute bottom-4 left-4 flex items-center gap-1 p-1 rounded-lg',
        'bg-background/80 backdrop-blur-sm border shadow-sm',
        className
      )}
    >
      {/* Zoom controls */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => zoomIn()}
        title="Zoom in"
      >
        <ZoomIn size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => zoomOut()}
        title="Zoom out"
      >
        <ZoomOut size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => fitView({ padding: 0.2 })}
        title="Fit view"
      >
        <Maximize2 size={14} />
      </Button>

      {/* Separator */}
      <div className="w-px h-5 bg-border mx-1" />

      {/* Layout direction toggle */}
      <Button
        variant={direction === 'TB' ? 'secondary' : 'ghost'}
        size="icon"
        className="h-7 w-7"
        onClick={() => onDirectionChange('TB')}
        title="Vertical layout"
      >
        <ArrowDown size={14} />
      </Button>
      <Button
        variant={direction === 'LR' ? 'secondary' : 'ghost'}
        size="icon"
        className="h-7 w-7"
        onClick={() => onDirectionChange('LR')}
        title="Horizontal layout"
      >
        <ArrowRight size={14} />
      </Button>
    </div>
  );
};

export default FlowControls;
