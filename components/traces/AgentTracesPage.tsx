/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentTracesPage - Agent Traces Table View
 *
 * Table-based view showing agent traces from OTEL data with:
 * - Table format with trace summaries
 * - Latency histogram distribution
 * - Flyout panel for detailed trace view
 * - Input/output display for spans following OTEL conventions
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search,
  RefreshCw,
  Activity,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  ChevronRight,
  BarChart3,
  Filter,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Span, TraceSummary, TimeRange } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import {
  fetchRecentTraces,
  processSpansIntoTree,
  calculateTimeRange,
  groupSpansByTrace,
} from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import TraceVisualization from './TraceVisualization';
import ViewToggle, { ViewMode } from './ViewToggle';
import { TraceFlyoutContent } from './TraceFlyoutContent';
import { LatencyHistogram } from './LatencyHistogram';

// ==================== Types ====================

interface TraceTableRow {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  startTime: Date;
  duration: number;
  spanCount: number;
  hasErrors: boolean;
  spans: Span[];
}

// ==================== Sub-Components ====================

interface TraceRowProps {
  trace: TraceTableRow;
  onSelect: () => void;
  isSelected: boolean;
}

const TraceRow: React.FC<TraceRowProps> = ({ trace, onSelect, isSelected }) => {
  return (
    <TableRow
      className={`cursor-pointer hover:bg-muted/50 ${isSelected ? 'bg-muted/70' : ''}`}
      onClick={onSelect}
    >
      <TableCell className="font-mono text-xs">
        <div className="flex items-center gap-2">
          {trace.hasErrors ? (
            <XCircle size={14} className="text-red-700 dark:text-red-400" />
          ) : (
            <CheckCircle2 size={14} className="text-green-700 dark:text-green-400" />
          )}
          <span title={trace.traceId}>
            {trace.traceId}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <span title={trace.rootSpanName}>
          {trace.rootSpanName}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="text-xs">
          {trace.serviceName || 'unknown'}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {trace.startTime.toLocaleString()}
      </TableCell>
      <TableCell>
        <span className={`font-mono text-xs ${trace.duration > 5000 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
          {formatDuration(trace.duration)}
        </span>
      </TableCell>
      <TableCell className="text-center">
        <Badge variant="secondary" className="text-xs">
          {trace.spanCount}
        </Badge>
      </TableCell>
      <TableCell>
        <ChevronRight size={16} className="text-muted-foreground" />
      </TableCell>
    </TableRow>
  );
};

// ==================== Main Component ====================

export const AgentTracesPage: React.FC = () => {
  // Filter state
  const [selectedAgent, setSelectedAgent] = useState<string>('all');
  const [textSearch, setTextSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [timeRange, setTimeRange] = useState<string>('1440'); // Default to 1 day

  // Loading state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Trace data
  const [spans, setSpans] = useState<Span[]>([]);
  const [allTraces, setAllTraces] = useState<TraceTableRow[]>([]); // All fetched traces
  const [displayedTraces, setDisplayedTraces] = useState<TraceTableRow[]>([]); // Currently displayed traces
  const [displayCount, setDisplayCount] = useState(100); // Number of traces to display

  // Flyout state
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<TraceTableRow | null>(null);
  const [traceViewMode, setTraceViewMode] = useState<ViewMode>('timeline');
  
  // Flyout resize state
  const [flyoutWidth, setFlyoutWidth] = useState(800);
  const [isResizing, setIsResizing] = useState(false);

  // Intersection observer ref for lazy loading
  const loadMoreRef = React.useRef<HTMLTableRowElement>(null);

  // Get unique service names from agents config (no memo — recomputes when
  // parent App re-renders after refreshConfig(), keeping custom agents visible)
  const agentOptions = (() => {
    const agents = DEFAULT_CONFIG.agents
      .filter(a => a.enabled !== false)
      .map(a => ({ value: a.name, label: a.name }));
    return [{ value: 'all', label: 'All Agents' }, ...agents];
  })();

  // Time range options
  const timeRangeOptions = [
    { value: '15', label: 'Last 15 minutes' },
    { value: '60', label: 'Last hour' },
    { value: '180', label: 'Last 3 hours' },
    { value: '360', label: 'Last 6 hours' },
    { value: '720', label: 'Last 12 hours' },
    { value: '1440', label: 'Last 24 hours' },
    { value: '4320', label: 'Last 3 days' },
    { value: '10080', label: 'Last 7 days' },
  ];

  // Debounce text search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(textSearch);
    }, 500);
    return () => clearTimeout(timer);
  }, [textSearch]);

  // Convert spans to trace table rows
  const processSpansToTraces = useCallback((allSpans: Span[]): TraceTableRow[] => {
    const traceGroups = groupSpansByTrace(allSpans);

    return traceGroups.map(group => {
      const rootSpan = group.spans.find(s => !s.parentSpanId) || group.spans[0];
      const hasErrors = group.spans.some(s => s.status === 'ERROR');

      // Calculate duration from time range
      const times = group.spans.map(s => ({
        start: new Date(s.startTime).getTime(),
        end: new Date(s.endTime).getTime(),
      }));
      const minStart = Math.min(...times.map(t => t.start));
      const maxEnd = Math.max(...times.map(t => t.end));

      return {
        traceId: group.traceId,
        rootSpanName: rootSpan.name,
        serviceName: rootSpan.attributes?.['service.name'] || 'unknown',
        startTime: new Date(minStart),
        duration: maxEnd - minStart,
        spanCount: group.spans.length,
        hasErrors,
        spans: group.spans,
      };
    }).sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  }, []);

  // Fetch traces
  const fetchTraces = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchRecentTraces({
        minutesAgo: parseInt(timeRange),
        serviceName: selectedAgent !== 'all' ? selectedAgent : undefined,
        textSearch: debouncedSearch || undefined,
        size: 1000,
      });

      if (result.warning) {
        setError(`Trace query warning: ${result.warning}`);
      }

      setSpans(result.spans);
      const processedTraces = processSpansToTraces(result.spans);
      setAllTraces(processedTraces);
      setDisplayedTraces(processedTraces.slice(0, 100)); // Initially show first 100
      setDisplayCount(100);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch traces');
    } finally {
      setIsLoading(false);
    }
  }, [selectedAgent, debouncedSearch, timeRange, processSpansToTraces]);

  // Initial fetch and refetch on filter change
  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

  // Lazy loading with intersection observer
  useEffect(() => {
    const currentRef = loadMoreRef.current;
    if (!currentRef || displayCount >= allTraces.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && displayCount < allTraces.length) {
          // Load next 100 traces
          const nextCount = Math.min(displayCount + 100, allTraces.length);
          setDisplayedTraces(allTraces.slice(0, nextCount));
          setDisplayCount(nextCount);
        }
      },
      {
        root: null,
        rootMargin: '200px', // Start loading 200px before reaching the bottom
        threshold: 0.1,
      }
    );

    observer.observe(currentRef);

    return () => {
      observer.unobserve(currentRef);
    };
  }, [displayCount, allTraces]);

  // Handle trace selection
  const handleSelectTrace = (trace: TraceTableRow) => {
    setSelectedTrace(trace);
    setFlyoutOpen(true);
  };

  // Close flyout
  const handleCloseFlyout = () => {
    setFlyoutOpen(false);
    setSelectedTrace(null);
  };

  // Resize handlers for flyout
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const newWidth = window.innerWidth - e.clientX;
      // Constrain width between 400px and 90% of window width
      const minWidth = 400;
      const maxWidth = window.innerWidth * 0.9;
      setFlyoutWidth(Math.max(minWidth, Math.min(newWidth, maxWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  // Calculate latency distribution for histogram
  const latencyDistribution = useMemo(() => {
    if (allTraces.length === 0) return [];

    // Create buckets for histogram
    const buckets = [
      { label: '<100ms', min: 0, max: 100, count: 0 },
      { label: '100-500ms', min: 100, max: 500, count: 0 },
      { label: '500ms-1s', min: 500, max: 1000, count: 0 },
      { label: '1-5s', min: 1000, max: 5000, count: 0 },
      { label: '5-10s', min: 5000, max: 10000, count: 0 },
      { label: '>10s', min: 10000, max: Infinity, count: 0 },
    ];

    allTraces.forEach(trace => {
      const bucket = buckets.find(b => trace.duration >= b.min && trace.duration < b.max);
      if (bucket) bucket.count++;
    });

    return buckets;
  }, [allTraces]);

  // Calculate stats
  const stats = useMemo(() => {
    if (allTraces.length === 0) return { total: 0, errors: 0, avgDuration: 0 };

    const errors = allTraces.filter(t => t.hasErrors).length;
    const avgDuration = allTraces.reduce((sum, t) => sum + t.duration, 0) / allTraces.length;

    return {
      total: allTraces.length,
      errors,
      avgDuration,
    };
  }, [allTraces]);

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Agent Traces</h2>
          <p className="text-xs text-muted-foreground mt-1">
            View and analyze agent execution traces from OTEL instrumentation
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-muted-foreground">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={fetchTraces}
            disabled={isLoading}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total Traces</p>
                <p className="text-2xl font-bold">{stats.total}</p>
              </div>
              <Activity className="text-opensearch-blue" size={24} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Error Rate</p>
                <p className="text-2xl font-bold text-red-700 dark:text-red-400">
                  {stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : 0}%
                </p>
              </div>
              <AlertCircle className="text-red-700 dark:text-red-400" size={24} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Avg Duration</p>
                <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">
                  {formatDuration(stats.avgDuration)}
                </p>
              </div>
              <Clock className="text-amber-700 dark:text-amber-400" size={24} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total Spans</p>
                <p className="text-2xl font-bold text-purple-700 dark:text-purple-400">{spans.length}</p>
              </div>
              <BarChart3 className="text-purple-700 dark:text-purple-400" size={24} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="flex gap-4 items-end">
            {/* Time Range */}
            <div className="w-48 space-y-1.5">
              <label className="text-xs text-muted-foreground">Time Range</label>
              <Select value={timeRange} onValueChange={setTimeRange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timeRangeOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Agent Filter */}
            <div className="w-48 space-y-1.5">
              <label className="text-xs text-muted-foreground">Agent</label>
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agentOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Text Search */}
            <div className="flex-1 space-y-1.5">
              <label className="text-xs text-muted-foreground">Search</label>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search trace IDs, span names, attributes..."
                  value={textSearch}
                  onChange={(e) => setTextSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Latency Histogram */}
      {allTraces.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart3 size={14} />
              Latency Distribution
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <LatencyHistogram data={latencyDistribution} />
          </CardContent>
        </Card>
      )}

      {/* Error State */}
      {error && (
        <Card className="mb-4 bg-red-500/10 border-red-500/30">
          <CardContent className="p-4 text-sm text-red-400">
            {error}
          </CardContent>
        </Card>
      )}

      {/* Traces Table */}
      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardHeader className="py-2 px-4 border-b">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity size={14} />
            Traces
            <Badge variant="secondary" className="ml-2">{allTraces.length}</Badge>
            {displayedTraces.length < allTraces.length && (
              <span className="text-xs text-muted-foreground ml-2">
                (showing {displayedTraces.length})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-0 overflow-auto">
          {allTraces.length === 0 && !isLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground py-12">
              <Activity size={48} className="mb-4 opacity-20" />
              <p>No traces found</p>
              <p className="text-sm mt-1">
                {selectedAgent !== 'all' || textSearch
                  ? 'Try adjusting your filters'
                  : 'Traces will appear here as agents execute'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trace ID</TableHead>
                  <TableHead>Root Span</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Start Time</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-center">Spans</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayedTraces.map((trace, index) => (
                  <TraceRow
                    key={trace.traceId}
                    trace={trace}
                    onSelect={() => handleSelectTrace(trace)}
                    isSelected={selectedTrace?.traceId === trace.traceId}
                  />
                ))}
                {/* Intersection observer target for lazy loading */}
                {displayedTraces.length < allTraces.length && (
                  <TableRow ref={loadMoreRef} className="hover:bg-transparent">
                    <TableCell colSpan={7} className="text-center py-8">
                      <div className="flex items-center justify-center gap-2 text-muted-foreground">
                        <RefreshCw size={16} className="animate-spin" />
                        <span className="text-sm">Loading more traces...</span>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Trace Detail Flyout */}
      <Sheet open={flyoutOpen} onOpenChange={setFlyoutOpen}>
        <SheetContent 
          side="right" 
          className="p-0 overflow-hidden"
          style={{ width: `${flyoutWidth}px`, maxWidth: `${flyoutWidth}px` }}
        >
          {/* Resize Handle */}
          <div
            onMouseDown={handleMouseDown}
            className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-opensearch-blue/50 active:bg-opensearch-blue transition-colors z-50"
            style={{
              background: isResizing ? 'hsl(var(--primary))' : 'transparent',
            }}
          >
            <div className="absolute left-0 top-0 bottom-0 w-4 -translate-x-1.5" />
          </div>
          
          {selectedTrace && (
            <TraceFlyoutContent
              trace={selectedTrace}
              onClose={handleCloseFlyout}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default AgentTracesPage;
