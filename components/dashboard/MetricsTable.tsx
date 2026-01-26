/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpDown, ExternalLink } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCost, formatDuration, formatTokens } from '@/services/metrics';
import { BenchmarkAgentMetrics, getAgentColor } from '@/lib/dashboardMetrics';

type SortField = 'benchmarkName' | 'agentName' | 'runCount' | 'avgPassRate' | 'avgLatencyMs' | 'avgCostUsd';
type SortDirection = 'asc' | 'desc';

interface MetricsTableProps {
  data: BenchmarkAgentMetrics[];
  onBenchmarkClick?: (benchmarkId: string) => void;
  onAgentClick?: (agentKey: string) => void;
}

export const MetricsTable: React.FC<MetricsTableProps> = ({
  data,
  onBenchmarkClick,
  onAgentClick,
}) => {
  const [sortField, setSortField] = useState<SortField>('runCount');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      let aValue: string | number;
      let bValue: string | number;

      switch (sortField) {
        case 'benchmarkName':
          aValue = a.benchmarkName.toLowerCase();
          bValue = b.benchmarkName.toLowerCase();
          break;
        case 'agentName':
          aValue = a.agentName.toLowerCase();
          bValue = b.agentName.toLowerCase();
          break;
        case 'runCount':
          aValue = a.runCount;
          bValue = b.runCount;
          break;
        case 'avgPassRate':
          aValue = a.avgPassRate;
          bValue = b.avgPassRate;
          break;
        case 'avgLatencyMs':
          aValue = a.avgLatencyMs;
          bValue = b.avgLatencyMs;
          break;
        case 'avgCostUsd':
          aValue = a.avgCostUsd;
          bValue = b.avgCostUsd;
          break;
        default:
          return 0;
      }

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sortDirection === 'asc'
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }

      return sortDirection === 'asc'
        ? (aValue as number) - (bValue as number)
        : (bValue as number) - (aValue as number);
    });
  }, [data, sortField, sortDirection]);

  const SortableHeader = ({
    field,
    children,
    className,
  }: {
    field: SortField;
    children: React.ReactNode;
    className?: string;
  }) => (
    <TableHead className={className}>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8 data-[state=open]:bg-accent"
        onClick={() => handleSort(field)}
      >
        {children}
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    </TableHead>
  );

  if (data.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No benchmark data available. Run some benchmarks to see metrics here.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHeader field="benchmarkName">Benchmark</SortableHeader>
          <SortableHeader field="agentName">Agent</SortableHeader>
          <SortableHeader field="runCount" className="text-right">
            Runs
          </SortableHeader>
          <SortableHeader field="avgPassRate" className="text-right">
            Pass Rate
          </SortableHeader>
          <SortableHeader field="avgLatencyMs" className="text-right">
            Latency
          </SortableHeader>
          <SortableHeader field="avgCostUsd" className="text-right">
            Cost
          </SortableHeader>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedData.map((row) => (
          <TableRow key={`${row.benchmarkId}-${row.agentKey}`}>
            <TableCell>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onBenchmarkClick?.(row.benchmarkId)}
                  className="font-medium hover:underline cursor-pointer text-left"
                >
                  {row.benchmarkName}
                </button>
                <Link
                  to={`/benchmarks/${row.benchmarkId}/runs`}
                  className="text-muted-foreground hover:text-foreground"
                  title="Go to benchmark runs"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </div>
            </TableCell>
            <TableCell>
              <button
                onClick={() => onAgentClick?.(row.agentKey)}
                className="cursor-pointer"
              >
                <Badge
                  variant="outline"
                  className="font-normal"
                  style={{
                    borderColor: getAgentColor(row.agentKey),
                    color: getAgentColor(row.agentKey),
                  }}
                >
                  {row.agentName}
                </Badge>
              </button>
            </TableCell>
            <TableCell className="text-right font-mono">{row.runCount}</TableCell>
            <TableCell className="text-right">
              <PassRateBadge passRate={row.avgPassRate} />
            </TableCell>
            <TableCell className="text-right font-mono text-muted-foreground">
              {row.avgLatencyMs > 0 ? formatDuration(row.avgLatencyMs) : '—'}
            </TableCell>
            <TableCell className="text-right font-mono text-muted-foreground">
              {row.avgCostUsd > 0 ? formatCost(row.avgCostUsd) : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/**
 * Badge component for displaying pass rate with color coding
 */
const PassRateBadge: React.FC<{ passRate: number }> = ({ passRate }) => {
  if (passRate === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  let className = '';
  if (passRate >= 80) {
    className = 'bg-green-900/30 text-green-400 border-green-800/50';
  } else if (passRate >= 50) {
    className = 'bg-yellow-900/30 text-yellow-400 border-yellow-800/50';
  } else {
    className = 'bg-red-900/30 text-red-400 border-red-800/50';
  }

  return (
    <Badge variant="outline" className={`font-mono ${className}`}>
      {passRate.toFixed(0)}%
    </Badge>
  );
};
