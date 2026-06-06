/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EvaluatorVersionHistory
 *
 * Renders the version history for an evaluator and lets users:
 *   - browse every immutable snapshot ever saved
 *   - inspect a single version's content (read-only)
 *   - select two versions and view a Git-style diff of the system prompt
 *
 * This mirrors the "History" tab on the Skills page (which lists past
 * iterations of a skill run) but is specialized to evaluator config
 * snapshots and adds a unified diff renderer for prompt/scoring/inference
 * changes.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { GitCompare, History as HistoryIcon, RefreshCw, Eye } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ENV_CONFIG } from '@/lib/config';
import type { Evaluator, EvaluatorVersion } from '@/types';
import { UnifiedDiffView } from '@/components/diff/UnifiedDiffView';

interface EvaluatorVersionHistoryProps {
  evaluatorId: string;
  /** When the parent page saves a new version, bump this counter to refetch. */
  refreshKey?: number;
  /** System evaluators only have a single immutable version. */
  isSystem?: boolean;
}

type DiffMode = 'unified' | 'split';

/**
 * Pretty-print a version's timestamp (date + relative).
 */
function formatVersionDate(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Stringify a structured field (scoring/inference config) so it can be diffed
 * line-by-line just like the system prompt.
 */
function stringifyField(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const EvaluatorVersionHistory: React.FC<EvaluatorVersionHistoryProps> = ({
  evaluatorId,
  refreshKey = 0,
  isSystem = false,
}) => {
  const [versions, setVersions] = useState<EvaluatorVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selection state for compare. We allow at most two versions selected.
  const [selected, setSelected] = useState<number[]>([]);

  // Modal state for "view single version" and "compare two versions".
  const [viewVersion, setViewVersion] = useState<EvaluatorVersion | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [diffMode, setDiffMode] = useState<DiffMode>('unified');

  const loadVersions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${ENV_CONFIG.backendUrl}/api/storage/evaluators/${encodeURIComponent(evaluatorId)}/versions`
      );
      if (!response.ok) {
        throw new Error(`Failed to load versions (${response.status})`);
      }
      const data = await response.json();
      // The backend currently returns full Evaluator snapshots in `versions`.
      // Normalize each one into the EvaluatorVersion shape we render against.
      const list: EvaluatorVersion[] = (data.versions || []).map((v: any) => {
        // Heuristic: a true EvaluatorVersion has `version` + content fields
        // and *no* outer `versions` array; an Evaluator snapshot does.
        if (v && typeof v.version === 'number' && !Array.isArray(v.versions)) {
          return v as EvaluatorVersion;
        }
        const ev = v as Evaluator;
        return {
          version: ev.currentVersion ?? 1,
          createdAt: ev.updatedAt || ev.createdAt,
          systemPrompt: ev.systemPrompt,
          scoringConfig: ev.scoringConfig,
          inferenceConfig: ev.inferenceConfig,
        };
      });
      // Newest first — matches the way Git log lists commits.
      list.sort((a, b) => b.version - a.version);
      setVersions(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to load version history');
      setVersions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!evaluatorId) return;
    loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluatorId, refreshKey]);

  const toggleSelected = (version: number) => {
    setSelected((prev) => {
      if (prev.includes(version)) return prev.filter((v) => v !== version);
      // Always keep at most two — drop the oldest selection when a third is added.
      const next = [...prev, version];
      return next.length > 2 ? next.slice(next.length - 2) : next;
    });
  };

  const compareCandidates = useMemo(() => {
    if (selected.length !== 2) return null;
    const [a, b] = selected;
    // Compare older → newer so additions are "the latest changes".
    const olderVersion = Math.min(a, b);
    const newerVersion = Math.max(a, b);
    const before = versions.find((v) => v.version === olderVersion);
    const after = versions.find((v) => v.version === newerVersion);
    if (!before || !after) return null;
    return { before, after };
  }, [selected, versions]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HistoryIcon className="h-4 w-4" />
            Version History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground py-4">Loading version history…</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HistoryIcon className="h-4 w-4" />
            Version History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-destructive py-2">{error}</div>
          <Button variant="outline" size="sm" className="mt-2" onClick={loadVersions}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  // System evaluators only have a single, immutable v1 snapshot — there's
  // nothing meaningful to diff, so we hide the card entirely.
  if (isSystem || versions.length <= 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HistoryIcon className="h-4 w-4" />
            Version History
          </CardTitle>
          <CardDescription>
            {isSystem
              ? 'System evaluators are immutable. They always have a single version.'
              : 'No prior versions yet — save changes to start building history.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <HistoryIcon className="h-4 w-4" />
                Version History
                <Badge variant="secondary" className="ml-1">{versions.length}</Badge>
              </CardTitle>
              <CardDescription>
                Every save creates an immutable snapshot. Pick any two to view a
                Git-style diff of what changed.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={loadVersions}>
                <RefreshCw className="h-3.5 w-3.5 mr-2" /> Refresh
              </Button>
              <Button
                size="sm"
                disabled={selected.length !== 2}
                onClick={() => setCompareOpen(true)}
                title={selected.length !== 2 ? 'Select two versions to compare' : 'Compare selected versions'}
              >
                <GitCompare className="h-3.5 w-3.5 mr-2" />
                Compare ({selected.length}/2)
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead className="w-24">Version</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Metrics</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v, idx) => {
                const isLatest = idx === 0;
                const isChecked = selected.includes(v.version);
                return (
                  <TableRow
                    key={v.version}
                    className={isChecked ? 'bg-accent/40' : ''}
                  >
                    <TableCell>
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleSelected(v.version)}
                        aria-label={`Select version ${v.version}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono">
                      <div className="flex items-center gap-2">
                        v{v.version}
                        {isLatest && <Badge variant="default" className="text-[10px]">latest</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatVersionDate(v.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {v.scoringConfig?.metrics?.length ?? 0}
                      {v.scoringConfig?.passThreshold != null && (
                        <span className="text-muted-foreground"> · pass ≥ {v.scoringConfig.passThreshold}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {v.inferenceConfig?.provider || <span className="text-muted-foreground">default</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setViewVersion(v)}
                        title="View this version"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* View-single-version modal */}
      <Dialog open={!!viewVersion} onOpenChange={(open) => !open && setViewVersion(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Version v{viewVersion?.version}</DialogTitle>
            <DialogDescription>
              {viewVersion ? formatVersionDate(viewVersion.createdAt) : ''}
            </DialogDescription>
          </DialogHeader>
          {viewVersion && (
            <div className="space-y-4">
              <section>
                <h4 className="text-sm font-semibold mb-2">System Prompt</h4>
                <pre className="text-xs font-mono bg-muted/50 border rounded-md p-3 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                  {viewVersion.systemPrompt}
                </pre>
              </section>
              <section>
                <h4 className="text-sm font-semibold mb-2">Scoring Config</h4>
                <pre className="text-xs font-mono bg-muted/50 border rounded-md p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {stringifyField(viewVersion.scoringConfig)}
                </pre>
              </section>
              <section>
                <h4 className="text-sm font-semibold mb-2">Inference Config</h4>
                <pre className="text-xs font-mono bg-muted/50 border rounded-md p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {stringifyField(viewVersion.inferenceConfig)}
                </pre>
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Compare-two-versions modal */}
      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitCompare className="h-4 w-4" />
              {compareCandidates
                ? `Comparing v${compareCandidates.before.version} → v${compareCandidates.after.version}`
                : 'Compare versions'}
            </DialogTitle>
            <DialogDescription>
              Differences are shown like a Git diff. Use the toggle to switch between unified and split layouts.
            </DialogDescription>
          </DialogHeader>

          {compareCandidates && (
            <div className="space-y-4">
              <div className="flex items-center justify-end gap-1 text-xs">
                <span className="text-muted-foreground mr-2">Layout:</span>
                <Button
                  size="sm"
                  variant={diffMode === 'unified' ? 'default' : 'outline'}
                  onClick={() => setDiffMode('unified')}
                >
                  Unified
                </Button>
                <Button
                  size="sm"
                  variant={diffMode === 'split' ? 'default' : 'outline'}
                  onClick={() => setDiffMode('split')}
                >
                  Split
                </Button>
              </div>

              <section>
                <h4 className="text-sm font-semibold mb-2">System Prompt</h4>
                <UnifiedDiffView
                  before={compareCandidates.before.systemPrompt || ''}
                  after={compareCandidates.after.systemPrompt || ''}
                  beforeLabel={`v${compareCandidates.before.version}`}
                  afterLabel={`v${compareCandidates.after.version}`}
                  mode={diffMode}
                />
              </section>

              <section>
                <h4 className="text-sm font-semibold mb-2">Scoring Config</h4>
                <UnifiedDiffView
                  before={stringifyField(compareCandidates.before.scoringConfig)}
                  after={stringifyField(compareCandidates.after.scoringConfig)}
                  beforeLabel={`v${compareCandidates.before.version}`}
                  afterLabel={`v${compareCandidates.after.version}`}
                  mode={diffMode}
                />
              </section>

              <section>
                <h4 className="text-sm font-semibold mb-2">Inference Config</h4>
                <UnifiedDiffView
                  before={stringifyField(compareCandidates.before.inferenceConfig)}
                  after={stringifyField(compareCandidates.after.inferenceConfig)}
                  beforeLabel={`v${compareCandidates.before.version}`}
                  afterLabel={`v${compareCandidates.after.version}`}
                  mode={diffMode}
                />
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default EvaluatorVersionHistory;
