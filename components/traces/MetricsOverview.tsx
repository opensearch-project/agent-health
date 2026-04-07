/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MetricsOverview - Compact metrics visualization with latency, errors, and requests
 * 
 * Displays three minimal charts in a single collapsible card:
 * - Latency distribution histogram
 * - Error count over time
 * - Request count over time
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface LatencyBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

interface TimeSeriesPoint {
  timestamp: Date;
  value: number;
}

interface MetricsOverviewProps {
  latencyDistribution: LatencyBucket[];
  errorTimeSeries: TimeSeriesPoint[];
  requestTimeSeries: TimeSeriesPoint[];
  totalRequests: number;
  totalErrors: number;
  avgLatency: number;
}

export const MetricsOverview: React.FC<MetricsOverviewProps> = ({
  latencyDistribution,
  errorTimeSeries,
  requestTimeSeries,
  totalRequests,
  totalErrors,
  avgLatency,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  // Get max values for scaling
  const maxLatencyCount = Math.max(...latencyDistribution.map(b => b.count), 1);
  const maxErrors = Math.max(...errorTimeSeries.map(p => p.value), 1);
  const maxRequests = Math.max(...requestTimeSeries.map(p => p.value), 1);

  // Get color for latency bucket
  const getLatencyColor = (bucket: LatencyBucket) => {
    if (bucket.max <= 100) return 'bg-green-500';
    if (bucket.max <= 500) return 'bg-blue-500';
    if (bucket.max <= 1000) return 'bg-yellow-500';
    if (bucket.max <= 5000) return 'bg-orange-500';
    return 'bg-red-500';
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  return (
    <Card className="mb-4">
      <CardHeader 
        className="py-3 px-4 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Trends
        </CardTitle>
      </CardHeader>

      {isExpanded && (
        <CardContent className="p-4 pt-0">
          <div className="grid grid-cols-3 gap-6 divide-x divide-dashed divide-border">
            {/* Latency Distribution */}
            <div className="space-y-2 pr-6">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-muted-foreground">Latency Distribution</span>
                <span className="text-[10px] text-muted-foreground">{totalRequests} traces</span>
              </div>
              <div className="h-24 flex items-end gap-1">
                {latencyDistribution.map((bucket, idx) => (
                  <div key={idx} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full relative group">
                      <div
                        className={cn(
                          'w-full rounded-t transition-all',
                          getLatencyColor(bucket)
                        )}
                        style={{
                          height: `${(bucket.count / maxLatencyCount) * 80}px`,
                          minHeight: bucket.count > 0 ? '4px' : '0px',
                        }}
                      />
                      {bucket.count > 0 && (
                        <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                          {bucket.count}
                        </div>
                      )}
                    </div>
                    <span className="text-[9px] text-muted-foreground text-center leading-tight">
                      {bucket.label}
                    </span>
                  </div>
                ))}
              </div>
              {/* Legend */}
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-muted-foreground pt-1">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-green-500" />
                  <span>Fast</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-blue-500" />
                  <span>Normal</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-yellow-500" />
                  <span>Slow</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-orange-500" />
                  <span>V.Slow</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-red-500" />
                  <span>Critical</span>
                </div>
              </div>
            </div>

            {/* Error Count - Line Chart with Area Fill */}
            <div className="space-y-2 px-6">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-muted-foreground">Error Count</span>
                <span className="text-[10px] font-semibold text-red-500">{totalErrors} total</span>
              </div>
              <div className="h-24 relative">
                <svg className="w-full h-full" preserveAspectRatio="none">
                  {/* Area fill */}
                  <defs>
                    <linearGradient id="errorGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="rgb(239, 68, 68)" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="rgb(239, 68, 68)" stopOpacity="0.05" />
                    </linearGradient>
                  </defs>
                  <path
                    d={(() => {
                      const width = 100 / errorTimeSeries.length;
                      const points = errorTimeSeries.map((point, idx) => {
                        const x = idx * width;
                        const y = 100 - (point.value / maxErrors) * 100;
                        return `${x},${y}`;
                      }).join(' ');
                      return `M 0,100 L ${points} L 100,100 Z`;
                    })()}
                    fill="url(#errorGradient)"
                  />
                  {/* Line */}
                  <polyline
                    points={errorTimeSeries.map((point, idx) => {
                      const x = (idx / (errorTimeSeries.length - 1)) * 100;
                      const y = 100 - (point.value / maxErrors) * 100;
                      return `${x},${y}`;
                    }).join(' ')}
                    fill="none"
                    stroke="rgb(239, 68, 68)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Dots on hover */}
                  {errorTimeSeries.map((point, idx) => {
                    if (point.value === 0) return null;
                    const x = (idx / (errorTimeSeries.length - 1)) * 100;
                    const y = 100 - (point.value / maxErrors) * 100;
                    return (
                      <g key={idx}>
                        <circle
                          cx={`${x}%`}
                          cy={`${y}%`}
                          r="3"
                          fill="rgb(239, 68, 68)"
                          className="opacity-0 hover:opacity-100 transition-opacity"
                        />
                        <title>{point.value}</title>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div className="flex justify-between text-[9px] text-muted-foreground">
                <span>Earlier</span>
                <span>Now</span>
              </div>
            </div>

            {/* Request Count - Outlined Bars */}
            <div className="space-y-2 pl-6">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-muted-foreground">Request Count</span>
                <span className="text-[10px] font-semibold text-blue-500">{totalRequests} total</span>
              </div>
              <div className="h-24 flex items-end gap-0.5">
                {requestTimeSeries.map((point, idx) => (
                  <div key={idx} className="flex-1 relative group">
                    <div
                      className="w-full border-2 border-blue-500 rounded-t transition-all bg-transparent"
                      style={{
                        height: `${(point.value / maxRequests) * 80}px`,
                        minHeight: point.value > 0 ? '8px' : '0px',
                      }}
                    />
                    {point.value > 0 && (
                      <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap bg-background px-1 rounded">
                        {point.value}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[9px] text-muted-foreground">
                <span>Earlier</span>
                <span>Now</span>
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
};

export default MetricsOverview;
