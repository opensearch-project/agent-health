/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Play,
  Pencil,
  Trash2,
  FileText,
  Filter,
  Calendar,
  Upload,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
} from 'lucide-react';
import { asyncTestCaseStorage, asyncRunStorage, asyncBenchmarkStorage } from '@/services/storage';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';
import { TestCase } from '@/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { getLabelColor, formatDate } from '@/lib/utils';
import { TestCaseEditor } from './TestCaseEditor';
import { QuickRunModal } from './QuickRunModal';

// ==================== Helper Functions ====================

const groupByCategory = (testCases: TestCase[]): Record<string, TestCase[]> => {
  const grouped: Record<string, TestCase[]> = {};
  testCases.forEach((tc) => {
    const category = tc.category || 'Other';
    if (!grouped[category]) {
      grouped[category] = [];
    }
    grouped[category].push(tc);
  });
  // Sort categories alphabetically and sort test cases within each category by newest first
  return Object.keys(grouped)
    .sort()
    .reduce((acc, key) => {
      acc[key] = grouped[key].sort((a, b) => {
        const dateA = new Date(a.createdAt).getTime();
        const dateB = new Date(b.createdAt).getTime();
        return dateB - dateA; // Newest first
      });
      return acc;
    }, {} as Record<string, TestCase[]>);
};

// ==================== Sub-Components ====================

interface TestCaseCardProps {
  testCase: TestCase;
  runCount: number;
  onClick: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}

