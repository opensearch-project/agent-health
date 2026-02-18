/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceFlyoutContent - Detailed trace view shown in flyout panel
 *
 * Displays trace visualization with:
 * - Trace overview with metrics
 * - Timeline/Flow view of spans
 * - Span details panel with input/output from OTEL conventions
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  Activity,
  Clock,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Maximize2,
  Hash,
  Server,
  Cpu,
  MessageSquare,
  Wrench,
  Bot,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Span, TimeRange } from '@/types';
import { processSpansIntoTree, calculateTimeRange } from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import TraceVisualization from './TraceVisualization';
import ViewToggle, { ViewMode } from './ViewToggle';
import TraceFullScreenView from './TraceFullScreenView';
import { SpanInputOutput } from './SpanInputOutput';

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

interface TraceFlyoutContentProps {
  trace: TraceTableRow;
  onClose: () => void;
}

export const TraceFlyoutContent: React.FC<TraceFlyoutContentProps> = ({
  trace,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState('traces');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [copiedTraceId, setCopiedTraceId] = useState(false);

  // Process spans into tree
  const spanTree = useMemo(() => processSpansIntoTree(trace.spans), [trace.spans]);
  const timeRange = useMemo(() => calculateTimeRange(trace.spans), [trace.spans]);

  // Auto-expand root spans
  useEffect(() => {
    const rootIds = new Set(spanTree.map(s => s.spanId));
    setExpandedSpans(rootIds);
  }, [spanTree]);

  // Handle expand toggle
  const handleToggleExpand = (spanId: string) => {
    setExpandedSpans(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  // Copy trace ID to clipboard
  const handleCopyTraceId = async () => {
    try {
      await navigator.clipboard.writeText(trace.traceId);
      setCopiedTraceId(true);
      setTimeout(() => setCopiedTraceId(false), 2000);
    } catch (err) {
      console.error('Failed to copy trace ID to clipboard:', err);
    }
  };

  // Calculate span stats
  const spanStats = useMemo(() => {
    const byStatus = trace.spans.reduce(
      (acc, span) => {
        if (span.status === 'ERROR') acc.error++;
        else if (span.status === 'OK') acc.ok++;
        else acc.unset++;
        return acc;
      },
      { ok: 0, error: 0, unset: 0 }
    );

    // Count by category based on span attributes
    const byCategory = trace.spans.reduce(
      (acc, span) => {
        const name = span.name.toLowerCase();
        if (name.includes('llm') || name.includes('bedrock') || name.includes('converse')) {
          acc.llm++;
        } else if (name.includes('tool') || span.attributes?.['gen_ai.tool.name']) {
          acc.tool++;
        } else if (name.includes('agent')) {
          acc.agent++;
        } else {
          acc.other++;
        }
        return acc;
      },
      { agent: 0, llm: 0, tool: 0, other: 0 }
    );

    return { byStatus, byCategory };
  }, [trace.spans]);

  return (
    <div className="h-full flex flex-col">
      {/* Compact Header */}
      <div className="px-4 py-3 border-b bg-card">
        {/* Title Row with Trace ID */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {trace.hasErrors ? (
              <XCircle size={18} className="text-red-700 dark:text-red-400 flex-shrink-0" />
            ) : (
              <CheckCircle2 size={18} className="text-green-700 dark:text-green-400 flex-shrink-0" />
            )}
            <h2 className="text-base font-semibold truncate">{trace.rootSpanName}</h2>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-mono">trace-{trace.traceId.slice(0, 8)}</span>
              <Button
                variant="outline"
                size="icon"
                className="h-6 w-6 border-border hover:bg-muted hover:border-muted-foreground/30"
                onClick={handleCopyTraceId}
                title="Copy full trace ID"
              >
                {copiedTraceId ? (
                  <Check size={12} className="text-green-700 dark:text-green-400" />
                ) : (
                  <Copy size={12} />
                )}
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button 
              variant="outline" 
              size="icon" 
              className="h-8 w-8 border-border hover:bg-muted hover:border-muted-foreground/30" 
              onClick={() => setFullscreenOpen(true)}
              title="Fullscreen"
            >
              <Maximize2 size={14} />
            </Button>
            <Button 
              variant="outline" 
              size="icon" 
              className="h-8 w-8 border-border hover:bg-muted hover:border-muted-foreground/30" 
              onClick={onClose}
              title="Close"
            >
              <X size={14} />
            </Button>
          </div>
        </div>

        {/* Primary Metrics Row */}
        <div className="flex items-center gap-4 text-sm mb-3">
          <Badge 
            variant="outline" 
            className={trace.hasErrors 
              ? "bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800" 
              : "bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
            }
          >
            {trace.hasErrors ? 'ERROR' : 'OK'}: {spanStats.byStatus.error > 0 ? spanStats.byStatus.error : spanStats.byStatus.ok}
          </Badge>
          <span className="font-semibold">{trace.spanCount} spans</span>
          <span className="font-semibold text-amber-700 dark:text-amber-400">{formatDuration(trace.duration)}</span>
          <span className="text-muted-foreground">duration</span>
          <span className="font-medium">{trace.serviceName}</span>
          <span className="text-muted-foreground">{trace.startTime.toLocaleString()}</span>
        </div>

        {/* Secondary Info: Categories */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Categories:</span>
          {spanStats.byCategory.agent > 0 && (
            <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800">
              <Bot size={10} className="mr-1" />
              Agent: {spanStats.byCategory.agent}
            </Badge>
          )}
          {spanStats.byCategory.llm > 0 && (
            <Badge variant="outline" className="bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800">
              <MessageSquare size={10} className="mr-1" />
              LLM: {spanStats.byCategory.llm}
            </Badge>
          )}
          {spanStats.byCategory.tool > 0 && (
            <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800">
              <Wrench size={10} className="mr-1" />
              Tool: {spanStats.byCategory.tool}
            </Badge>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start rounded-none border-b bg-card h-auto p-0">
          <TabsTrigger
            value="traces"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue"
          >
            <Activity size={14} className="mr-2" />
            Traces
            <Badge variant="secondary" className="ml-2">{trace.spanCount}</Badge>
          </TabsTrigger>
          <TabsTrigger
            value="details"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue"
          >
            <MessageSquare size={14} className="mr-2" />
            Input/Output
          </TabsTrigger>
        </TabsList>

        {/* Traces Tab */}
        <TabsContent value="traces" className="flex-1 mt-0 overflow-hidden flex flex-col">
          {/* View Toggle & Fullscreen */}
          <div className="flex items-center justify-between p-3 border-b">
            <ViewToggle viewMode={viewMode} onChange={setViewMode} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFullscreenOpen(true)}
              className="gap-1.5"
            >
              <Maximize2 size={14} />
              Fullscreen
            </Button>
          </div>

          {/* Trace Visualization */}
          <div className="flex-1 overflow-hidden">
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
              showSpanDetailsPanel={true}
            />
          </div>
        </TabsContent>

        {/* Input/Output Tab */}
        <TabsContent value="details" className="flex-1 mt-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              <SpanInputOutput spans={trace.spans} />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Fullscreen View */}
      <TraceFullScreenView
        open={fullscreenOpen}
        onOpenChange={setFullscreenOpen}
        title={trace.rootSpanName}
        subtitle={`Trace ID: ${trace.traceId.slice(0, 16)}...`}
        spanTree={spanTree}
        timeRange={timeRange}
        selectedSpan={selectedSpan}
        onSelectSpan={setSelectedSpan}
        initialViewMode={viewMode}
        onViewModeChange={setViewMode}
        spanCount={trace.spanCount}
      />
    </div>
  );
};

export default TraceFlyoutContent;
