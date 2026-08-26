/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Sparkles, AlertCircle, RefreshCw, BookOpen, Wrench, Brain, HelpCircle, Filter, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  clusterFailures,
  type FailureCluster,
  type FailureCaseEvidenceInput,
  type ClusterType,
  type ClusterFailuresResponse,
} from '@/services/client/comparisonClusterApi';
import {
  getTopTwoNextSteps,
  FEATURE_AREA_ICON_COLOR,
  FEATURE_AREA_LABEL,
  type NextStepAction,
} from './nextStepRecommendations';

export interface ClusterMembership {
  caseId: string;
  clusterIndex: number;
}

interface FailureClusterPanelProps {
  /** Display label for the losing run */
  loserLabel: string;
  /** Display label for the winning run */
  winnerLabel: string;
  /** Regressed cases with their evidence */
  cases: FailureCaseEvidenceInput[];
  /** Optional: focus the cluster filter — when set, the matching cluster is highlighted */
  activeCaseFilter?: string[];
  /** Called when user clicks "View N cases" on a cluster */
  onFilterByCases?: (caseIds: string[], clusterName: string) => void;
  /** Called whenever clustering completes so the page can color-tag rows */
  onClustersChange?: (clusters: FailureCluster[]) => void;
}

const clusterTypeMeta: Record<ClusterType, { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; tone: string; bg: string; ring: string; }> = {
  knowledge: {
    icon: BookOpen,
    label: 'Knowledge gap',
    tone: 'text-purple-300',
    bg: 'bg-purple-500/10',
    ring: 'border-purple-500/30',
  },
  tool_gap: {
    icon: Wrench,
    label: 'Tool gap',
    tone: 'text-blue-300',
    bg: 'bg-blue-500/10',
    ring: 'border-blue-500/30',
  },
  reasoning: {
    icon: Brain,
    label: 'Reasoning',
    tone: 'text-amber-300',
    bg: 'bg-amber-500/10',
    ring: 'border-amber-500/30',
  },
  other: {
    icon: HelpCircle,
    label: 'Other',
    tone: 'text-muted-foreground',
    bg: 'bg-muted/30',
    ring: 'border-border',
  },
};

/**
 * Stable color palette per cluster index — used by the parent table to draw
 * a small colored dot in each row that belongs to a cluster, so the user
 * can scan the table and see the failure pattern visually.
 */
export const CLUSTER_DOT_COLORS = [
  '#a78bfa', // violet
  '#60a5fa', // blue
  '#fbbf24', // amber
  '#f87171', // red
  '#34d399', // emerald
  '#f472b6', // pink
  '#94a3b8', // slate
] as const;

export const getClusterDotColor = (idx: number): string =>
  CLUSTER_DOT_COLORS[idx % CLUSTER_DOT_COLORS.length];

type Phase = 'idle' | 'loading' | 'loaded' | 'error';

// ─── Next-step strip (one per cluster) ───────────────────────────────────

const NextStepButton: React.FC<{
  action: NextStepAction;
  onActivate: (action: NextStepAction) => void;
}> = ({ action, onActivate }) => {
  const disabled = action.status === 'coming-soon';
  const dotColor = FEATURE_AREA_ICON_COLOR[action.featureArea];

  return (
    <button
      type="button"
      onClick={() => !disabled && onActivate(action)}
      disabled={disabled}
      className={cn(
        'group flex-1 min-w-0 text-left rounded-md border border-border px-2.5 py-1.5 transition-colors',
        disabled
          ? 'opacity-60 cursor-not-allowed bg-muted/20'
          : 'bg-background hover:bg-muted/40 hover:border-primary/40'
      )}
      title={
        disabled
          ? 'Coming soon — the destination page does not yet accept the seeded context.'
          : `Opens ${FEATURE_AREA_LABEL[action.featureArea]}`
      }
    >
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
          style={{ backgroundColor: dotColor }}
          aria-hidden
        />
        <span className="text-[11px] font-medium leading-tight truncate">{action.label}</span>
        {disabled ? (
          <span className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground shrink-0">
            soon
          </span>
        ) : (
          <ChevronRight
            size={11}
            className="ml-auto text-muted-foreground group-hover:text-foreground shrink-0"
          />
        )}
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight truncate">
        {action.sublabel}
      </div>
    </button>
  );
};

