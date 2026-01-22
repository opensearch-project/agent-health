/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingDown, TrendingUp, ArrowRightLeft, Minus } from 'lucide-react';
import { RowStatus } from '@/services/comparisonService';

interface ComparisonSummaryBannerProps {
  counts: Record<RowStatus, number>;
  onFilterClick?: (status: RowStatus | 'all') => void;
  activeFilter?: RowStatus | 'all';
}

export const ComparisonSummaryBanner: React.FC<ComparisonSummaryBannerProps> = ({
  counts,
  onFilterClick,
  activeFilter = 'all',
}) => {
  const total = counts.regression + counts.improvement + counts.mixed + counts.neutral;

  const items: Array<{
    status: RowStatus;
    label: string;
    icon: React.ReactNode;
    color: string;
    bgColor: string;
    borderColor: string;
  }> = [
    {
      status: 'regression',
      label: 'Regressions',
      icon: <TrendingDown size={14} />,
      color: 'text-red-400',
      bgColor: 'bg-red-500/10',
      borderColor: 'border-red-500/30',
    },
    {
      status: 'improvement',
      label: 'Improvements',
      icon: <TrendingUp size={14} />,
      color: 'text-opensearch-blue',
      bgColor: 'bg-opensearch-blue/10',
      borderColor: 'border-opensearch-blue/30',
    },
    {
      status: 'mixed',
      label: 'Mixed',
      icon: <ArrowRightLeft size={14} />,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/30',
    },
    {
      status: 'neutral',
      label: 'Unchanged',
      icon: <Minus size={14} />,
      color: 'text-muted-foreground',
      bgColor: 'bg-muted/50',
      borderColor: 'border-muted',
    },
  ];

  return (
    <Card className="bg-card/50">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium">Summary</span>
            <span className="text-xs text-muted-foreground">
              {total} eval{total !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Show All button */}
            <Badge
              variant="outline"
              className={`cursor-pointer transition-colors ${
                activeFilter === 'all'
                  ? 'bg-primary/20 border-primary text-primary'
                  : 'hover:bg-muted'
              }`}
              onClick={() => onFilterClick?.('all')}
            >
              All ({total})
            </Badge>

            {items.map((item) => (
              <Badge
                key={item.status}
                variant="outline"
                className={`cursor-pointer transition-colors flex items-center gap-1 ${item.borderColor} ${
                  activeFilter === item.status
                    ? `${item.bgColor} ${item.color}`
                    : `hover:${item.bgColor}`
                }`}
                onClick={() => onFilterClick?.(item.status)}
              >
                <span className={item.color}>{item.icon}</span>
                <span className={activeFilter === item.status ? item.color : ''}>
                  {counts[item.status]}
                </span>
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
