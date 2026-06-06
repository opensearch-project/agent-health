/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Next-step recommendations for failure clusters.
 *
 * Each clusterType maps to a small list of actions the user could take.
 * The strip on the comparison page renders the top two as buttons and
 * exposes the rest behind a "More options" affordance.
 *
 * Bias guardrails:
 *   - Top-1 across the four cluster types must span ≥3 distinct
 *     featureAreas — no single feature gets to be the default fix
 *     for more than one cluster type without help.
 *   - Every featureArea (skills, connectors, evaluators, traces,
 *     model-pick, test-cases) appears in at least one top-2 slot.
 *
 * Tests in tests/unit/components/comparison/nextStepRecommendations.test.ts
 * enforce both invariants.
 */

import type { ClusterType } from '@/services/client/comparisonClusterApi';

export type FeatureArea =
  | 'skills'
  | 'connectors'
  | 'evaluators'
  | 'traces'
  | 'model-pick'
  | 'test-cases';

export type ActionStatus = 'ready' | 'coming-soon';

export interface NextStepAction {
  /** Stable id used by tests + telemetry. */
  id: string;
  /** Verb-first user-language label (NOT the feature name). */
  label: string;
  /** Short helper text describing what happens next. */
  sublabel: string;
  /** Which feature page/modal this opens (used for color hint + telemetry). */
  featureArea: FeatureArea;
  /**
   * Where the user lands. 'route' navigates to a path; 'modal' opens a modal
   * in-place (the page is responsible for handling it); 'route-with-state'
   * navigates and asks the page to read prefilled state.
   */
  target:
    | { kind: 'route'; path: string }
    | { kind: 'route-with-state'; path: string; stateKey: string }
    | { kind: 'modal'; modalKey: string };
  /**
   * 'ready' — the receiving page already accepts the seeded state.
   * 'coming-soon' — we haven't wired the receiving page yet; show the
   *   button but disable it with a tooltip explaining why.
   */
  status: ActionStatus;
}

// All actions — ordered so each cluster type's first two entries are the
// top-2 recommendations.
const ACTIONS_BY_CLUSTER: Record<ClusterType, NextStepAction[]> = {
  knowledge: [
    {
      id: 'teach-the-agent',
      label: 'Teach the agent',
      sublabel: 'Write a Skill so it knows the missing facts',
      featureArea: 'skills',
      target: { kind: 'route-with-state', path: '/skills', stateKey: 'fromCluster' },
      status: 'ready',
    },
    {
      id: 'inspect-trace-knowledge',
      label: 'See where it went wrong',
      sublabel: 'Open the failing trace to read the agent’s steps',
      featureArea: 'traces',
      target: { kind: 'route', path: '/evaluations/runs' },
      status: 'ready',
    },
    {
      id: 'try-stronger-model-knowledge',
      label: 'Try a stronger model',
      sublabel: 'Re-run the failing cases on a different model',
      featureArea: 'model-pick',
      target: { kind: 'route-with-state', path: '/evaluations/runs/new', stateKey: 'fromCluster' },
      status: 'ready',
    },
  ],
  tool_gap: [
    {
      id: 'give-the-tool',
      label: 'Give it the missing tool',
      sublabel: 'Add or fix a connector / endpoint in Settings',
      featureArea: 'connectors',
      target: { kind: 'route-with-state', path: '/settings', stateKey: 'fromCluster' },
      status: 'ready',
    },
    {
      id: 'grade-tool-usage',
      label: 'Grade tool usage',
      sublabel: 'Re-evaluate with the Tool-Usage evaluator to confirm',
      featureArea: 'evaluators',
      target: { kind: 'route', path: '/evaluators' },
      status: 'ready',
    },
    {
      id: 'inspect-trace-tool',
      label: 'See where it went wrong',
      sublabel: 'Open the failing trace to find the missing/wrong tool call',
      featureArea: 'traces',
      target: { kind: 'route', path: '/evaluations/runs' },
      status: 'ready',
    },
  ],
  reasoning: [
    {
      id: 'try-stronger-model-reasoning',
      label: 'Try a stronger model',
      sublabel: 'Re-run the failing cases on a different model',
      featureArea: 'model-pick',
      target: { kind: 'route-with-state', path: '/evaluations/runs/new', stateKey: 'fromCluster' },
      status: 'ready',
    },
    {
      id: 'tighten-with-skill',
      label: 'Tighten its reasoning',
      sublabel: 'Write a Skill that nudges multi-step thinking',
      featureArea: 'skills',
      target: { kind: 'route-with-state', path: '/skills', stateKey: 'fromCluster' },
      status: 'ready',
    },
    {
      id: 'inspect-trace-reasoning',
      label: 'See where it went wrong',
      sublabel: 'Open the failing trace to spot the broken thought-chain',
      featureArea: 'traces',
      target: { kind: 'route', path: '/evaluations/runs' },
      status: 'ready',
    },
  ],
  other: [
    {
      id: 'inspect-trace-other',
      label: 'See where it went wrong',
      sublabel: 'Diagnose first — cluster pattern is unclear',
      featureArea: 'traces',
      target: { kind: 'route', path: '/evaluations/runs' },
      status: 'ready',
    },
    {
      id: 'try-different-judge',
      label: 'Try a different judge',
      sublabel: 'Re-grade with another evaluator to rule out judge bias',
      featureArea: 'evaluators',
      target: { kind: 'route', path: '/evaluators' },
      status: 'ready',
    },
    {
      id: 'expand-coverage',
      label: 'Add more test cases',
      sublabel: 'Lock in this regression with reproducible cases',
      featureArea: 'test-cases',
      target: { kind: 'route-with-state', path: '/evaluations/test-cases', stateKey: 'fromCluster' },
      status: 'ready',
    },
  ],
};

