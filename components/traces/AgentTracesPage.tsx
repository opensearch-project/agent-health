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
 * - Inline expandable trace tree (Chrome-DevTools "Inspect" style) with
 *   per-span details rendered below the tree
 * - Input/output display for spans following OTEL conventions
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { PREFS_KEYS, SharedTimeRange, sharedTimeRangeToMinutes } from '@/lib/preferences';
import {
  Search,
  RefreshCw,
  Activity,
  Check,
  CheckCircle2,
  XCircle,
  ChevronRight,
  ChevronDown,
  SlidersHorizontal,
  X,
  Copy,
  BarChart3,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Maximize2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Span } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import {
  fetchRecentTraces,
  groupSpansByTrace,
  calculateTimeRange,
  computeTraceSummary,
} from '@/services/traces';
import { formatDuration, formatCompact } from '@/services/traces/utils';
import TraceSummaryStrip from './TraceSummaryStrip';
import { processSpansIntoTree } from '@/services/traces';
import { startMeasure, endMeasure } from '@/lib/performance';
import { cn, formatRelativeTime } from '@/lib/utils';
import TraceTreeTable from './TraceTreeTable';
import SimpleSpanAttributesTable from './SimpleSpanAttributesTable';
import TraceFullScreenView from './TraceFullScreenView';
import MetricsOverview, { FilterAction } from './MetricsOverview';
import { Sheet, SheetContent } from '@/components/ui/sheet';

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
  isExpanded: boolean;
}

