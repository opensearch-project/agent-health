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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
} from '@/components/ui/sheet';
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
  
  // Flyout resize state - default to 60% of viewport width
  const [flyoutWidth, setFlyoutWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      return Math.floor(window.innerWidth * 0.60);
    }
    return 1300; // fallback for SSR
  });
  const [isResizing, setIsResizing] = useState(false);

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

  // Handle click outside - only close if clicking outside both table and flyout
  const handleInteractOutside = (event: Event) => {
    const target = event.target as HTMLElement;
    
    // Check if click is inside the table or flyout
    const isInsideTable = target.closest('table') !== null;
    const isInsideFlyout = target.closest('[data-flyout-content]') !== null;
    const isResizeHandle = target.closest('[data-resize-handle]') !== null;
    
    // Only close if clicking outside both table and flyout
    if (!isInsideTable && !isInsideFlyout && !isResizeHandle) {
      handleCloseFlyout();
    } else {
      // Prevent default close behavior
      event.preventDefault();
    }
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

              {/* Search Bar */}
              <div className="w-[220px]">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search"
                    value={textSearch}
                    onChange={(e) => setTextSearch(e.target.value)}
                    className="pl-8 h-8 text-sm"
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
          <Card className="bg-red-500/10 border-red-500/30">
            <CardContent className="p-4 text-sm text-red-400">
              {error}
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
                      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground w-[180px] bg-background border-b">
                        Start Time
                      </th>
                      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background border-b">
                        Trace ID
                      </th>
                      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background border-b">
                        Root Span
                      </th>
                      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background border-b">
                        Service
                      </th>
                      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background border-b">
                        Duration
                      </th>
                      <th className="h-12 px-4 text-center align-middle font-medium text-muted-foreground bg-background border-b">
                        Spans
                      </th>
                      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background border-b"></th>
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

      {/* Trace Detail Flyout */}
      <Sheet open={flyoutOpen} onOpenChange={setFlyoutOpen}>
        <SheetContent 
          side="right" 
          className="p-0 overflow-hidden"
          style={{ width: `${flyoutWidth}px`, maxWidth: `${flyoutWidth}px` }}
          onInteractOutside={handleInteractOutside}
          data-flyout-content
        >
          {/* Resize Handle */}
          <div
            onMouseDown={handleMouseDown}
            className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-opensearch-blue/50 active:bg-opensearch-blue transition-colors z-50"
            data-resize-handle
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