const NextStepStrip: React.FC<{ cluster: FailureCluster }> = ({ cluster }) => {
  const navigate = useNavigate();
  const actions = getTopTwoNextSteps(cluster.clusterType);
  if (actions.length === 0) return null;

  const onActivate = (action: NextStepAction) => {
    if (action.target.kind === 'route') {
      // Pass the clusterId as a query param so the receiving page can
      // optionally fetch context (most read it; some — like /traces — just
      // navigate generically).
      const sep = action.target.path.includes('?') ? '&' : '?';
      navigate(`${action.target.path}${sep}clusterId=${encodeURIComponent(cluster.id)}`);
    } else if (action.target.kind === 'route-with-state') {
      navigate(`${action.target.path}?clusterId=${encodeURIComponent(cluster.id)}`, {
        state: {
          [action.target.stateKey]: {
            clusterId: cluster.id,
            clusterName: cluster.name,
            clusterSummary: cluster.summary,
            clusterType: cluster.clusterType,
            caseIds: cluster.caseIds,
          },
        },
      });
    } else {
      // 'modal' — open in-place. Dispatch a custom event the parent page
      // listens for; keeps this component decoupled from any specific modal.
      window.dispatchEvent(new CustomEvent('comparison:open-modal', {
        detail: {
          modalKey: action.target.modalKey,
          cluster: {
            id: cluster.id,
            name: cluster.name,
            summary: cluster.summary,
            clusterType: cluster.clusterType,
            caseIds: cluster.caseIds,
          },
        },
      }));
    }
  };

  return (
    <div className="mt-1.5 ml-4 flex gap-1.5 flex-wrap">
      {actions.map(a => (
        <NextStepButton key={a.id} action={a} onActivate={onActivate} />
      ))}
    </div>
  );
};

