/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Play, Pencil, Trash2, CheckCircle, CheckCircle2, History, Filter, Loader2, XCircle, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TestCase } from '@/types';
import { asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { getDifficultyColor } from '@/lib/utils';
import { TestCaseEditor } from './TestCaseEditor';
import { QuickRunModal } from './QuickRunModal';

export const EvalsPage: React.FC = () => {
  const navigate = useNavigate();
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [categories, setCategories] = useState<string[]>([]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingTestCase, setEditingTestCase] = useState<TestCase | null>(null);
  const [runningTestCase, setRunningTestCase] = useState<TestCase | null>(null);
  const [isQuickRunOpen, setIsQuickRunOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [runCounts, setRunCounts] = useState<Record<string, number>>({});

  // Delete operation state
  const [deleteState, setDeleteState] = useState<{
    isDeleting: boolean;
    deletingId: string | null;
    status: 'idle' | 'success' | 'error';
    message: string;
  }>({ isDeleting: false, deletingId: null, status: 'idle', message: '' });

  const loadTestCases = useCallback(async () => {
    setIsLoading(true);
    try {
      const [tcs, cats] = await Promise.all([
        asyncTestCaseStorage.getAll(),
        asyncTestCaseStorage.getCategories(),
      ]);
      setTestCases(tcs);
      setCategories(cats);

      // Load run counts for each test case
      const counts: Record<string, number> = {};
      await Promise.all(
        tcs.map(async (tc) => {
          const reports = await asyncRunStorage.getReportsByTestCase(tc.id, { limit: 1 });
          counts[tc.id] = reports.length;
        })
      );
      setRunCounts(counts);
    } catch (error) {
      console.error('Failed to load test cases:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTestCases();
  }, [loadTestCases]);

  const filteredTestCases = categoryFilter === 'all'
    ? testCases
    : testCases.filter(tc => tc.category === categoryFilter);

  const handleNewTestCase = () => {
    setEditingTestCase(null);
    setIsEditorOpen(true);
  };

  const handleEditTestCase = (testCase: TestCase) => {
    setEditingTestCase(testCase);
    setIsEditorOpen(true);
  };

  const handleDeleteTestCase = async (testCase: TestCase) => {
    if (!window.confirm(`Delete test case "${testCase.name}"? This cannot be undone.`)) return;

    setDeleteState({ isDeleting: true, deletingId: testCase.id, status: 'idle', message: '' });

    try {
      const success = await asyncTestCaseStorage.delete(testCase.id);
      if (success) {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'success', message: `"${testCase.name}" deleted` });
        setTimeout(() => setDeleteState(s => ({ ...s, status: 'idle', message: '' })), 3000);
        loadTestCases();
      } else {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'error', message: `Failed to delete "${testCase.name}"` });
      }
    } catch (error) {
      setDeleteState({
        isDeleting: false,
        deletingId: null,
        status: 'error',
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  const handleSaveTestCase = () => {
    loadTestCases();
    setIsEditorOpen(false);
    setEditingTestCase(null);
  };

  const handleTogglePromoted = async (testCase: TestCase) => {
    await asyncTestCaseStorage.setPromoted(testCase.id, !testCase.isPromoted);
    loadTestCases();
  };

  const handleRunTestCase = (testCase: TestCase) => {
    setRunningTestCase(testCase);
    setIsQuickRunOpen(true);
  };

  const handleQuickRun = () => {
    // Ad-hoc quick run without a test case
    setRunningTestCase(null);
    setIsQuickRunOpen(true);
  };

  const getRunCount = (testCaseId: string): number => {
    return runCounts[testCaseId] || 0;
  };

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Evals</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {testCases.length} test case{testCases.length !== 1 ? 's' : ''}
            {testCases.filter(tc => tc.isPromoted).length > 0 && (
              <span> · {testCases.filter(tc => tc.isPromoted).length} saved</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleQuickRun}
          >
            <Play size={16} className="mr-2" />
            Quick Run
          </Button>
          <Button
            onClick={handleNewTestCase}
            className="bg-opensearch-blue hover:bg-blue-600 text-white"
          >
            <Plus size={18} className="mr-2" />
            New Test Case
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-muted-foreground" />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map(cat => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Delete Feedback */}
      {deleteState.message && (
        <div className={`flex items-center gap-2 text-sm p-3 rounded-lg mb-4 ${
          deleteState.status === 'success'
            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {deleteState.status === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span>{deleteState.message}</span>
          {deleteState.status === 'error' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteState(s => ({ ...s, status: 'idle', message: '' }))}
              className="ml-auto h-6 px-2"
            >
              <X size={14} />
            </Button>
          )}
        </div>
      )}

      {/* Test Case List */}
      <ScrollArea className="flex-1">
        <div className="space-y-3 pr-4">
          {filteredTestCases.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <p className="text-lg font-medium">No test cases yet</p>
                <p className="text-sm">Create your first test case to get started</p>
                <Button
                  onClick={handleNewTestCase}
                  variant="outline"
                  className="mt-4"
                >
                  <Plus size={16} className="mr-2" />
                  Create Test Case
                </Button>
              </CardContent>
            </Card>
          ) : (
            filteredTestCases.map(testCase => {
              const runCount = getRunCount(testCase.id);

              return (
                <Card key={testCase.id} className="hover:border-muted-foreground/30 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      {/* Main Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {testCase.isPromoted && (
                            <CheckCircle size={14} className="text-opensearch-blue" />
                          )}
                          <h3 className="text-base font-semibold truncate">{testCase.name}</h3>
                          <Badge variant="outline" className={`text-xs ${getDifficultyColor(testCase.difficulty)}`}>
                            {testCase.difficulty}
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            v{testCase.currentVersion}
                          </Badge>
                        </div>

                        <p className="text-sm text-muted-foreground mb-2 line-clamp-1">
                          {testCase.initialPrompt}
                        </p>

                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>{testCase.category}</span>
                          {testCase.subcategory && (
                            <>
                              <span className="text-muted-foreground/50">·</span>
                              <span>{testCase.subcategory}</span>
                            </>
                          )}
                          {runCount > 0 && (
                            <>
                              <span className="text-muted-foreground/50">·</span>
                              <span>{runCount} run{runCount !== 1 ? 's' : ''}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRunTestCase(testCase)}
                        >
                          <Play size={14} className="mr-1" />
                          Run
                        </Button>
                        {runCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/reports?testCase=${testCase.id}`)}
                            title="View run history"
                          >
                            <History size={14} className="mr-1" />
                            History
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditTestCase(testCase)}
                          title="Edit"
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleTogglePromoted(testCase)}
                          title={testCase.isPromoted ? "Remove from My Test Cases" : "Save to My Test Cases"}
                          className={testCase.isPromoted ? "text-opensearch-blue" : ""}
                        >
                          <CheckCircle size={14} className={testCase.isPromoted ? "" : "opacity-50"} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteTestCase(testCase)}
                          disabled={deleteState.isDeleting && deleteState.deletingId === testCase.id}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          title="Delete"
                        >
                          {deleteState.isDeleting && deleteState.deletingId === testCase.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Test Case Editor Modal */}
      {isEditorOpen && (
        <TestCaseEditor
          testCase={editingTestCase}
          onSave={handleSaveTestCase}
          onCancel={() => {
            setIsEditorOpen(false);
            setEditingTestCase(null);
          }}
        />
      )}

      {/* Quick Run Modal */}
      {isQuickRunOpen && (
        <QuickRunModal
          testCase={runningTestCase}
          onClose={() => {
            setIsQuickRunOpen(false);
            setRunningTestCase(null);
          }}
          onSaveAsTestCase={(tc) => {
            loadTestCases();
            setIsQuickRunOpen(false);
            setRunningTestCase(null);
          }}
        />
      )}
    </div>
  );
};
