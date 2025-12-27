/**
 * TracesPage - Live Trace Tailing
 *
 * Live monitoring page showing traces from the last 5 minutes
 * with agent filter and text search. Supports Flow and Timeline views.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Search, RefreshCw, Activity, Pause, Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Span } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import {
  fetchRecentTraces,
  processSpansIntoTree,
  calculateTimeRange,
} from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import TraceVisualization from './TraceVisualization';
import ViewToggle, { ViewMode } from './ViewToggle';

const REFRESH_INTERVAL_MS = 10000; // 10 seconds

export const TracesPage: React.FC = () => {
  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('flow');

  // Filter state
  const [selectedAgent, setSelectedAgent] = useState<string>('all');
  const [textSearch, setTextSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Tailing state
  const [isTailing, setIsTailing] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Trace data
  const [spans, setSpans] = useState<Span[]>([]);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());

  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Get unique service names from agents config
  const agentOptions = useMemo(() => {
    const agents = DEFAULT_CONFIG.agents
      .filter(a => a.enabled !== false)
      .map(a => ({ value: a.name, label: a.name }));
    return [{ value: 'all', label: 'All Agents' }, ...agents];
  }, []);

  // Process spans into tree
  const spanTree = useMemo(() => processSpansIntoTree(spans), [spans]);
  const timeRange = useMemo(() => calculateTimeRange(spans), [spans]);

  // Debounce text search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(textSearch);
    }, 500);
    return () => clearTimeout(timer);
  }, [textSearch]);

  // Fetch traces
  const fetchTraces = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchRecentTraces({
        minutesAgo: 5,
        serviceName: selectedAgent !== 'all' ? selectedAgent : undefined,
        textSearch: debouncedSearch || undefined,
        size: 500,
      });

      setSpans(result.spans);
      setLastRefresh(new Date());

      // Auto-expand root spans (for Timeline view)
      if (result.spans.length > 0) {
        const tree = processSpansIntoTree(result.spans);
        const rootIds = new Set(tree.map(s => s.spanId));
        setExpandedSpans(prev => {
          const newSet = new Set(prev);
          rootIds.forEach(id => newSet.add(id));
          return newSet;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch traces');
    } finally {
      setIsLoading(false);
    }
  }, [selectedAgent, debouncedSearch]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchTraces();

    if (isTailing) {
      refreshIntervalRef.current = setInterval(fetchTraces, REFRESH_INTERVAL_MS);
    }

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [fetchTraces, isTailing]);

  // Toggle expand handler (for Timeline view)
  const handleToggleExpand = useCallback((spanId: string) => {
    setExpandedSpans(prev => {
      const newSet = new Set(prev);
      if (newSet.has(spanId)) {
        newSet.delete(spanId);
      } else {
        newSet.add(spanId);
      }
      return newSet;
    });
  }, []);

  // Toggle tailing
  const toggleTailing = () => {
    setIsTailing(prev => !prev);
  };

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Live Traces</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Real-time trace monitoring from the last 5 minutes
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ViewToggle viewMode={viewMode} onChange={setViewMode} />
          {lastRefresh && (
            <span className="text-xs text-muted-foreground">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant={isTailing ? "default" : "outline"}
            size="sm"
            onClick={toggleTailing}
            className={isTailing ? "bg-green-600 hover:bg-green-700" : ""}
          >
            {isTailing ? (
              <>
                <Pause size={14} className="mr-1.5" />
                Tailing
              </>
            ) : (
              <>
                <Play size={14} className="mr-1.5" />
                Paused
              </>
            )}
          </Button>
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

      {/* Filters */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="flex gap-4 items-end">
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
                  placeholder="Search span names, attributes..."
                  value={textSearch}
                  onChange={(e) => setTextSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            {/* Stats */}
            <div className="flex items-center gap-3 text-sm">
              <Badge variant="outline" className="font-mono">
                {spans.length} spans
              </Badge>
              {timeRange.duration > 0 && (
                <Badge variant="outline" className="font-mono">
                  {formatDuration(timeRange.duration)}
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error State */}
      {error && (
        <Card className="mb-4 bg-red-500/10 border-red-500/30">
          <CardContent className="p-4 text-sm text-red-400">
            {error}
          </CardContent>
        </Card>
      )}

      {/* Trace Visualization */}
      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardHeader className="py-2 px-4 border-b">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity size={14} />
            {viewMode === 'flow' ? 'Trace Flow' : viewMode === 'intent' ? 'Trace Intent' : 'Trace Timeline'}
            {isTailing && (
              <span className="flex items-center gap-1 text-xs text-green-400 font-normal">
                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                Live
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-0 overflow-hidden">
          {spans.length === 0 && !isLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <Activity size={48} className="mb-4 opacity-20" />
              <p>No traces found in the last 5 minutes</p>
              <p className="text-sm mt-1">
                {selectedAgent !== 'all' || textSearch
                  ? 'Try adjusting your filters'
                  : 'Traces will appear here as agents execute'}
              </p>
            </div>
          ) : (
            <TraceVisualization
              spanTree={spanTree}
              timeRange={timeRange}
              initialViewMode={viewMode}
              onViewModeChange={setViewMode}
              showViewToggle={false}
              selectedSpan={selectedSpan}
              onSelectSpan={setSelectedSpan}
              expandedSpans={expandedSpans}
              onToggleExpand={handleToggleExpand}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default TracesPage;
