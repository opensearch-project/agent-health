import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Play, RefreshCw, AlertCircle, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Span } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import {
  fetchTraceById,
  fetchTracesByRunIds,
  processSpansIntoTree,
  calculateTimeRange,
} from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import TraceTimelineChart from './TraceTimelineChart';
import TraceTreeView from './TraceTreeView';
import ViewToggle, { ViewMode } from './ViewToggle';
import SpanDetailsPanel from './SpanDetailsPanel';
import {
  SSEClient,
  AGUIToTrajectoryConverter,
  buildMultiTurnPayload,
} from '@/services/agent';

export const TracesPage: React.FC = () => {
  // Search tab state
  const [traceId, setTraceId] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Live agent tab state
  const [selectedAgentName, setSelectedAgentName] = useState(DEFAULT_CONFIG.agents[0]?.name || '');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_CONFIG.agents[0]?.models[0] || '');
  const [agentQuestion, setAgentQuestion] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  // Shared trace visualization state
  const [spans, setSpans] = useState<Span[]>([]);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>('tree');

  const agent = DEFAULT_CONFIG.agents.find(a => a.name === selectedAgentName);

  // Process spans into tree
  const spanTree = useMemo(() => processSpansIntoTree(spans), [spans]);
  const timeRange = useMemo(() => calculateTimeRange(spans), [spans]);

  // Initialize expanded spans when tree changes
  useEffect(() => {
    if (spanTree.length > 0) {
      const initialExpanded = new Set<string>();
      const expandAll = (nodes: Span[]) => {
        nodes.forEach(node => {
          if (node.children && node.children.length > 0) {
            initialExpanded.add(node.spanId);
            expandAll(node.children);
          }
        });
      };
      expandAll(spanTree);
      setExpandedSpans(initialExpanded);
    }
  }, [spanTree]);

  // Toggle expand handler
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

  // Search by trace ID
  const handleSearch = async () => {
    if (!traceId.trim()) return;

    setIsSearching(true);
    setSearchError(null);
    setSpans([]);
    setSelectedSpan(null);

    try {
      const result = await fetchTraceById(traceId.trim());
      setSpans(result.spans);
      if (result.spans.length === 0) {
        setSearchError('No spans found for this trace ID');
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  // Query agent and fetch trace
  const handleAgentQuery = async () => {
    if (!agent || !agentQuestion.trim()) return;

    setIsQuerying(true);
    setAgentError(null);
    setAgentRunId(null);
    setSpans([]);
    setSelectedSpan(null);

    try {
      const modelConfig = DEFAULT_CONFIG.models[selectedModel];
      const bedrockModelId = modelConfig?.model_id || selectedModel;

      const payload = buildMultiTurnPayload(
        [{ id: `msg-${Date.now()}`, role: 'user', content: agentQuestion.trim() }],
        bedrockModelId
      );
      const converter = new AGUIToTrajectoryConverter();
      let capturedRunId: string | null = null;

      const client = new SSEClient();

      await client.consume({
        url: agent.endpoint,
        method: 'POST',
        body: payload,
        onEvent: (event) => {
          converter.processEvent(event);
          // Capture run ID from RUN_STARTED event
          if (event.type === 'RUN_STARTED' && event.runId) {
            capturedRunId = event.runId;
            setAgentRunId(event.runId);
          }
        },
        onError: (error) => {
          console.error('[TracesPage] SSE error:', error);
          setAgentError(error.message);
        },
        onComplete: async () => {
          console.log('[TracesPage] Agent query complete, runId:', capturedRunId);

          if (capturedRunId) {
            // Wait a bit for traces to be ingested
            setTimeout(async () => {
              try {
                const result = await fetchTracesByRunIds([capturedRunId!]);
                setSpans(result.spans);
                if (result.spans.length === 0) {
                  setAgentError('Traces not yet available. Try refreshing in a few seconds.');
                }
              } catch (err) {
                setAgentError(err instanceof Error ? err.message : 'Failed to fetch traces');
              }
            }, 2000);
          }
        }
      });
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : 'Query failed');
    } finally {
      setIsQuerying(false);
    }
  };

  // Refresh traces for current run ID
  const handleRefreshTraces = async () => {
    if (!agentRunId) return;

    setIsSearching(true);
    try {
      const result = await fetchTracesByRunIds([agentRunId]);
      setSpans(result.spans);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : 'Refresh failed');
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Trace Viewer</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Visualize OpenTelemetry traces from agent executions
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 overflow-hidden">
        {/* Search / Query Tabs */}
        <Tabs defaultValue="search" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="search">
              <Search size={14} className="mr-1.5" />
              Search by Trace ID
            </TabsTrigger>
            <TabsTrigger value="agent">
              <Play size={14} className="mr-1.5" />
              Query Agent
            </TabsTrigger>
          </TabsList>

          {/* Search Tab */}
          <TabsContent value="search" className="mt-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex gap-3 items-end">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="traceId">Trace ID</Label>
                    <Input
                      id="traceId"
                      placeholder="Enter trace ID (e.g., abc123def456...)"
                      value={traceId}
                      onChange={(e) => setTraceId(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    />
                  </div>
                  <Button
                    onClick={handleSearch}
                    disabled={isSearching || !traceId.trim()}
                  >
                    {isSearching ? (
                      <RefreshCw size={16} className="mr-1.5 animate-spin" />
                    ) : (
                      <Search size={16} className="mr-1.5" />
                    )}
                    Search
                  </Button>
                </div>
                {searchError && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-red-500">
                    <AlertCircle size={14} />
                    {searchError}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Agent Query Tab */}
          <TabsContent value="agent" className="mt-4">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Agent</Label>
                    <Select value={selectedAgentName} onValueChange={setSelectedAgentName}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DEFAULT_CONFIG.agents.map(a => (
                          <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Judge Model</Label>
                    <Select value={selectedModel} onValueChange={setSelectedModel}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {agent?.models.map(m => (
                          <SelectItem key={m} value={m}>
                            {DEFAULT_CONFIG.models[m]?.display_name || m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="question">Question</Label>
                  <Input
                    id="question"
                    placeholder="Ask the agent a question..."
                    value={agentQuestion}
                    onChange={(e) => setAgentQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAgentQuery()}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    onClick={handleAgentQuery}
                    disabled={isQuerying || !agentQuestion.trim()}
                    className="bg-opensearch-blue hover:bg-blue-600"
                  >
                    {isQuerying ? (
                      <RefreshCw size={16} className="mr-1.5 animate-spin" />
                    ) : (
                      <Play size={16} className="mr-1.5" />
                    )}
                    Query Agent
                  </Button>
                  {agentRunId && (
                    <>
                      <span className="text-xs text-muted-foreground font-mono">
                        Run: {agentRunId.substring(0, 8)}...
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRefreshTraces}
                        disabled={isSearching}
                      >
                        <RefreshCw size={14} className={isSearching ? 'animate-spin' : ''} />
                      </Button>
                    </>
                  )}
                </div>
                {agentError && (
                  <div className="flex items-center gap-2 text-sm text-red-500">
                    <AlertCircle size={14} />
                    {agentError}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Trace Visualization */}
        <Card className="flex-1 flex flex-col overflow-hidden">
          <CardHeader className="py-2 px-4 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity size={14} />
                Trace Viewer
              </CardTitle>
              <div className="flex items-center gap-3">
                <ViewToggle viewMode={viewMode} onChange={setViewMode} />
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{spans.length} spans</span>
                  {timeRange.duration > 0 && (
                    <span>{formatDuration(timeRange.duration)}</span>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-hidden flex flex-col">
            {spans.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                <Activity size={48} className="mb-4 opacity-20" />
                <p>No trace data to display</p>
                <p className="text-sm">Search by Trace ID or query an agent to see traces</p>
              </div>
            ) : (
              <>
                {/* View Content - Timeline or Tree */}
                <div className="flex-1 overflow-hidden border-b">
                  {viewMode === 'timeline' ? (
                    <ScrollArea className="h-full">
                      <TraceTimelineChart
                        spanTree={spanTree}
                        timeRange={timeRange}
                        selectedSpan={selectedSpan}
                        onSelect={setSelectedSpan}
                        expandedSpans={expandedSpans}
                        onToggleExpand={handleToggleExpand}
                      />
                    </ScrollArea>
                  ) : (
                    <div className="h-full p-4">
                      <TraceTreeView
                        spanTree={spanTree}
                        timeRange={timeRange}
                        selectedSpan={selectedSpan}
                        onSelectSpan={setSelectedSpan}
                        expandedSpans={expandedSpans}
                        onToggleExpand={handleToggleExpand}
                      />
                    </div>
                  )}
                </div>

                {/* Span Details Panel - only for timeline mode (tree has it integrated) */}
                {viewMode === 'timeline' && selectedSpan && (
                  <div className="h-[300px] overflow-hidden">
                    <SpanDetailsPanel
                      span={selectedSpan}
                      onClose={() => setSelectedSpan(null)}
                    />
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default TracesPage;
