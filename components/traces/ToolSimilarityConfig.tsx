/**
 * ToolSimilarityConfig
 *
 * Dialog for configuring tool similarity grouping.
 * Users can select which argument keys define tool "sameness".
 */

import React, { useState, useMemo } from 'react';
import { Settings2, Wrench, Check, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { CategorizedSpan, ToolSimilarityConfig as ToolSimilarityConfigType, ToolGroup } from '@/types';
import { extractCommonArgKeys, groupToolSpans, getToolGroupStats } from '@/services/traces/toolSimilarity';

interface ToolSimilarityConfigProps {
  spans: CategorizedSpan[];
  config: ToolSimilarityConfigType;
  onChange: (config: ToolSimilarityConfigType) => void;
  className?: string;
}

const ToolSimilarityConfigDialog: React.FC<ToolSimilarityConfigProps> = ({
  spans,
  config,
  onChange,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [localConfig, setLocalConfig] = useState<ToolSimilarityConfigType>(config);

  // Extract available argument keys from current spans
  const availableKeys = useMemo(() => extractCommonArgKeys(spans), [spans]);

  // Preview of grouping with current config
  const { toolGroups } = useMemo(
    () => groupToolSpans(spans, localConfig),
    [spans, localConfig]
  );

  const stats = useMemo(() => getToolGroupStats(toolGroups), [toolGroups]);

  const handleToggleKey = (key: string) => {
    setLocalConfig(prev => {
      const newKeys = prev.keyArguments.includes(key)
        ? prev.keyArguments.filter(k => k !== key)
        : [...prev.keyArguments, key];
      return { ...prev, keyArguments: newKeys };
    });
  };

  const handleToggleEnabled = (enabled: boolean) => {
    setLocalConfig(prev => ({ ...prev, enabled }));
  };

  const handleApply = () => {
    onChange(localConfig);
    setOpen(false);
  };

  const handleCancel = () => {
    setLocalConfig(config);
    setOpen(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setLocalConfig(config);
    }
    setOpen(newOpen);
  };

  const hasChanges = JSON.stringify(localConfig) !== JSON.stringify(config);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-7 px-2 gap-1.5', className)}
        >
          <Settings2 size={14} />
          <span className="hidden sm:inline">Tool Grouping</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench size={18} />
            Tool Similarity Config
          </DialogTitle>
          <DialogDescription>
            Configure how tool spans are grouped. Tools with the same name and
            matching key argument values are considered "similar".
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Enable Toggle */}
          <div className="flex items-center justify-between">
            <Label htmlFor="grouping-enabled" className="text-sm font-medium">
              Enable Tool Grouping
            </Label>
            <Switch
              id="grouping-enabled"
              checked={localConfig.enabled}
              onCheckedChange={handleToggleEnabled}
            />
          </div>

          {/* Key Arguments Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Key Arguments</Label>
            <p className="text-xs text-muted-foreground">
              Select which argument keys determine tool similarity.
              Tools with matching values for selected keys are grouped together.
            </p>

            {availableKeys.length === 0 ? (
              <div className="text-sm text-muted-foreground italic py-2">
                No tool arguments found in current trace
              </div>
            ) : (
              <ScrollArea className="h-32 rounded-md border p-2">
                <div className="flex flex-wrap gap-2">
                  {availableKeys.map(key => {
                    const isSelected = localConfig.keyArguments.includes(key);
                    return (
                      <Badge
                        key={key}
                        variant={isSelected ? 'default' : 'outline'}
                        className={cn(
                          'cursor-pointer transition-colors',
                          isSelected
                            ? 'bg-amber-500 hover:bg-amber-600'
                            : 'hover:bg-muted'
                        )}
                        onClick={() => handleToggleKey(key)}
                      >
                        {isSelected && <Check size={12} className="mr-1" />}
                        {key}
                      </Badge>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>

          {/* Preview */}
          {localConfig.enabled && localConfig.keyArguments.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Preview</Label>
              <div className="rounded-md border p-3 bg-muted/30 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Total tool calls:</span>
                  <span className="font-mono">{stats.totalTools}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Unique tool groups:</span>
                  <span className="font-mono">{stats.uniqueTools}</span>
                </div>
                {stats.mostFrequent && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Most frequent:</span>
                    <span className="font-mono truncate max-w-32" title={stats.mostFrequent.toolName}>
                      {stats.mostFrequent.toolName} ({stats.mostFrequent.count}x)
                    </span>
                  </div>
                )}

                {/* Show first few groups */}
                {toolGroups.length > 0 && (
                  <div className="pt-2 border-t space-y-1">
                    <span className="text-[10px] text-muted-foreground uppercase">Groups</span>
                    {toolGroups.slice(0, 3).map((group, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 text-xs font-mono bg-background rounded px-2 py-1"
                      >
                        <Wrench size={12} className="text-amber-500 shrink-0" />
                        <span className="truncate flex-1">{group.toolName}</span>
                        <Badge variant="secondary" className="text-[10px] h-4">
                          {group.count}x
                        </Badge>
                      </div>
                    ))}
                    {toolGroups.length > 3 && (
                      <div className="text-[10px] text-muted-foreground text-center">
                        +{toolGroups.length - 3} more groups
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleCancel}>
            <X size={14} className="mr-1.5" />
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!hasChanges}>
            <Check size={14} className="mr-1.5" />
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ToolSimilarityConfigDialog;