export const FailureClusterPanel: React.FC<FailureClusterPanelProps> = ({
  loserLabel,
  winnerLabel,
  cases,
  activeCaseFilter,
  onFilterByCases,
  onClustersChange,
}) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [clusters, setClusters] = useState<FailureCluster[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);

  const activeFilterSet = useMemo(
    () => new Set(activeCaseFilter ?? []),
    [activeCaseFilter]
  );

  // Tracks whether this component is still mounted. The cluster fetch
  // takes ~5-15s (LLM call), and the user may navigate away from the
  // comparison page while it's in flight. Without this guard, the
  // setState calls in the success/error paths fire on an unmounted
  // component — React logs a warning, and any future stale render could
  // blow up if the cluster list referenced freed data. We flip mountedRef
  // to false in the cleanup of a useEffect that runs once at mount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = async (force: boolean) => {
    if (cases.length === 0) return;
    setPhase('loading');
    setErrorMessage(null);
    try {
      const response: ClusterFailuresResponse = await clusterFailures({
        loserLabel,
        winnerLabel,
        cases,
        force,
      });
      if (!mountedRef.current) return;
      setClusters(response.clusters);
      setModelId(response.modelId);
      setPhase('loaded');
      onClustersChange?.(response.clusters);
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setPhase('error');
    }
  };

  if (cases.length === 0) {
    // Nothing to cluster — keep the panel out of the layout entirely.
    return null;
  }

  if (phase === 'idle') {
    // Single slim line — this sits inside the Table Compare block now, so it
    // must read as a toolbar affordance, not a full-width banner.
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/10 px-3 py-1 flex items-center gap-2">
        <Sparkles size={12} className="text-purple-300 shrink-0" />
        <span className="text-[11px] font-medium">Analyze failure patterns</span>
        <span className="text-[10px] text-muted-foreground truncate">
          group {cases.length} regressed case{cases.length === 1 ? '' : 's'} by root cause
        </span>
        <Button
          size="sm"
          onClick={() => run(false)}
          className="h-5 gap-1 text-[10px] px-2 ml-auto"
        >
          <Sparkles size={10} />
          Analyze
        </Button>
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="rounded-lg border border-border bg-muted/10 px-4 py-3 flex items-center gap-3">
        <Loader2 size={14} className="animate-spin text-purple-300" />
        <div className="text-xs">
          <div className="font-medium">Clustering {cases.length} failure{cases.length === 1 ? '' : 's'}…</div>
          <div className="text-[10px] text-muted-foreground">
            Reading judge reasonings and grouping by root cause. This usually takes 5–10s.
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
        <div className="flex items-start gap-2">
          <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-xs font-medium text-red-300">Clustering failed</div>
            <div className="text-[10px] text-muted-foreground break-words">
              {errorMessage}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => run(true)}
            className="h-6 gap-1.5 text-[10px]"
          >
            <RefreshCw size={11} /> Retry
          </Button>
        </div>
      </div>
    );
  }

  // Loaded
  if (clusters.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/10 px-4 py-3 flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          No clear pattern emerged across {cases.length} failure{cases.length === 1 ? '' : 's'}.
          {' '}
          Failures may be unrelated, or there isn't enough judge evidence yet.
        </div>
        <Button size="sm" variant="outline" onClick={() => run(true)} className="h-6 gap-1.5 text-[10px]">
          <RefreshCw size={11} /> Re-analyze
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-2 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-purple-300" />
          <span className="text-xs font-medium">Failure patterns</span>
          <span className="text-[10px] text-muted-foreground">
            {clusters.length} pattern{clusters.length === 1 ? '' : 's'} across {cases.length} failure{cases.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          onClick={() => run(true)}
          className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          title={modelId ? `Model: ${modelId}` : undefined}
        >
          <RefreshCw size={10} /> Re-analyze
        </button>
      </div>
      <div className="p-3 grid gap-2 sm:grid-cols-2">
        {clusters.map((cluster, idx) => {
          const meta = clusterTypeMeta[cluster.clusterType];
          const Icon = meta.icon;
          const dotColor = getClusterDotColor(idx);
          const isActive =
            activeFilterSet.size > 0 &&
            cluster.caseIds.every(id => activeFilterSet.has(id)) &&
            cluster.caseIds.length === activeFilterSet.size;
          return (
            <div
              key={`${cluster.name}-${idx}`}
              className={cn(
                'rounded-md border bg-background px-3 py-2 flex flex-col gap-1.5 transition-colors',
                meta.ring,
                isActive && 'ring-2 ring-primary/50'
              )}
            >
              <div className="flex items-start gap-2">
                <span
                  className="mt-1 inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: dotColor }}
                  aria-hidden
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold leading-tight">{cluster.name}</span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border text-[9px] uppercase tracking-wide',
                        meta.bg,
                        meta.ring,
                        meta.tone
                      )}
                    >
                      <Icon size={9} /> {meta.label}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                    {cluster.summary}
                  </div>
                </div>
                <span className="text-[11px] font-medium tabular-nums text-foreground shrink-0">
                  {cluster.caseIds.length}
                </span>
              </div>
              {cluster.exampleEvidence && (
                <div className="text-[10px] italic text-muted-foreground border-l-2 border-border pl-2 ml-4">
                  &ldquo;{cluster.exampleEvidence}&rdquo;
                </div>
              )}
              <div className="flex items-center justify-between mt-1 ml-4">
                <span className="text-[10px] text-muted-foreground">
                  {cluster.caseIds.slice(0, 3).join(', ')}
                  {cluster.caseIds.length > 3 ? ` +${cluster.caseIds.length - 3}` : ''}
                </span>
                {onFilterByCases && (
                  <button
                    onClick={() => onFilterByCases(cluster.caseIds, cluster.name)}
                    className="text-[10px] text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <Filter size={10} />
                    {isActive ? 'Showing' : `View ${cluster.caseIds.length} case${cluster.caseIds.length === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
              <NextStepStrip cluster={cluster} />
            </div>
          );
        })}
      </div>
    </div>
  );
};
