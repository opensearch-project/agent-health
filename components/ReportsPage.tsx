/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  Filter,
  ArrowUpDown,
  Eye,
  GitCompare,
  ChevronRight,
  AlertCircle,
  Loader2
} from 'lucide-react';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { CATEGORIES } from '@/data/testCases';
import { EvaluationReport, TestCase, TraceMetrics } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate } from '@/lib/utils';
import { fetchBatchMetrics, formatCost, formatDuration, formatTokens } from '@/services/metrics';
import { RunDetailsPanel } from './RunDetailsPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export const ReportsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTestCase, setSelectedTestCase] = useState<string | null>(
    searchParams.get('testCase') || null
  );
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [selectedReports, setSelectedReports] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'timestamp' | 'accuracy'>('timestamp');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [viewingReport, setViewingReport] = useState<EvaluationReport | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [testCaseStats, setTestCaseStats] = useState<{ testCase: TestCase; count: number; reports: EvaluationReport[] }[]>([]);
  const [totalReports, setTotalReports] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [metricsMap, setMetricsMap] = useState<Map<string, TraceMetrics>>(new Map());

  // Load evals on mount
  useEffect(() => {
    const loadTestCases = async () => {
      const tcs = await asyncTestCaseStorage.getAll();
      setTestCases(tcs);
    };
    loadTestCases();
  }, []);

  // Load reports when filter/sort changes
  useEffect(() => {
    const loadReports = async () => {
      setIsLoading(true);
      try {
        let allReports: EvaluationReport[];
        if (selectedTestCase) {
          allReports = await asyncRunStorage.getReportsByTestCase(selectedTestCase, {
            sortBy,
            order: sortOrder,
          });
        } else {
          allReports = await asyncRunStorage.getAllReports({ sortBy, order: sortOrder });
        }
        const filteredReports = filterStatus === 'all'
          ? allReports
          : allReports.filter(r => r.passFailStatus === filterStatus);
        setReports(filteredReports);
      } finally {
        setIsLoading(false);
      }
    };
    loadReports();
  }, [selectedTestCase, sortBy, sortOrder, filterStatus]);

  // Fetch trace metrics for reports with runIds
  useEffect(() => {
    const loadMetrics = async () => {
      const runIds = reports.filter(r => r.runId).map(r => r.runId!);
      if (runIds.length === 0) {
        setMetricsMap(new Map());
        return;
      }

      try {
        const { metrics } = await fetchBatchMetrics(runIds);
        const map = new Map<string, TraceMetrics>();
        metrics.forEach(m => {
          if (m.runId && !('error' in m)) {
            map.set(m.runId, m as TraceMetrics);
          }
        });
        setMetricsMap(map);
      } catch (error) {
        console.warn('[ReportsPage] Failed to fetch metrics:', error);
      }
    };

    if (reports.length > 0) {
      loadMetrics();
    }
  }, [reports]);

  // Load eval stats
  useEffect(() => {
    const loadStats = async () => {
      const count = await asyncRunStorage.getReportCount();
      setTotalReports(count);

      const filteredTestCases = filterCategory === 'all'
        ? testCases
        : testCases.filter(tc => tc.category === filterCategory);

      const stats = await Promise.all(
        filteredTestCases.map(async tc => ({
          testCase: tc,
          count: (await asyncRunStorage.getReportsByTestCase(tc.id, { limit: 1 })).length > 0 ? 1 : 0,
          reports: await asyncRunStorage.getReportsByTestCase(tc.id, { limit: 1 }),
        }))
      );
      setTestCaseStats(stats);
    };
    if (testCases.length > 0) {
      loadStats();
    }
  }, [testCases, filterCategory]);

  useEffect(() => {
    if (selectedTestCase) {
      setSearchParams({ testCase: selectedTestCase });
    } else {
      setSearchParams({});
    }
  }, [selectedTestCase, setSearchParams]);

  // Reset selected eval when category filter changes
  useEffect(() => {
    if (filterCategory !== 'all' && selectedTestCase) {
      const testCase = testCases.find(tc => tc.id === selectedTestCase);
      if (testCase && testCase.category !== filterCategory) {
        setSelectedTestCase(null);
      }
    }
  }, [filterCategory, testCases, selectedTestCase]);

  const filteredTestCases = filterCategory === 'all'
    ? testCases
    : testCases.filter(tc => tc.category === filterCategory);

  const handleTestCaseSelect = (testCaseId: string | null) => {
    setSelectedTestCase(testCaseId);
    setSelectedReports(new Set());
  };

  const handleReportSelect = (reportId: string) => {
    const newSelected = new Set(selectedReports);
    if (newSelected.has(reportId)) {
      newSelected.delete(reportId);
    } else {
      newSelected.add(reportId);
    }
    setSelectedReports(newSelected);
  };

  const toggleSort = (field: 'timestamp' | 'accuracy') => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  const selectedTestCaseData = testCases.find(tc => tc.id === selectedTestCase);

  return (
    <div className="h-full flex">
      {/* Sidebar: Eval List */}
      <Card className="w-80 rounded-none border-0 border-r flex flex-col">
        <CardHeader className="border-b pb-3">
          <CardTitle className="flex items-center text-lg">
            <FileText size={18} className="mr-2" />
            Evals
          </CardTitle>
          <p className="text-xs text-muted-foreground mb-2">{totalReports} total reports</p>
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-full text-xs h-8">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories ({testCases.length})</SelectItem>
              {CATEGORIES.map(cat => (
                <SelectItem key={cat} value={cat}>
                  {cat} ({testCases.filter(tc => tc.category === cat).length})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>

        <ScrollArea className="flex-1">
          {/* All Reports Option */}
          <button
            onClick={() => handleTestCaseSelect(null)}
            className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
              selectedTestCase === null
                ? 'bg-blue-950/30 border-l-4 border-l-opensearch-blue'
                : 'hover:bg-muted/50'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">All Evals</span>
              <span className="text-xs text-muted-foreground">{totalReports}</span>
            </div>
          </button>

          {/* Individual Evals */}
          {testCaseStats.map(({ testCase, count, reports: latestReports }) => (
            <button
              key={testCase.id}
              onClick={() => handleTestCaseSelect(testCase.id)}
              className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
                selectedTestCase === testCase.id
                  ? 'bg-blue-950/30 border-l-4 border-l-opensearch-blue'
                  : 'hover:bg-muted/50'
              }`}
            >
              <div className="flex items-start justify-between mb-1">
                <span className="text-sm font-medium flex-1 pr-2">
                  {testCase.name}
                </span>
                <span className="text-xs text-muted-foreground">{count}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className={
                  testCase.difficulty === 'Easy'
                    ? 'bg-blue-900/30 text-blue-400 border-blue-800'
                    : testCase.difficulty === 'Medium'
                    ? 'bg-yellow-900/30 text-yellow-400 border-yellow-800'
                    : 'bg-red-900/30 text-red-400 border-red-800'
                }>
                  {testCase.difficulty}
                </Badge>
                <span>{testCase.category}</span>
              </div>
              {latestReports.length > 0 && (
                <div className="mt-1.5 text-xs text-muted-foreground">
                  Last run: {formatDate(latestReports[0].timestamp).split(',')[0]}
                </div>
              )}
            </button>
          ))}
        </ScrollArea>
      </Card>

      {/* Main Content: Run History Table */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="bg-card border-b border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-xl font-bold">
                {selectedTestCaseData ? selectedTestCaseData.name : 'All Reports'}
              </h2>
              {selectedTestCaseData && (
                <p className="text-sm text-muted-foreground mt-1">{selectedTestCaseData.description}</p>
              )}
            </div>
            {selectedReports.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{selectedReports.size} selected</span>
                <Button
                  disabled={selectedReports.size !== 2}
                  variant={selectedReports.size === 2 ? 'default' : 'secondary'}
                  className={selectedReports.size === 2 ? 'bg-blue-500 hover:bg-blue-600' : ''}
                >
                  <GitCompare size={16} className="mr-2" />
                  Compare
                </Button>
              </div>
            )}
          </div>

          {/* Filters and Sort */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-muted-foreground" />
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="passed">Passed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <ArrowUpDown size={14} className="text-muted-foreground" />
              <Button
                variant={sortBy === 'timestamp' ? 'default' : 'secondary'}
                size="sm"
                onClick={() => toggleSort('timestamp')}
                className={sortBy === 'timestamp' ? 'bg-opensearch-blue hover:bg-blue-600' : ''}
              >
                Date {sortBy === 'timestamp' && (sortOrder === 'desc' ? '↓' : '↑')}
              </Button>
              <Button
                variant={sortBy === 'accuracy' ? 'default' : 'secondary'}
                size="sm"
                onClick={() => toggleSort('accuracy')}
                className={sortBy === 'accuracy' ? 'bg-opensearch-blue hover:bg-blue-600' : ''}
              >
                Accuracy {sortBy === 'accuracy' && (sortOrder === 'desc' ? '↓' : '↑')}
              </Button>
            </div>
          </div>
        </div>

        {/* Table */}
        <ScrollArea className="flex-1">
          {reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <AlertCircle size={48} className="mb-4 opacity-20" />
              <p className="text-lg">No reports found</p>
              <p className="text-sm mt-1">
                {selectedTestCase
                  ? 'No evaluation runs for this eval yet'
                  : 'Run an evaluation to see reports here'}
              </p>
              <Button asChild className="mt-4 bg-opensearch-blue hover:bg-blue-600">
                <Link to="/run">Run Evaluation</Link>
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-card sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-12"></TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Eval</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-center">Accuracy</TableHead>
                  <TableHead className="text-center">Faithfulness</TableHead>
                  <TableHead className="text-center">Steps</TableHead>
                  <TableHead className="text-center">Tokens</TableHead>
                  <TableHead className="text-center">Cost</TableHead>
                  <TableHead className="text-center">Duration</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((report) => {
                  const testCase = testCases.find(tc => tc.id === report.testCaseId);
                  const isSelected = selectedReports.has(report.id);

                  return (
                    <TableRow
                      key={report.id}
                      className={isSelected ? 'bg-blue-950/20' : ''}
                    >
                      <TableCell>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => handleReportSelect(report.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm">
                          <Clock size={12} className="mr-1.5 text-muted-foreground" />
                          {formatDate(report.timestamp)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{testCase?.name || 'Unknown'}</div>
                        <div className="text-xs text-muted-foreground">{testCase?.difficulty} - {testCase?.category}</div>
                      </TableCell>
                      <TableCell className="text-sm">{report.agentName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {DEFAULT_CONFIG.models[report.modelName]?.display_name || report.modelName}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={report.passFailStatus === 'passed' ? 'default' : 'destructive'}
                          className={report.passFailStatus === 'passed'
                            ? 'bg-blue-900/30 text-opensearch-blue'
                            : 'bg-red-900/30 text-red-400'}
                        >
                          {report.passFailStatus === 'passed' ? (
                            <CheckCircle2 size={12} className="mr-1" />
                          ) : (
                            <XCircle size={12} className="mr-1" />
                          )}
                          {report.passFailStatus?.toUpperCase() || report.status.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <span className="text-sm font-semibold text-opensearch-blue">
                          {report.metrics.accuracy}%
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        <span className="text-sm font-semibold text-blue-400">
                          {report.metrics.faithfulness}%
                        </span>
                      </TableCell>
                      <TableCell className="text-center text-sm text-muted-foreground">
                        {report.trajectory.length}
                      </TableCell>
                      <TableCell className="text-center text-sm text-muted-foreground">
                        {report.runId && metricsMap.has(report.runId)
                          ? formatTokens(metricsMap.get(report.runId)!.totalTokens)
                          : '—'}
                      </TableCell>
                      <TableCell className="text-center text-sm text-amber-400">
                        {report.runId && metricsMap.has(report.runId)
                          ? formatCost(metricsMap.get(report.runId)!.costUsd)
                          : '—'}
                      </TableCell>
                      <TableCell className="text-center text-sm text-muted-foreground">
                        {report.runId && metricsMap.has(report.runId)
                          ? formatDuration(metricsMap.get(report.runId)!.durationMs)
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setViewingReport(report)}
                        >
                          <Eye size={14} className="mr-1" />
                          View
                          <ChevronRight size={12} className="ml-1" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </div>

      {/* Run Details Panel */}
      {viewingReport && (
        <RunDetailsPanel
          report={viewingReport}
          onClose={() => setViewingReport(null)}
        />
      )}
    </div>
  );
};