const TraceRow: React.FC<TraceRowProps> = ({ trace, onSelect, isSelected, isExpanded }) => {
  const [copiedField, setCopiedField] = React.useState<string | null>(null);

  const handleCopy = (e: React.MouseEvent, text: string, field: string) => {
    e.stopPropagation();
    // Fallback for non-HTTPS (localhost dev)
    const doCopy = () => {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
      }
      // Fallback: textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return Promise.resolve();
    };
    doCopy()
      .then(() => {
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 1500);
      })
      .catch((err) => console.error('Copy failed:', err));
  };

  return (
    <tr
      className={`border-b transition-colors cursor-pointer hover:bg-muted/50 group ${isSelected ? 'bg-muted/70' : ''}`}
      onClick={onSelect}
    >
      <td className="py-1.5 px-3 align-middle text-xs text-muted-foreground whitespace-nowrap">
        <span title={trace.startTime.toLocaleString()}>
          {formatRelativeTime(trace.startTime.toISOString())}
        </span>
      </td>
      <td className="py-1.5 px-3 align-middle font-mono text-xs">
        <div className="flex items-center gap-1.5">
          {trace.hasErrors ? (
            <XCircle size={12} className="text-red-700 dark:text-red-400 flex-shrink-0" />
          ) : (
            <CheckCircle2 size={12} className="text-green-700 dark:text-green-400 flex-shrink-0" />
          )}
          <span title={trace.traceId}>
            {trace.traceId.slice(0, 8)}…
          </span>
          <button
            onClick={(e) => handleCopy(e, trace.traceId, 'traceId')}
            className="relative opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted-foreground/20 flex-shrink-0"
            aria-label="Copy trace ID"
          >
            {copiedField === 'traceId' ? (
              <>
                <Check size={12} className="text-green-500" />
                <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-[10px] bg-foreground text-background px-1.5 py-0.5 rounded whitespace-nowrap">
                  Copied
                </span>
              </>
            ) : (
              <Copy size={12} className="text-muted-foreground" />
            )}
          </button>
        </div>
      </td>
      <td className="py-1.5 px-3 align-middle text-xs">
        <div className="flex items-center gap-1.5 max-w-[200px]">
          <span className="truncate" title={trace.rootSpanName}>
            {trace.rootSpanName}
          </span>
          <button
            onClick={(e) => handleCopy(e, trace.rootSpanName, 'rootSpan')}
            className="relative opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted-foreground/20 flex-shrink-0"
            aria-label="Copy root span name"
          >
            {copiedField === 'rootSpan' ? (
              <>
                <Check size={12} className="text-green-500" />
                <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-[10px] bg-foreground text-background px-1.5 py-0.5 rounded whitespace-nowrap">
                  Copied
                </span>
              </>
            ) : (
              <Copy size={12} className="text-muted-foreground" />
            )}
          </button>
        </div>
      </td>
      <td className="py-1.5 px-3 align-middle">
        <span className="text-xs text-foreground" title={trace.serviceName || 'unknown'}>
          {trace.serviceName || 'unknown'}
        </span>
      </td>
      <td className="py-1.5 px-3 align-middle">
        <span className={`font-mono text-xs ${trace.duration > 5000 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
          {formatDuration(trace.duration)}
        </span>
      </td>
      <td className="py-1.5 px-3 align-middle text-center">
        <Badge variant="secondary" className="text-[11px] py-0 px-1.5">
          {formatCompact(trace.spanCount)}
        </Badge>
      </td>
      <td className="py-1.5 px-3 align-middle">
        {isExpanded ? (
          <ChevronDown size={14} className="text-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </td>
    </tr>
  );
};

// ==================== Expanded Trace Row (inline detail) ====================

interface ExpandedTraceRowProps {
  trace: TraceTableRow;
  onClose: () => void;
}

/**
 * Renders the inline expanded view for a trace, shown directly below the
 * clicked row (Chrome DevTools "Inspect"-tab style).
 *
 * The tree is rendered inline; per-span details, however, slide up as a
 * page-level bottom drawer (so they get full horizontal width and don't
 * compete with the trace list above).
 */
const ExpandedTraceRow: React.FC<ExpandedTraceRowProps> = ({ trace, onClose }) => {
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const spanTree = useMemo(() => processSpansIntoTree(trace.spans), [trace.spans]);
  const timeRange = useMemo(() => calculateTimeRange(trace.spans), [trace.spans]);

  /**
   * Header summary — the strip above the tree shows non-redundant info
   * (i.e. things NOT already in the parent trace row): span-category
   * breakdown, error count, total token usage, and the model(s) used.
   * Trace ID, span count, and duration are intentionally omitted because
   * they're already visible in the row directly above.
   *
   * Computation lives in `services/traces/traceSummary.ts` so the
   * fullscreen header can render exactly the same numbers from the same
   * source-of-truth.
   */
  const headerSummary = useMemo(() => computeTraceSummary(spanTree), [spanTree]);

  // Auto-expand root spans on initial mount and when the trace changes.
  // Keyed on `trace.traceId` (not `spanTree`) so user-driven expand/collapse
  // toggles aren't reset if the parent happens to re-render with the same
  // logical trace.
  useEffect(() => {
    const rootIds = new Set(spanTree.map(s => s.spanId));
    setExpandedSpans(rootIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace.traceId]);

  // Reset selected span whenever trace changes
  useEffect(() => {
    setSelectedSpan(null);
  }, [trace.traceId]);

  const handleToggleExpand = useCallback((spanId: string) => {
    setExpandedSpans(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }, []);

  return (
    <tr className="bg-muted/20 border-b">
      <td colSpan={7} className="p-0">
        {/* Wrap the entire expansion in a smaller-text scope so spans inside
            one trace look visually distinct from the outer table rows. */}
        <div className="border-l-2 border-opensearch-blue bg-background text-[11px]">
          {/* Compact header — shows information NOT already visible in the
              parent trace row above (which already has root-span name,
              trace ID, span count, and duration). Instead we surface the
              category breakdown, error count, total token usage, and the
              model(s) the trace ran against. The same TraceSummaryStrip
              is reused in the fullscreen header for visual consistency. */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b bg-card">
            <TraceSummaryStrip summary={headerSummary} />
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setFullscreenOpen(true)}
                title="Open fullscreen"
                aria-label="Open trace in fullscreen view"
              >
                <Maximize2 size={12} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={onClose}
                title="Collapse"
                aria-label="Collapse expanded trace row"
              >
                <X size={12} />
              </Button>
            </div>
          </div>

          {/* Trace tree with Reddit-style L-shaped connecting lines AND a
              per-span timeline bar in the right-hand area showing each
              span's relative position/duration within the trace — fills
              the previously-empty horizontal space and gives temporal
              perspective without sacrificing the structural tree view. */}
          <div className="max-h-[480px] overflow-auto px-3 py-2 trace-inline-tree">
            <TraceTreeTable
              spanTree={spanTree}
              timeRange={timeRange}
              selectedSpan={selectedSpan}
              onSelect={setSelectedSpan}
              expandedSpans={expandedSpans}
              onToggleExpand={handleToggleExpand}
            />
          </div>
        </div>

        {/* Span details bottom drawer — slides up from the bottom of the
            page (instead of inline-below-the-tree) so it gets the full
            page width and doesn't visually compete with the trace list
            above. Mounts via Radix portal at <body>.

            When fullscreen is open we DO NOT render this inline drawer
            because the TraceFullScreenView renders its own bottom drawer
            scoped to the fullscreen overlay. Otherwise the page-level
            drawer would float on top of the fullscreen modal and the
            user would see two drawers, with the page-level one stealing
            keyboard focus / ESC handling. */}
        <Sheet
          open={selectedSpan !== null && !fullscreenOpen}
          onOpenChange={(o) => { if (!o) setSelectedSpan(null); }}
          // Non-modal so the trace tree behind the drawer stays
          // interactive — users need to keep clicking spans to swap
          // the drawer's content. Modal Radix dialogs trap focus,
          // lock body scroll, and aria-hide siblings, which made the
          // page feel unresponsive while the drawer was open.
          modal={false}
        >
          <SheetContent
            side="bottom"
            className="h-[55vh] p-0 flex flex-col"
            aria-label="Span details"
            onPointerDownOutside={(e) => {
              // The sheet overlay has pointer-events-none so clicks on
              // the trace tree behind the drawer would normally pass
              // through and could re-select a different span
              // (re-opening the drawer mid-close). Blocking outside
              // pointer-down here ensures the drawer only closes via
              // the explicit X button or the ESC key, which matches the
              // mental model of "this is a detail panel, dismiss it on
              // purpose".
              e.preventDefault();
            }}
          >
            {/* Close button — Radix Dialog handles Escape, this is the
                visible affordance. */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2 h-7 w-7 z-10"
              onClick={() => setSelectedSpan(null)}
              aria-label="Close span details"
              title="Close (Esc)"
            >
              <X size={14} />
            </Button>
            {selectedSpan && <SimpleSpanAttributesTable span={selectedSpan} />}
          </SheetContent>
        </Sheet>

        {/* Fullscreen view (preserves access to all view modes) */}
        <TraceFullScreenView
          open={fullscreenOpen}
          onOpenChange={setFullscreenOpen}
          title={trace.rootSpanName}
          subtitle={`Trace ID: ${trace.traceId.slice(0, 16)}...`}
          spanTree={spanTree}
          timeRange={timeRange}
          selectedSpan={selectedSpan}
          onSelectSpan={setSelectedSpan}
          flatSpans={trace.spans}
          serviceName={trace.serviceName}
          spanCount={trace.spanCount}
        />
      </td>
    </tr>
  );
};

// ==================== Main Component ====================

export const AgentTracesPage: React.FC = () => {
  // Filter state — persisted across sessions.
  //   * Agent filter is shared with the eval list pages via `prefs:agentFilter`.
  //     The dropdown values are agent config keys (e.g. `'observio'`); when
  //     querying OpenSearch we translate the key to the agent's actual OTel
  //     `service.name` via {@link AgentConfig.traceServiceName} (falling back
  //     to the key itself when the field is unset).
  //   * Time range is shared via `prefs:timeRange`.
  const [selectedAgent, setSelectedAgent] = usePersistedState<string>(PREFS_KEYS.agentFilter, 'all');
  const [textSearch, setTextSearch] = usePersistedState<string>('agent-traces:textSearch', '');
  // Seed debouncedSearch with the persisted textSearch so the initial query
  // includes any restored search text without waiting for the debounce timer.
  const [debouncedSearch, setDebouncedSearch] = useState<string>(() => textSearch);
  const [timeRange, setTimeRange] = usePersistedState<SharedTimeRange>(PREFS_KEYS.timeRange, '1d');
  const minutesAgo = sharedTimeRangeToMinutes(timeRange);

  // Advanced filter state
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [rootSpanSuggestOpen, setRootSpanSuggestOpen] = useState(false);
  const [serviceSuggestOpen, setServiceSuggestOpen] = useState(false);
  const [filters, setFilters] = usePersistedState<{
    status: string;
    service: string;
    rootSpan: string;
    traceId: string;
    durationRange: string;
    durationMin: string;
    durationMax: string;
    spanCountRange: string;
    spanCountMin: string;
    spanCountMax: string;
    timeWindowStart: string;
    timeWindowEnd: string;
  }>('agent-traces:filters', {
    status: 'all',
    service: '',
    rootSpan: '',
    traceId: '',
    durationRange: 'all',
    durationMin: '',
    durationMax: '',
    spanCountRange: 'all',
    spanCountMin: '',
    spanCountMax: '',
    timeWindowStart: '',
    timeWindowEnd: '',
  });

  // Loading state
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCategory, setErrorCategory] = useState<string | null>(null);
  const [errorSuggestion, setErrorSuggestion] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Pagination state (server-side cursor)
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Trace data
  const [spans, setSpans] = useState<Span[]>([]);
  const [allTraces, setAllTraces] = useState<TraceTableRow[]>([]); // All fetched traces
  const [displayedTraces, setDisplayedTraces] = useState<TraceTableRow[]>([]); // Currently displayed traces
  const [displayCount, setDisplayCount] = useState(100); // Number of traces to display

  // Sorting state
  const [sortColumn, setSortColumn] = useState<keyof TraceTableRow | null>('startTime');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Flyout state
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);

  // Scroll state for hiding container header
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  // Intersection observer ref for lazy loading
  const loadMoreRef = React.useRef<HTMLTableRowElement>(null);

  // Get unique service names from agents config (no memo — recomputes when
  // parent App re-renders after refreshConfig(), keeping custom agents visible)
  const agentOptions = (() => {
    // Use agent.key as the dropdown value so the filter is consistent with
    // the eval list pages and the shared `prefs:agentFilter` localStorage
    // key carries cleanly across all of them. Display name stays human-
    // readable.
    const agents = DEFAULT_CONFIG.agents
      .filter(a => a.enabled !== false)
      .map(a => ({ value: a.key, label: a.name }));
    return [{ value: 'all', label: 'All Agents' }, ...agents];
  })();

  /**
   * Translate the selected agent key (e.g. 'observio') into the OTel
   * `service.name` value to filter on (e.g. 'observio-sample-agent').
   * Falls back to the key itself when no override is set, which is correct
   * for agents whose OTel SDK uses the same identifier (e.g. `claude-code`).
   */
  const selectedAgentServiceName = useMemo(() => {
    if (selectedAgent === 'all') return undefined;
    const cfg = DEFAULT_CONFIG.agents.find(a => a.key === selectedAgent);
    return cfg?.traceServiceName ?? selectedAgent;
  }, [selectedAgent]);

  // Time range options — unified with eval list pages.
  const timeRangeOptions: { value: SharedTimeRange; label: string }[] = [
    { value: '1h', label: 'Last 1h' },
    { value: '6h', label: 'Last 6h' },
    { value: '1d', label: 'Last 1d' },
    { value: '7d', label: 'Last 7d' },
    { value: '30d', label: 'Last 30d' },
    { value: 'all', label: 'All time' },
  ];

  // Debounce text search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(textSearch);
    }, 500);
    return () => clearTimeout(timer);
  }, [textSearch]);

  // Persist filter selections to localStorage — handled by usePersistedState above.
  // (legacy `agentTraces.*` keys are migrated once on mount; see initialization block)

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

  // Refs for cursor/spans used by loadMoreTraces (avoid re-creating fetchTraces on every data change)
  const cursorRef = React.useRef<string | null>(null);
  const spansRef = React.useRef<Span[]>([]);
  cursorRef.current = cursor;
  spansRef.current = spans;

  // Fetch traces (fresh load — resets pagination)
  const fetchTraces = useCallback(async () => {
    setIsLoading(true);
    setCursor(null);
    setError(null);
    setErrorCategory(null);
    setErrorSuggestion(null);

    try {
      const result = await fetchRecentTraces({
        minutesAgo: minutesAgo,
        serviceName: selectedAgentServiceName,
        textSearch: debouncedSearch || undefined,
        size: 100,
      });

      if (result.warning) {
        setError(result.warning);
        setErrorCategory(result.warningCategory || null);
        setErrorSuggestion(result.suggestion || null);
      }

      setSpans(result.spans);
      const processedTraces = processSpansToTraces(result.spans);
      setAllTraces(processedTraces);
      setDisplayedTraces(processedTraces.slice(0, 100));
      setDisplayCount(100);
      setLastRefresh(new Date());

      // Update pagination state
      setCursor(result.nextCursor || null);
      setHasMore(result.hasMore || false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch traces');
    } finally {
      setIsLoading(false);
    }
  }, [selectedAgent, debouncedSearch, timeRange, processSpansToTraces, sortTraces]);

  // Load more traces from server (appends to existing data)
  const loadMoreTraces = useCallback(async () => {
    const currentCursor = cursorRef.current;
    if (!currentCursor || isLoadingMore) return;

    startMeasure('AgentTracesPage.fetchMore');
    setIsLoadingMore(true);

    try {
      const result = await fetchRecentTraces({
        minutesAgo: minutesAgo,
        serviceName: selectedAgentServiceName,
        textSearch: debouncedSearch || undefined,
        size: 100,
        cursor: currentCursor,
      });

      const allSpans = [...spansRef.current, ...result.spans];
      setSpans(allSpans);
      const processedTraces = processSpansToTraces(allSpans);
      setAllTraces(processedTraces);
      setDisplayedTraces(processedTraces);
      setDisplayCount(processedTraces.length);

      setCursor(result.nextCursor || null);
      setHasMore(result.hasMore || false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch more traces');
    } finally {
      setIsLoadingMore(false);
      endMeasure('AgentTracesPage.fetchMore');
    }
  }, [selectedAgent, debouncedSearch, timeRange, processSpansToTraces, isLoadingMore]);

  // Initial fetch and refetch on filter change
  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

  // Re-sort traces when sort column or direction changes
  useEffect(() => {
    const sortedTraces = sortTraces(allTraces);
    setDisplayedTraces(sortedTraces.slice(0, 100));
    setDisplayCount(100);
  }, [sortColumn, sortDirection, allTraces, sortTraces]);

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

  // Client-side filtering
  const filteredTraces = useMemo(() => {
    let result = allTraces;

    // Status filter
    if (filters.status === 'success') result = result.filter(t => !t.hasErrors);
    if (filters.status === 'error') result = result.filter(t => t.hasErrors);

    // Root span filter
    if (filters.rootSpan) {
      const q = filters.rootSpan.toLowerCase();
      result = result.filter(t => t.rootSpanName.toLowerCase().includes(q));
    }

    // Service filter
    if (filters.service) {
      const q = filters.service.toLowerCase();
      result = result.filter(t => t.serviceName.toLowerCase().includes(q));
    }

    // Trace ID filter
    if (filters.traceId) {
      const q = filters.traceId.toLowerCase();
      result = result.filter(t => t.traceId.toLowerCase().includes(q));
    }

    // Duration filter (values in ms)
    if (filters.durationRange !== 'all') {
      if (filters.durationRange === 'custom') {
        const min = filters.durationMin ? parseFloat(filters.durationMin) : 0;
        const max = filters.durationMax ? parseFloat(filters.durationMax) : Infinity;
        result = result.filter(t => t.duration >= min && t.duration <= max);
      } else if (filters.durationRange === '>10000') {
        result = result.filter(t => t.duration > 10000);
      } else {
        const [min, max] = filters.durationRange.split('-').map(Number);
        result = result.filter(t => t.duration >= min && t.duration < max);
      }
    }

    // Span count filter
    if (filters.spanCountRange !== 'all') {
      if (filters.spanCountRange === 'custom') {
        const min = filters.spanCountMin ? parseInt(filters.spanCountMin) : 0;
        const max = filters.spanCountMax ? parseInt(filters.spanCountMax) : Infinity;
        result = result.filter(t => t.spanCount >= min && t.spanCount <= max);
      } else if (filters.spanCountRange === '>1000') {
        result = result.filter(t => t.spanCount > 1000);
      } else {
        const [min, max] = filters.spanCountRange.split('-').map(Number);
        result = result.filter(t => t.spanCount >= min && t.spanCount <= max);
      }
    }

    // Time window filter (from chart clicks)
    if (filters.timeWindowStart && filters.timeWindowEnd) {
      const start = new Date(filters.timeWindowStart).getTime();
      const end = new Date(filters.timeWindowEnd).getTime();
      result = result.filter(t => {
        const ts = t.startTime.getTime();
        return ts >= start && ts < end;
      });
    }

    // Text search as filter
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(t =>
        t.traceId.toLowerCase().includes(q) ||
        t.rootSpanName.toLowerCase().includes(q) ||
        t.serviceName.toLowerCase().includes(q)
      );
    }

    return result;
  }, [allTraces, filters, debouncedSearch]);

  // Lazy loading with intersection observer (client-side + server-side pagination)
  useEffect(() => {
    const currentRef = loadMoreRef.current;
    if (!currentRef) return;

    // Nothing left to show client-side or load from server
    if (displayCount >= filteredTraces.length && !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting) {
          if (displayCount < filteredTraces.length) {
            // Client-side: show next batch of already-fetched traces
            const nextCount = Math.min(displayCount + 100, filteredTraces.length);
            setDisplayedTraces(filteredTraces.slice(0, nextCount));
            setDisplayCount(nextCount);
          } else if (hasMore && !isLoadingMore) {
            // Server-side: fetch next page from the API
            loadMoreTraces();
          }
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
  }, [displayCount, filteredTraces, hasMore, isLoadingMore, loadMoreTraces]);

  // Handle trace selection (toggle inline expansion)
  const handleSelectTrace = (trace: TraceTableRow) => {
    setExpandedTraceId(prev => (prev === trace.traceId ? null : trace.traceId));
  };

  // Collapse the inline expanded row.
  // Wrapped in useCallback so it can be included in the Escape-key effect's
  // dependency array without retriggering it on every render.
  const handleCollapseExpandedTrace = useCallback(() => {
    setExpandedTraceId(null);
  }, []);

  // Dismiss inline expansion on Escape key
  useEffect(() => {
    if (!expandedTraceId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCollapseExpandedTrace();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expandedTraceId, handleCollapseExpandedTrace]);

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
    const timeRangeMs = minutesAgo * 60 * 1000;
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
    if (allTraces.length === 0) return { total: 0, totalSpans: 0, errors: 0, avgDuration: 0 };

    const errors = allTraces.filter(t => t.hasErrors).length;
    const avgDuration = allTraces.reduce((sum, t) => sum + t.duration, 0) / allTraces.length;
    const totalSpans = allTraces.reduce((sum, t) => sum + t.spanCount, 0);

    return {
      total: allTraces.length,
      totalSpans,
      errors,
      avgDuration,
    };
  }, [allTraces]);

  // Unique root span names for autosuggest (derived from in-memory data, zero cost)
  const uniqueRootSpans = useMemo(() => {
    const names = new Set(allTraces.map(t => t.rootSpanName));
    return Array.from(names).sort();
  }, [allTraces]);

  // Filtered suggestions based on current input
  const rootSpanSuggestions = useMemo(() => {
    if (!filters.rootSpan) return uniqueRootSpans.slice(0, 10);
    const q = filters.rootSpan.toLowerCase();
    return uniqueRootSpans.filter(n => n.toLowerCase().includes(q)).slice(0, 10);
  }, [uniqueRootSpans, filters.rootSpan]);

  // Unique service names for autosuggest
  const uniqueServiceNames = useMemo(() => {
    const names = new Set(allTraces.map(t => t.serviceName));
    return Array.from(names).sort();
  }, [allTraces]);

  // Filtered service suggestions based on current input
  const serviceSuggestions = useMemo(() => {
    if (!filters.service) return uniqueServiceNames.slice(0, 10);
    const q = filters.service.toLowerCase();
    return uniqueServiceNames.filter(n => n.toLowerCase().includes(q)).slice(0, 10);
  }, [uniqueServiceNames, filters.service]);

  // Active filter chips
  const activeFilterChips = useMemo(() => {
    const chips: { key: string; label: string }[] = [];
    if (filters.status !== 'all') chips.push({ key: 'status', label: `Status: ${filters.status}` });
    if (filters.service) chips.push({ key: 'service', label: `Service: ${filters.service}` });
    if (filters.rootSpan) chips.push({ key: 'rootSpan', label: `Root span: ${filters.rootSpan}` });
    if (filters.traceId) chips.push({ key: 'traceId', label: `Trace ID: ${filters.traceId}` });
    if (filters.durationRange !== 'all') {
      const durationLabels: Record<string, string> = {
        '0-10': '0–10ms', '10-50': '10–50ms', '50-100': '50–100ms',
        '100-1000': '100ms–1s', '1000-5000': '1–5s', '5000-10000': '5–10s',
        '>10000': '>10s',
      };
      const label = filters.durationRange === 'custom'
        ? `Duration: ${filters.durationMin || '0'}–${filters.durationMax || '∞'}ms`
        : `Duration: ${durationLabels[filters.durationRange] || filters.durationRange}`;
      chips.push({ key: 'durationRange', label });
    }
    if (filters.spanCountRange !== 'all') {
      const label = filters.spanCountRange === 'custom'
        ? `Spans: ${filters.spanCountMin || '0'}–${filters.spanCountMax || '∞'}`
        : `Spans: ${filters.spanCountRange}`;
      chips.push({ key: 'spanCountRange', label });
    }
    if (textSearch) chips.push({ key: 'textSearch', label: `Keyword: ${textSearch}` });
    if (filters.timeWindowStart) {
      const s = new Date(filters.timeWindowStart);
      const e = filters.timeWindowEnd ? new Date(filters.timeWindowEnd) : null;
      const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      chips.push({ key: 'timeWindow', label: `Time: ${fmt(s)}–${e ? fmt(e) : 'now'}` });
    }
    return chips;
  }, [filters, textSearch]);

  // Remove a single filter chip
  const removeFilterChip = (key: string) => {
    if (key === 'textSearch') {
      setTextSearch('');
      return;
    }
    setFilters(prev => {
      const next = { ...prev };
      if (key === 'status') next.status = 'all';
      if (key === 'service') next.service = '';
      if (key === 'rootSpan') next.rootSpan = '';
      if (key === 'traceId') next.traceId = '';
      if (key === 'durationRange') {
        next.durationRange = 'all';
        next.durationMin = '';
        next.durationMax = '';
      }
      if (key === 'spanCountRange') {
        next.spanCountRange = 'all';
        next.spanCountMin = '';
        next.spanCountMax = '';
      }
      if (key === 'timeWindow') {
        next.timeWindowStart = '';
        next.timeWindowEnd = '';
      }
      return next;
    });
  };

  // Clear all filters
  const clearAllFilters = () => {
    setTextSearch('');
    setFilters({
      status: 'all',
      service: '',
      rootSpan: '',
      traceId: '',
      durationRange: 'all',
      durationMin: '',
      durationMax: '',
      spanCountRange: 'all',
      spanCountMin: '',
      spanCountMax: '',
      timeWindowStart: '',
      timeWindowEnd: '',
    });
  };

  // Handle filter actions from MetricsOverview chart clicks
  const handleMetricsFilter = useCallback((action: FilterAction) => {
    if (action.type === 'status') {
      setFilters(prev => ({ ...prev, status: action.value }));
    } else if (action.type === 'durationRange') {
      setFilters(prev => ({
        ...prev,
        durationRange: 'custom',
        durationMin: action.durationMin || '',
        durationMax: action.durationMax || '',
      }));
    } else if (action.type === 'timeRange') {
      // For time-bucket clicks, compute the bucket window
      const start = action.timeStart;
      const end = action.timeEnd;
      if (start) {
        // For error-bucket clicks, also set status=error
        const isError = action.value === 'error-bucket';
        setFilters(prev => ({
          ...prev,
          timeWindowStart: start.toISOString(),
          timeWindowEnd: end ? end.toISOString() : new Date().toISOString(),
          ...(isError ? { status: 'error' } : {}),
        }));
      }
    }
  }, []);

  // Reset displayed traces when filteredTraces changes
  useEffect(() => {
    setDisplayedTraces(filteredTraces.slice(0, 100));
    setDisplayCount(100);
  }, [filteredTraces]);

  return (
    <div className="h-full flex flex-col">
      {/* Compact Header with Inline Stats and Filters */}
      <div className="px-6 pt-4 pb-3 border-b">
        {/* Single Row: Title + Stats + Filters */}
        <div className="flex items-start justify-between gap-4">
          {/* Left: Title and Description */}
          <div className="flex-shrink-0">
            <h2 className="text-xl font-bold">Agent Traces</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Analyze agent execution traces from OTEL
            </p>
          </div>

          {/* Right: Stats and Filters with Last Updated below */}
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <div className="flex items-center gap-3">
              {/* Search Bar */}
              <div className="w-[200px]">
                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search traces, services, spans..."
                    value={textSearch}
                    onChange={(e) => setTextSearch(e.target.value)}
                    className="pl-7 h-7 text-xs md:text-xs"
                  />
                </div>
              </div>

              {/* Filter Button */}
              <Popover open={filterPopoverOpen} onOpenChange={setFilterPopoverOpen}>
                <PopoverTrigger>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs font-normal"
                  >
                    <SlidersHorizontal size={12} />
                    Filter
                    {activeFilterChips.length > 0 && (
                      <Badge variant="secondary" className="ml-0.5 h-4 px-1 text-[10px] rounded-full">
                        {activeFilterChips.length}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[320px] p-0">
                  <div className="p-3 border-b">
                    <div className="text-sm font-medium">Filters</div>
                  </div>
                  <div className="p-3 space-y-3 max-h-[400px] overflow-y-auto">
                    {/* Status */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Status</label>
                      <Select value={filters.status} onValueChange={(v) => setFilters(prev => ({ ...prev, status: v }))}>
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="success">Success</SelectItem>
                          <SelectItem value="error">Error</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Service */}
                    <div className="space-y-1 relative">
                      <label className="text-xs font-medium text-muted-foreground">Service</label>
                      <Input
                        placeholder="Filter by service name"
                        value={filters.service}
                        onChange={(e) => {
                          setFilters(prev => ({ ...prev, service: e.target.value }));
                          setServiceSuggestOpen(true);
                        }}
                        onFocus={() => setServiceSuggestOpen(true)}
                        onBlur={() => setTimeout(() => setServiceSuggestOpen(false), 150)}
                        className="h-8 text-sm"
                      />
                      {serviceSuggestOpen && serviceSuggestions.length > 0 && (
                        <div className="absolute z-50 top-full mt-1 left-0 right-0 max-h-[160px] overflow-y-auto rounded-md border bg-popover shadow-md">
                          {serviceSuggestions.map(name => (
                            <button
                              key={name}
                              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted/50 truncate"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setFilters(prev => ({ ...prev, service: name }));
                                setServiceSuggestOpen(false);
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Root Span */}
                    <div className="space-y-1 relative">
                      <label className="text-xs font-medium text-muted-foreground">Root Span</label>
                      <Input
                        placeholder="Filter by root span name"
                        value={filters.rootSpan}
                        onChange={(e) => {
                          setFilters(prev => ({ ...prev, rootSpan: e.target.value }));
                          setRootSpanSuggestOpen(true);
                        }}
                        onFocus={() => setRootSpanSuggestOpen(true)}
                        onBlur={() => setTimeout(() => setRootSpanSuggestOpen(false), 150)}
                        className="h-8 text-sm"
                      />
                      {rootSpanSuggestOpen && rootSpanSuggestions.length > 0 && (
                        <div className="absolute z-50 top-full mt-1 left-0 right-0 max-h-[160px] overflow-y-auto rounded-md border bg-popover shadow-md">
                          {rootSpanSuggestions.map(name => (
                            <button
                              key={name}
                              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted/50 truncate"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setFilters(prev => ({ ...prev, rootSpan: name }));
                                setRootSpanSuggestOpen(false);
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Trace ID */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Trace ID</label>
                      <Input
                        placeholder="Filter by trace ID"
                        value={filters.traceId}
                        onChange={(e) => setFilters(prev => ({ ...prev, traceId: e.target.value }))}
                        className="h-8 text-sm"
                      />
                    </div>

                    {/* Duration */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Duration</label>
                      <Select
                        value={filters.durationRange}
                        onValueChange={(v) => setFilters(prev => ({
                          ...prev,
                          durationRange: v,
                          ...(v !== 'custom' ? { durationMin: '', durationMax: '' } : {}),
                        }))}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="0-10">0 – 10ms</SelectItem>
                          <SelectItem value="10-50">10 – 50ms</SelectItem>
                          <SelectItem value="50-100">50 – 100ms</SelectItem>
                          <SelectItem value="100-1000">100ms – 1s</SelectItem>
                          <SelectItem value="1000-5000">1 – 5s</SelectItem>
                          <SelectItem value="5000-10000">5 – 10s</SelectItem>
                          <SelectItem value=">10000">&gt; 10s</SelectItem>
                          <SelectItem value="custom">Custom range</SelectItem>
                        </SelectContent>
                      </Select>
                      {filters.durationRange === 'custom' && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <Input
                            placeholder="Min (ms)"
                            type="number"
                            value={filters.durationMin}
                            onChange={(e) => setFilters(prev => ({ ...prev, durationMin: e.target.value }))}
                            className="h-8 text-sm"
                          />
                          <span className="text-xs text-muted-foreground">to</span>
                          <Input
                            placeholder="Max (ms)"
                            type="number"
                            value={filters.durationMax}
                            onChange={(e) => setFilters(prev => ({ ...prev, durationMax: e.target.value }))}
                            className="h-8 text-sm"
                          />
                        </div>
                      )}
                    </div>

                    {/* Span Count */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Number of Spans</label>
                      <Select
                        value={filters.spanCountRange}
                        onValueChange={(v) => setFilters(prev => ({
                          ...prev,
                          spanCountRange: v,
                          ...(v !== 'custom' ? { spanCountMin: '', spanCountMax: '' } : {}),
                        }))}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="0-10">0 – 10</SelectItem>
                          <SelectItem value="10-50">10 – 50</SelectItem>
                          <SelectItem value="50-100">50 – 100</SelectItem>
                          <SelectItem value="100-1000">100 – 1000</SelectItem>
                          <SelectItem value=">1000">&gt; 1000</SelectItem>
                          <SelectItem value="custom">Custom range</SelectItem>
                        </SelectContent>
                      </Select>
                      {filters.spanCountRange === 'custom' && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <Input
                            placeholder="Min"
                            type="number"
                            value={filters.spanCountMin}
                            onChange={(e) => setFilters(prev => ({ ...prev, spanCountMin: e.target.value }))}
                            className="h-8 text-sm"
                          />
                          <span className="text-xs text-muted-foreground">to</span>
                          <Input
                            placeholder="Max"
                            type="number"
                            value={filters.spanCountMax}
                            onChange={(e) => setFilters(prev => ({ ...prev, spanCountMax: e.target.value }))}
                            className="h-8 text-sm"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Footer */}
                  <div className="p-3 border-t flex justify-between">
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearAllFilters}>
                      Clear all
                    </Button>
                    <Button size="sm" className="h-7 text-xs" onClick={() => setFilterPopoverOpen(false)}>
                      Done
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Agent Filter */}
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger className="w-[100px] h-7 text-xs">
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
              <Select value={timeRange} onValueChange={(v) => setTimeRange(v as SharedTimeRange)}>
                <SelectTrigger className="w-[85px] h-7 text-xs">
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
                className="h-7"
              >
                <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
              </Button>
            </div>
            
            {/* Last Updated - Below stats and filters */}
            {lastRefresh && (
              <span className="text-[11px] text-muted-foreground">
                Last updated: {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Filter Chips */}
      {activeFilterChips.length > 0 && (
        <div className="px-6 pt-2 flex items-center gap-2 flex-wrap justify-end">
          {activeFilterChips.map(chip => (
            <Badge
              key={chip.key}
              variant="secondary"
              className="gap-1 pr-1 text-xs font-normal"
            >
              {chip.label}
              <button
                onClick={() => removeFilterChip(chip.key)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
                aria-label={`Remove ${chip.label} filter`}
              >
                <X size={12} />
              </button>
            </Badge>
          ))}
          <button
            onClick={clearAllFilters}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Metrics Overview - Trends */}
      <div className="px-6 pt-2">
        {allTraces.length > 0 && (
          <MetricsOverview
            latencyDistribution={latencyDistribution}
            errorTimeSeries={errorTimeSeries}
            requestTimeSeries={requestTimeSeries}
            totalRequests={stats.total}
            totalSpans={stats.totalSpans}
            totalErrors={stats.errors}
            avgLatency={stats.avgDuration}
            onFilter={handleMetricsFilter}
          />
        )}
      </div>

      {/* Error State */}
      {error && (
        <div className="px-6 pt-2">
          <Card className={errorCategory === 'auth'
            ? "bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/30"
            : "bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/30"
          }>
            <CardContent className={`p-4 text-sm ${
              errorCategory === 'auth'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-red-700 dark:text-red-400'
            }`}>
              <p className="font-medium">{error}</p>
              {errorSuggestion && (
                <p className="mt-1 opacity-80 font-mono text-xs">{errorSuggestion}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Traces Table */}
      <Card className="flex-1 flex flex-col overflow-hidden mx-6 mt-2 mb-6">
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
                  <Badge variant="secondary" className="ml-2">{formatCompact(filteredTraces.length)}</Badge>
                  {filteredTraces.length < allTraces.length && (
                    <span className="text-xs text-muted-foreground ml-2">
                      (filtered from {formatCompact(allTraces.length)})
                    </span>
                  )}
                  {displayedTraces.length < filteredTraces.length && (
                    <span className="text-xs text-muted-foreground ml-2">
                      (showing {formatCompact(displayedTraces.length)})
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
                      <th className="h-8 px-3 text-left align-middle font-medium text-xs text-muted-foreground whitespace-nowrap bg-background border-b">
                        Start Time
                      </th>
                      <th className="h-8 px-3 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b">
                        Trace ID
                      </th>
                      <th className="h-8 px-3 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b">
                        Root Span
                      </th>
                      <th className="h-8 px-3 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b">
                        Service
                      </th>
                      <th className="h-8 px-3 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b">
                        Duration
                      </th>
                      <th className="h-8 px-3 text-center align-middle font-medium text-xs text-muted-foreground bg-background border-b">
                        Spans
                      </th>
                      <th className="h-8 px-3 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b"></th>
                    </tr>
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {displayedTraces.map((trace) => (
                      <React.Fragment key={trace.traceId}>
                        <TraceRow
                          trace={trace}
                          onSelect={() => handleSelectTrace(trace)}
                          isSelected={expandedTraceId === trace.traceId}
                          isExpanded={expandedTraceId === trace.traceId}
                        />
                        {expandedTraceId === trace.traceId && (
                          <ExpandedTraceRow
                            trace={trace}
                            onClose={handleCollapseExpandedTrace}
                          />
                        )}
                      </React.Fragment>
                    ))}
                    {/* Intersection observer target for lazy loading (client-side + server-side) */}
                    {(displayedTraces.length < filteredTraces.length || hasMore) && (
                      <tr ref={loadMoreRef} className="hover:bg-transparent border-b transition-colors">
                        <td colSpan={7} className="py-1.5 px-3 align-middle text-center py-4">
                          <div className="flex items-center justify-center gap-2 text-muted-foreground">
                            <RefreshCw size={16} className={isLoadingMore ? 'animate-spin' : ''} />
                            <span className="text-sm">
                              {isLoadingMore ? 'Loading more traces from server...' : 'Loading more traces...'}
                            </span>
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

      {/* Trace details now render inline within the table as ExpandedTraceRow */}
    </div>
  );
};

export default AgentTracesPage;