const TestCaseCard = ({ testCase, runCount, onClick, onRun, onEdit, onDelete, isDeleting }: TestCaseCardProps) => {
  // Show first 3 labels
  const displayLabels = (testCase.labels || []).slice(0, 3);

  return (
    <Card
      className="group hover:border-primary/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base truncate">{testCase.name}</CardTitle>
            <CardDescription className="flex items-center gap-2 mt-1 flex-wrap">
              {displayLabels.map((label) => (
                <Badge key={label} variant="outline" className={getLabelColor(label)}>
                  {label}
                </Badge>
              ))}
              {(testCase.labels || []).length > 3 && (
                <span className="text-xs text-muted-foreground">
                  +{(testCase.labels || []).length - 3} more
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {runCount} run{runCount !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar size={12} />
                {formatDate(testCase.createdAt, 'date')}
              </span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onRun(); }}
              title="Run test case"
            >
              <Play size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              title="Edit test case"
            >
              <Pencil size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              disabled={isDeleting}
              className="text-destructive hover:text-destructive"
              title="Delete test case"
            >
              {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm text-muted-foreground line-clamp-2">
          {testCase.initialPrompt}
        </p>
      </CardContent>
    </Card>
  );
};

interface CategorySectionProps {
  category: string;
  testCases: TestCase[];
  runCounts: Record<string, number>;
  isOpen: boolean;
  onToggle: () => void;
  onClick: (tc: TestCase) => void;
  onRun: (tc: TestCase) => void;
  onEdit: (tc: TestCase) => void;
  onDelete: (tc: TestCase) => void;
  deletingId: string | null;
}

const CategorySection = ({
  category,
  testCases,
  runCounts,
  isOpen,
  onToggle,
  onClick,
  onRun,
  onEdit,
  onDelete,
  deletingId,
}: CategorySectionProps) => {
  return (
    <Collapsible open={isOpen} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-4 py-3 h-auto font-semibold hover:bg-muted/50"
        >
          <div className="flex items-center gap-2">
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>{category}</span>
            <Badge variant="secondary" className="ml-2">
              {testCases.length}
            </Badge>
          </div>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 pl-6 pr-2 pb-4">
          {testCases.map((tc) => (
            <TestCaseCard
              key={tc.id}
              testCase={tc}
              runCount={runCounts[tc.id] || 0}
              onClick={() => onClick(tc)}
              onRun={() => onRun(tc)}
              onEdit={() => onEdit(tc)}
              onDelete={() => onDelete(tc)}
              isDeleting={deletingId === tc.id}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const EmptyState = ({ onCreateNew }: { onCreateNew: () => void }) => (
  <Card className="border-dashed">
    <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <FileText size={48} className="mb-4 opacity-20" />
      <p className="text-lg font-medium">No test cases yet</p>
      <p className="text-sm mb-4">Create your first test case to start evaluating agents</p>
      <Button onClick={onCreateNew}>
        <Plus size={16} className="mr-2" />
        Create Test Case
      </Button>
    </CardContent>
  </Card>
);

const NoResultsState = ({ onClearFilters }: { onClearFilters: () => void }) => (
  <Card className="border-dashed">
    <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <Filter size={48} className="mb-4 opacity-20" />
      <p className="text-lg font-medium">No test cases match your filters</p>
      <p className="text-sm mb-4">Try adjusting your search or filter criteria</p>
      <Button variant="outline" onClick={onClearFilters}>
        Clear Filters
      </Button>
    </CardContent>
  </Card>
);

const TestCasesPageSkeleton = () => (
  <div className="space-y-4">
    <div className="flex items-center gap-4">
      <Skeleton className="h-10 flex-1 max-w-sm" />
      <Skeleton className="h-10 w-[180px]" />
      <Skeleton className="h-10 w-[180px]" />
    </div>
    {[1, 2, 3].map((i) => (
      <div key={i} className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <div className="pl-6 space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    ))}
  </div>
);

// ==================== Main Component ====================

export const TestCasesPage: React.FC = () => {
  const navigate = useNavigate();

  // Data state
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [runCounts, setRunCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);

  // Pagination state
  const [afterCursor, setAfterCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterDifficulty, setFilterDifficulty] = useState<string>('all');

  // UI state
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
  const [showEditor, setShowEditor] = useState(false);
  const [editingTestCase, setEditingTestCase] = useState<TestCase | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TestCase | null>(null);
  const [runningTestCase, setRunningTestCase] = useState<TestCase | null>(null);

  // Import state
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete operation state
  const [deleteState, setDeleteState] = useState<{
    isDeleting: boolean;
    deletingId: string | null;
    status: 'idle' | 'success' | 'error';
    message: string;
  }>({ isDeleting: false, deletingId: null, status: 'idle', message: '' });

  // Load data (first page with summary mode)
  const loadData = async () => {
    setIsLoading(true);
    try {
      // Fetch test cases (summary, paginated) and run counts in parallel
      // Run counts use .catch() so test cases still render if the counts endpoint fails
      const [page, counts] = await Promise.all([
        asyncTestCaseStorage.getAll({ summary: true, size: 100 }),
        asyncRunStorage.getRunCountsByTestCase().catch(() => ({} as Record<string, number>)),
      ]);
      setTestCases(page.testCases);
      setAfterCursor(page.after ?? null);
      setHasMore(page.hasMore ?? false);
      setRunCounts(counts);

      // Derive categories from already-fetched test cases (no extra API call)
      const allCategories = Array.from(new Set(page.testCases.map(tc => tc.category))).sort();
      setCategories(allCategories);
      setOpenCategories(new Set(allCategories));
    } catch (error) {
      console.error('Failed to load test cases:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Load next page of test cases
  const loadMore = async () => {
    if (!afterCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await asyncTestCaseStorage.getAll({ summary: true, size: 100, after: afterCursor });
      setTestCases(prev => [...prev, ...page.testCases]);
      setAfterCursor(page.after ?? null);
      setHasMore(page.hasMore ?? false);

      // Update categories from newly loaded test cases
      setCategories(prev => {
        const newCategories = new Set([...prev, ...page.testCases.map(tc => tc.category)]);
        return Array.from(newCategories).sort();
      });
      setOpenCategories(prev => {
        const next = new Set(prev);
        page.testCases.forEach(tc => next.add(tc.category));
        return next;
      });
    } catch (error) {
      console.error('Failed to load more test cases:', error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Filter and group test cases
  const filteredTestCases = useMemo(() => {
    return testCases.filter((tc) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = tc.name.toLowerCase().includes(query);
        const matchesPrompt = tc.initialPrompt?.toLowerCase().includes(query);
        if (!matchesName && !matchesPrompt) return false;
      }

      // Category filter
      if (filterCategory !== 'all' && tc.category !== filterCategory) {
        return false;
      }

      // Difficulty filter
      if (filterDifficulty !== 'all' && tc.difficulty !== filterDifficulty) {
        return false;
      }

      return true;
    });
  }, [testCases, searchQuery, filterCategory, filterDifficulty]);

  const groupedTestCases = useMemo(() => {
    return groupByCategory(filteredTestCases);
  }, [filteredTestCases]);

  // Handlers
  const handleToggleCategory = (category: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const handleClick = (tc: TestCase) => {
    navigate(`/test-cases/${tc.id}/runs`);
  };

  const handleCreateNew = () => {
    setEditingTestCase(null);
    setShowEditor(true);
  };

  const handleEdit = (tc: TestCase) => {
    setEditingTestCase(tc);
    setShowEditor(true);
  };

  const handleRun = (tc: TestCase) => {
    setRunningTestCase(tc);
  };

  const handleRunModalClose = () => {
    setRunningTestCase(null);
  };

  const handleSaveAsTestCase = () => {
    // Reload data after saving a new test case from QuickRunModal
    loadData();
    setRunningTestCase(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;

    const targetName = deleteTarget.name;
    const targetId = deleteTarget.id;
    setDeleteTarget(null);
    setDeleteState({ isDeleting: true, deletingId: targetId, status: 'idle', message: '' });

    try {
      const success = await asyncTestCaseStorage.delete(targetId);
      if (success) {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'success', message: `"${targetName}" deleted` });
        setTimeout(() => setDeleteState(s => ({ ...s, status: 'idle', message: '' })), 3000);
        await loadData();
      } else {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'error', message: `Failed to delete "${targetName}"` });
      }
    } catch (error) {
      console.error('Failed to delete test case:', error);
      setDeleteState({
        isDeleting: false,
        deletingId: null,
        status: 'error',
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  const handleEditorClose = () => {
    setShowEditor(false);
    setEditingTestCase(null);
  };

  const handleEditorSave = async () => {
    setShowEditor(false);
    setEditingTestCase(null);
    await loadData();
  };

  const clearFilters = () => {
    setSearchQuery('');
    setFilterCategory('all');
    setFilterDifficulty('all');
  };

  const hasActiveFilters = searchQuery || filterCategory !== 'all' || filterDifficulty !== 'all';

  // Import handler
  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportError(null);

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const validation = validateTestCasesArrayJson(json);

      if (!validation.valid || !validation.data) {
        setImportError(`Validation failed: ${validation.errors[0]?.message || 'Invalid format'}`);
        return;
      }

      // Step 1: Create test cases
      const result = await asyncTestCaseStorage.bulkCreate(validation.data);

      if (result.created === 0) {
        setImportError('No test cases were created. They may already exist.');
        return;
      }

      // Step 2: Get IDs of created test cases (fetch latest to get generated IDs)
      const allTestCases = await asyncTestCaseStorage.getAll();
      const createdTestCaseIds = allTestCases
        .filter((tc) => validation.data!.some((d) => d.name === tc.name))
        .map((tc) => tc.id);

      // Step 3: Auto-create benchmark with imported test cases
      const benchmarkName = file.name.replace(/\.json$/i, '') || 'Imported Benchmark';
      const benchmark = await asyncBenchmarkStorage.create({
        name: benchmarkName,
        description: `Auto-created from import of ${result.created} test case(s)`,
        currentVersion: 1,
        versions: [
          {
            version: 1,
            createdAt: new Date().toISOString(),
            testCaseIds: createdTestCaseIds,
          },
        ],
        testCaseIds: createdTestCaseIds,
        runs: [],
      });

      // Navigate directly to the benchmark runs page
      navigate(`/benchmarks/${benchmark.id}/runs`);
    } catch (error) {
      console.error('Failed to import test cases:', error);
      setImportError(`Import failed: ${(error as Error).message}`);
    } finally {
      setIsImporting(false);
      event.target.value = ''; // Reset for re-upload
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6" data-testid="test-cases-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold" data-testid="test-cases-title">Test Cases</h2>
          <p className="text-muted-foreground">
            Manage your test case library ({testCases.length} total)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            data-testid="import-json-button"
          >
            <Upload size={16} className="mr-2" />
            {isImporting ? 'Importing...' : 'Import JSON'}
          </Button>
          <Button onClick={handleCreateNew} data-testid="new-test-case-button">
            <Plus size={16} className="mr-2" />
            New Test Case
          </Button>
        </div>
      </div>

      {isLoading ? (
        <TestCasesPageSkeleton />
      ) : testCases.length === 0 ? (
        <EmptyState onCreateNew={handleCreateNew} />
      ) : (
        <>
          {/* Filter Bar */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder="Search test cases..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="search-test-cases"
              />
            </div>

            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={filterDifficulty} onValueChange={setFilterDifficulty}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Difficulties" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Difficulties</SelectItem>
                <SelectItem value="Easy">Easy</SelectItem>
                <SelectItem value="Medium">Medium</SelectItem>
                <SelectItem value="Hard">Hard</SelectItem>
              </SelectContent>
            </Select>

            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear
              </Button>
            )}
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

          {/* Test Cases List */}
          {filteredTestCases.length === 0 ? (
            <NoResultsState onClearFilters={clearFilters} />
          ) : (
            <div className="space-y-2">
              {Object.entries(groupedTestCases).map(([category, tcs]) => (
                <CategorySection
                  key={category}
                  category={category}
                  testCases={tcs}
                  runCounts={runCounts}
                  isOpen={openCategories.has(category)}
                  onToggle={() => handleToggleCategory(category)}
                  onClick={handleClick}
                  onRun={handleRun}
                  onEdit={handleEdit}
                  onDelete={(tc) => setDeleteTarget(tc)}
                  deletingId={deleteState.isDeleting ? deleteState.deletingId : null}
                />
              ))}

              {/* Load More button */}
              {hasMore && !isLoadingMore && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" onClick={loadMore}>
                    Load More
                  </Button>
                </div>
              )}
              {isLoadingMore && (
                <div className="flex justify-center pt-4">
                  <Loader2 size={20} className="animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Editor Modal */}
      {showEditor && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
          <div className="fixed inset-4 z-50 overflow-auto bg-background border rounded-lg shadow-lg">
            <TestCaseEditor
              testCase={editingTestCase}
              onSave={handleEditorSave}
              onCancel={handleEditorClose}
            />
          </div>
        </div>
      )}

      {/* Quick Run Modal */}
      {runningTestCase && (
        <QuickRunModal
          testCase={runningTestCase}
          onClose={handleRunModalClose}
          onSaveAsTestCase={handleSaveAsTestCase}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Test Case</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import Error Dialog */}
      <AlertDialog open={!!importError} onOpenChange={() => setImportError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import Failed</AlertDialogTitle>
            <AlertDialogDescription>{importError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setImportError(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
