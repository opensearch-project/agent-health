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
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { Span } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import {
  fetchRecentTraces,
  groupSpansByTrace,
} from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import { TraceFlyoutContent } from './TraceFlyoutContent';
import MetricsOverview from './MetricsOverview';
import { useSidebarCollapse } from '../Layout';

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

interface SortableHeaderProps {
  column: keyof TraceTableRow | null;
  label: string;
  currentSort: keyof TraceTableRow | null;
  sortDirection: 'asc' | 'desc';
  onSort: (column: keyof TraceTableRow) => void;
  className?: string;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({
  column,
  label,
  currentSort,
  sortDirection,
  onSort,
  className = '',
}) => {
  if (!column) {
    // Non-sortable header
    return (
      <th className={`h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background border-b ${className}`}>
        {label}
      </th>
    );
  }

  const isActive = currentSort === column;

  return (
    <th className={`h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background border-b ${className}`}>
      <button
        onClick={() => onSort(column)}
        className="flex items-center gap-1.5 hover:text-foreground transition-colors group w-full"
      >
        <span>{label}</span>
        {isActive ? (
          sortDirection === 'asc' ? (
            <ArrowUp size={14} className="text-opensearch-blue" />
          ) : (
            <ArrowDown size={14} className="text-opensearch-blue" />
          )
        ) : (
          <ArrowUpDown size={14} className="opacity-0 group-hover:opacity-40 transition-opacity" />
        )}
      </button>
    </th>
  );
};

interface TraceRowProps {
  trace: TraceTableRow;
  onSelect: () => void;
  isSelected: boolean;
}

const TraceRow: React.FC<TraceRowProps> = ({ trace, onSelect, isSelected }) => {
  return (
    <tr
      className={`border-b transition-colors cursor-pointer hover:bg-muted/50 ${isSelected ? 'bg-muted/70' : ''}`}
      onClick={onSelect}
    >
      <td className="p-4 align-middle text-xs text-muted-foreground w-[180px]">
        {trace.startTime.toLocaleString()}
      </td>
      <td className="p-4 align-middle font-mono text-xs">
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
      </td>
      <td className="p-4 align-middle">
        <span title={trace.rootSpanName}>
          {trace.rootSpanName}
        </span>
      </td>
      <td className="p-4 align-middle">
        <Badge variant="outline" className="text-xs">
          {trace.serviceName || 'unknown'}
        </Badge>
      </td>
      <td className="p-4 align-middle">
        <span className={`font-mono text-xs ${trace.duration > 5000 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
          {formatDuration(trace.duration)}
        </span>
      </td>
      <td className="p-4 align-middle text-center">
        <Badge variant="secondary" className="text-xs">
          {trace.spanCount}
        </Badge>
      </td>
      <td className="p-4 align-middle">
        <ChevronRight size={16} className="text-muted-foreground" />
      </td>
    </tr>
  );
};

// ==================== Main Component ====================

export const AgentTracesPage: React.FC = () => {
  // Sidebar collapse control
  const { isCollapsed, setIsCollapsed } = useSidebarCollapse();
  
  // Filter state with session persistence
  const [selectedAgent, setSelectedAgent] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('agentTraces.selectedAgent') || 'all';
    }
    return 'all';
  });
  const [textSearch, setTextSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [timeRange, setTimeRange] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('agentTraces.timeRange') || '1440';
    }
    return '1440';
  });

  // Loading state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Trace data
  const [spans, setSpans] = useState<Span[]>([]);
  const [allTraces, setAllTraces] = useState<TraceTableRow[]>([]); // All fetched traces
  const [displayedTraces, setDisplayedTraces] = useState<TraceTableRow[]>([]); // Currently displayed traces
  const [displayCount, setDisplayCount] = useState(100); // Number of traces to display

  // Sorting state
  const [sortColumn, setSortColumn] = useState<keyof TraceTableRow | null>('startTime');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Flyout state
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<TraceTableRow | null>(null);

  // Scroll state for hiding container header
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

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
    { value: '15', label: 'Last 15m' },
    { value: '60', label: 'Last 1hr' },
    { value: '180', label: 'Last 3hr' },
    { value: '360', label: 'Last 6hr' },
    { value: '720', label: 'Last 12hr' },
    { value: '1440', label: 'Last 1d' },
    { value: '4320', label: 'Last 3d' },
    { value: '10080', label: 'Last 7d' },
  ];

  // Debounce text search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(textSearch);
    }, 500);
    return () => clearTimeout(timer);
  }, [textSearch]);

  // Persist filter selections to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('agentTraces.selectedAgent', selectedAgent);
    }
  }, [selectedAgent]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('agentTraces.timeRange', timeRange);
    }
  }, [timeRange]);

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
    });
  }, []);

  // Sort traces based on current sort column and direction
  const sortTraces = useCallback((traces: TraceTableRow[]): TraceTableRow[] => {
    if (!sortColumn) return traces;

    return [...traces].sort((a, b) => {
      let aValue: any = a[sortColumn];
      let bValue: any = b[sortColumn];

      // Handle date comparison
      if (sortColumn === 'startTime') {
        aValue = aValue.getTime();
        bValue = bValue.getTime();
      }

      // Handle string comparison (case-insensitive)
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      // Compare values
      let comparison = 0;
      if (aValue < bValue) comparison = -1;
      if (aValue > bValue) comparison = 1;

      // Apply sort direction
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [sortColumn, sortDirection]);

  // Handle column header click for sorting
  const handleSort = (column: keyof TraceTableRow) => {
    if (sortColumn === column) {
      // Toggle direction if same column
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // New column, default to descending for time/duration, ascending for others
      setSortColumn(column);
      setSortDirection(column === 'startTime' || column === 'duration' ? 'desc' : 'asc');
    }
  };

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
      const sortedTraces = sortTraces(processedTraces);
      setAllTraces(sortedTraces);
      setDisplayedTraces(sortedTraces.slice(0, 100)); // Initially show first 100
      setDisplayCount(100);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch traces');
    } finally {
      setIsLoading(false);
    }
  }, [selectedAgent, debouncedSearch, timeRange, processSpansToTraces, sortTraces]);

  // Initial fetch and refetch on filter change
  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

  // Re-sort traces when sort column or direction changes
  useEffect(() => {
    const sortedTraces = sortTraces(allTraces);
    setDisplayedTraces(sortedTraces.slice(0, displayCount));
  }, [sortColumn, sortDirection, allTraces, displayCount, sortTraces]);

  // Handle scroll to hide/show container header
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const handleScroll = () => {
      // Hide header when scrolled more than 10px
      setIsScrolled(scrollContainer.scrollTop > 10);
    };

    scrollContainer.addEventListener('scroll', handleScroll);
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, []);

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
          const sortedTraces = sortTraces(allTraces);
          setDisplayedTraces(sortedTraces.slice(0, nextCount));
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
  }, [displayCount, allTraces, sortTraces]);

  // Handle trace selection
  const handleSelectTrace = (trace: TraceTableRow) => {
    // If flyout is already open, just update the selected trace (no close/reopen flash)
    // If flyout is closed, open it with the selected trace and collapse the sidebar
    setSelectedTrace(trace);
    if (!flyoutOpen) {
      setFlyoutOpen(true);
      // Collapse sidebar when opening flyout for more screen space
      setIsCollapsed(true);
    }
  };

  // Close flyout
  const handleCloseFlyout = () => {
    setFlyoutOpen(false);
    setSelectedTrace(null);
  };

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

  // Calculate time series data for errors and requests
  const { errorTimeSeries, requestTimeSeries } = useMemo(() => {
    if (allTraces.length === 0) {
      return {
        errorTimeSeries: [],
        requestTimeSeries: [],
      };
    }

    // Create 20 time buckets for the selected time range
    const numBuckets = 20;
    const now = Date.now();
    const timeRangeMs = parseInt(timeRange) * 60 * 1000;
    const bucketSize = timeRangeMs / numBuckets;

    const errorBuckets = Array(numBuckets).fill(0);
    const requestBuckets = Array(numBuckets).fill(0);

    allTraces.forEach(trace => {
      const traceTime = trace.startTime.getTime();
      const bucketIndex = Math.floor((now - traceTime) / bucketSize);
      const reversedIndex = numBuckets - 1 - bucketIndex;

      if (reversedIndex >= 0 && reversedIndex < numBuckets) {
        requestBuckets[reversedIndex]++;
        if (trace.hasErrors) {
          errorBuckets[reversedIndex]++;
        }
      }
    });

    return {
      errorTimeSeries: errorBuckets.map((count, idx) => ({
        timestamp: new Date(now - (numBuckets - idx) * bucketSize),
        value: count,
      })),
      requestTimeSeries: requestBuckets.map((count, idx) => ({
        timestamp: new Date(now - (numBuckets - idx) * bucketSize),
        value: count,
      })),
    };
  }, [allTraces, timeRange]);

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
    <div className="h-full flex flex-col">
      {/* Compact Header with Inline Stats and Filters */}
      <div className="px-6 pt-6 pb-4 border-b">
        {/* Single Row: Title + Stats + Filters */}
        <div className="flex items-start justify-between gap-4">
          {/* Left: Title and Description */}
          <div className="flex-shrink-0">
            <h2 className="text-2xl font-bold">Agent Traces</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Analyze agent execution traces from OTEL
            </p>
          </div>

          {/* Right: Stats and Filters with Last Updated below */}
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <div className="flex items-center gap-3">
              {/* Inline Stats */}
              <div className="flex items-center gap-2 text-sm">
                <div className="flex items-center gap-1">
                  <Activity size={13} className="text-opensearch-blue" />
                  <span className="font-semibold text-opensearch-blue">{allTraces.length}</span>
                  <span className="text-muted-foreground">traces</span>
                </div>
                <span className="text-muted-foreground">•</span>
                <div className="flex items-center gap-1">
                  <BarChart3 size={13} className="text-purple-700 dark:text-purple-400" />
                  <span className="font-semibold text-purple-700 dark:text-purple-400">{spans.length}</span>
                  <span className="text-muted-foreground">spans</span>
                </div>
                <span className="text-muted-foreground">•</span>
                <div className="flex items-center gap-1">
                  <AlertCircle size={13} className="text-red-700 dark:text-red-400" />
                  <span className="font-semibold text-red-700 dark:text-red-400">
                    {stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : 0}%
                  </span>
                  <span className="text-muted-foreground">({stats.errors}) errors</span>
                </div>
                <span className="text-muted-foreground">•</span>
                <div className="flex items-center gap-1">
                  <Clock size={13} className="text-amber-700 dark:text-amber-400" />
                  <span className="font-semibold text-amber-700 dark:text-amber-400">
                    {formatDuration(stats.avgDuration)}
                  </span>
                  <span className="text-muted-foreground">avg latency</span>
                </div>
              </div>

              {/* Search Bar - Primary Action */}
              <div className="w-[280px]">
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5B9BD5]" strokeWidth={2.5} />
                  <Input
                    placeholder="Search traces, services, spans..."
                    value={textSearch}
                    onChange={(e) => setTextSearch(e.target.value)}
                    className="pl-10 h-9 text-sm bg-background dark:bg-opensearch-blue/15 border-opensearch-blue/60 dark:border-opensearch-blue/70 focus-visible:bg-background focus-visible:border-opensearch-blue dark:focus-visible:border-opensearch-blue focus-visible:ring-opensearch-blue/30 placeholder:text-muted-foreground dark:placeholder:text-white"
                  />
                </div>
              </div>

              {/* Agent Filter */}
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger className="w-[110px] h-8 text-sm">
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

              {/* Time Range */}
              <Select value={timeRange} onValueChange={setTimeRange}>
                <SelectTrigger className="w-[90px] h-8 text-sm">
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

              {/* Refresh Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={fetchTraces}
                disabled={isLoading}
                className="h-8"
              >
                <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
              </Button>
            </div>
            
            {/* Last Updated - Below stats and filters */}
            {lastRefresh && (
              <span className="text-xs text-muted-foreground">
                Last updated: {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Metrics Overview - Trends */}
      <div className="px-6 pt-4">
        {allTraces.length > 0 && (
          <MetricsOverview
            latencyDistribution={latencyDistribution}
            errorTimeSeries={errorTimeSeries}
            requestTimeSeries={requestTimeSeries}
            totalRequests={stats.total}
            totalErrors={stats.errors}
            avgLatency={stats.avgDuration}
          />
        )}
      </div>

      {/* Error State */}
      {error && (
        <div className="px-6 pt-4">
          <Card className="bg-blue-50 dark:bg-blue-500/10 border-blue-300 dark:border-blue-500/30">
            <CardContent className="p-4 text-sm text-blue-700 dark:text-blue-400">
              <div className="flex items-start gap-3">
                <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium mb-1">No OpenSearch cluster connected</p>
                  <p className="text-xs opacity-90">
                    Connect to an OpenSearch cluster in Settings to view agent traces and execution data.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Traces Table */}
      <Card className="flex-1 flex flex-col overflow-hidden mx-6 mt-4 mb-6">
        <div ref={scrollContainerRef} className="relative flex-1 overflow-auto">
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
            <div className="relative">
              {/* Card Header - fades out on scroll, positioned above table */}
              <div 
                className={`sticky top-0 z-20 bg-background border-b py-2 px-4 transition-all duration-200 ${
                  isScrolled ? 'opacity-0 h-0 py-0 border-0 overflow-hidden' : 'opacity-100'
                }`}
              >
                <div className="text-sm font-medium flex items-center gap-2 whitespace-nowrap">
                  <Activity size={14} />
                  Traces
                  <Badge variant="secondary" className="ml-2">{allTraces.length}</Badge>
                  {displayedTraces.length < allTraces.length && (
                    <span className="text-xs text-muted-foreground ml-2">
                      (showing {displayedTraces.length})
                    </span>
                  )}
                </div>
              </div>

              {/* Table with sticky header */}
              <div className="relative">
                <table className="w-full caption-bottom text-sm">
                  <thead className={`sticky top-0 z-10 bg-background transition-shadow duration-200 ${
                    isScrolled ? 'shadow-sm' : ''
                  }`}>
                    <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                      <SortableHeader
                        column="startTime"
                        label="Start Time"
                        currentSort={sortColumn}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        className="w-[180px]"
                      />
                      <SortableHeader
                        column="traceId"
                        label="Trace ID"
                        currentSort={sortColumn}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        column="rootSpanName"
                        label="Root Span"
                        currentSort={sortColumn}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        column="serviceName"
                        label="Service"
                        currentSort={sortColumn}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        column="duration"
                        label="Duration"
                        currentSort={sortColumn}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        column="spanCount"
                        label="Spans"
                        currentSort={sortColumn}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        className="text-center"
                      />
                      <SortableHeader
                        column={null}
                        label=""
                        currentSort={sortColumn}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                      />
                    </tr>
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {displayedTraces.map((trace) => (
                      <TraceRow
                        key={trace.traceId}
                        trace={trace}
                        onSelect={() => handleSelectTrace(trace)}
                        isSelected={selectedTrace?.traceId === trace.traceId}
                      />
                    ))}
                    {/* Intersection observer target for lazy loading */}
                    {displayedTraces.length < allTraces.length && (
                      <tr ref={loadMoreRef} className="hover:bg-transparent border-b transition-colors">
                        <td colSpan={7} className="p-4 align-middle text-center py-8">
                          <div className="flex items-center justify-center gap-2 text-muted-foreground">
                            <RefreshCw size={16} className="animate-spin" />
                            <span className="text-sm">Loading more traces...</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Trace Detail Flyout - Resizable Panel */}
      {flyoutOpen && selectedTrace && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          <ResizablePanelGroup direction="horizontal" className="h-full pointer-events-none">
            {/* Left invisible panel - allows content below to be interactive */}
            <ResizablePanel 
              defaultSize={40}
              minSize={10}
              maxSize={70}
              className="pointer-events-none"
            />
            
            <ResizableHandle withHandle className="pointer-events-auto" />
            
            {/* Right panel - Flyout content */}
            <ResizablePanel 
              defaultSize={60}
              minSize={30}
              maxSize={90}
              className="bg-background border-l shadow-2xl pointer-events-auto"
            >
              <TraceFlyoutContent
                trace={selectedTrace}
                onClose={handleCloseFlyout}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  );
};

export default AgentTracesPage;