/** Return all candidate next-step actions for a cluster type (ordered). */
export function getNextSteps(clusterType: ClusterType): NextStepAction[] {
  return ACTIONS_BY_CLUSTER[clusterType] ?? ACTIONS_BY_CLUSTER.other;
}

/**
 * Pick the top two actions for the cluster strip.
 *
 * Two runtime guardrails:
 *   1. If both top-2 belong to the same featureArea (which would happen if
 *      someone hand-edits the catalog and reintroduces bias), substitute the
 *      second slot with the highest-ranked action from a different featureArea.
 *   2. If the catalog's top picks are all 'coming-soon' but a 'ready' action
 *      exists later in the list, promote at least one ready action into the
 *      top-2 — a strip with no clickable buttons is worse than a strip that
 *      slightly demotes the catalog's ranking.
 */
export function getTopTwoNextSteps(clusterType: ClusterType): NextStepAction[] {
  const all = getNextSteps(clusterType);
  if (all.length === 0) return [];
  if (all.length === 1) return [all[0]];

  let first = all[0];
  let second = all[1];

  // Guardrail 1: distinct feature areas in the top-2.
  if (second.featureArea === first.featureArea) {
    const alt = all.slice(2).find(a => a.featureArea !== first.featureArea);
    if (alt) second = alt;
  }

  // Guardrail 2: at least one ready action in the top-2 if any exist.
  const ready = all.filter(a => a.status === 'ready');
  const topTwoHaveReady = first.status === 'ready' || second.status === 'ready';
  if (!topTwoHaveReady && ready.length > 0) {
    // Replace the lower-priority slot (second) with the highest-ranked ready
    // action that has a different featureArea than first when possible.
    const readyWithDiffArea = ready.find(a => a.featureArea !== first.featureArea);
    second = readyWithDiffArea ?? ready[0];
  }

  return [first, second];
}

/** UI accent colors per feature area (used for a small badge, not the pill). */
export const FEATURE_AREA_ICON_COLOR: Record<FeatureArea, string> = {
  'skills': '#a78bfa',         // violet
  'connectors': '#5eead4',     // teal
  'evaluators': '#fbbf24',     // amber
  'traces': '#60a5fa',         // blue
  'model-pick': '#f472b6',     // pink
  'test-cases': '#94a3b8',     // slate
};

export const FEATURE_AREA_LABEL: Record<FeatureArea, string> = {
  'skills': 'Skills',
  'connectors': 'Connectors',
  'evaluators': 'Evaluators',
  'traces': 'Traces',
  'model-pick': 'Models',
  'test-cases': 'Test cases',
};
