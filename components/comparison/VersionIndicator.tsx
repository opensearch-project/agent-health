/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface VersionIndicatorProps {
  versions: string[];
  currentVersion?: string;
}

export const VersionIndicator: React.FC<VersionIndicatorProps> = ({
  versions,
  currentVersion,
}) => {
  if (versions.length <= 1) return null;

  const versionText = versions.join(' → ');

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-xs ml-2 cursor-help"
          >
            <AlertTriangle size={10} className="mr-1" />
            {currentVersion || versions[versions.length - 1]}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">Eval version changed: {versionText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
