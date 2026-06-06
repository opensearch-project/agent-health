/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getNextSteps,
  getTopTwoNextSteps,
  type FeatureArea,
} from '@/components/comparison/nextStepRecommendations';
import type { ClusterType } from '@/services/client/comparisonClusterApi';

const CLUSTER_TYPES: ClusterType[] = ['knowledge', 'tool_gap', 'reasoning', 'other'];

describe('nextStepRecommendations', () => {
  describe('shape', () => {
    it('every cluster type has at least 2 candidate actions', () => {
      for (const ct of CLUSTER_TYPES) {
        expect(getNextSteps(ct).length).toBeGreaterThanOrEqual(2);
      }
    });

    it('every action has non-empty label and sublabel', () => {
      for (const ct of CLUSTER_TYPES) {
        for (const a of getNextSteps(ct)) {
          expect(a.label.length).toBeGreaterThan(0);
          expect(a.sublabel.length).toBeGreaterThan(0);
          expect(a.id.length).toBeGreaterThan(0);
        }
      }
    });

    it('action labels are user-language verbs, not feature names', () => {
      // Sniff test: the label shouldn't be the feature name. "Skills" should
      // never appear as a label; verbs like "Teach" / "Try" / "See" should.
      const FEATURE_NAMES = ['Skills', 'Connectors', 'Evaluators', 'Traces', 'Model'];
      for (const ct of CLUSTER_TYPES) {
        for (const a of getNextSteps(ct)) {
          for (const fn of FEATURE_NAMES) {
            expect(a.label).not.toBe(fn);
            expect(a.label.startsWith(fn + ' ')).toBe(false);
          }
        }
      }
    });
  });

  describe('top-two bias guardrails', () => {
    it('top-1 across the four cluster types spans at least 3 distinct feature areas', () => {
      const top1Areas = new Set<FeatureArea>(
        CLUSTER_TYPES.map(ct => getTopTwoNextSteps(ct)[0].featureArea)
      );
      expect(top1Areas.size).toBeGreaterThanOrEqual(3);
    });

    it('no feature area appears as top-1 for more than one cluster type', () => {
      const counts = new Map<FeatureArea, number>();
      for (const ct of CLUSTER_TYPES) {
        const top = getTopTwoNextSteps(ct)[0].featureArea;
        counts.set(top, (counts.get(top) ?? 0) + 1);
      }
      for (const [area, count] of counts) {
        expect({ area, count }).toEqual({ area, count: 1 });
      }
    });

    it('top-2 for each cluster type uses two distinct feature areas', () => {
      // Runtime guardrail in getTopTwoNextSteps enforces this — verify it.
      for (const ct of CLUSTER_TYPES) {
        const [first, second] = getTopTwoNextSteps(ct);
        expect(first.featureArea).not.toBe(second.featureArea);
      }
    });

    it('union of top-2 across all cluster types covers ≥4 distinct feature areas', () => {
      const areas = new Set<FeatureArea>();
      for (const ct of CLUSTER_TYPES) {
        for (const a of getTopTwoNextSteps(ct)) areas.add(a.featureArea);
      }
      expect(areas.size).toBeGreaterThanOrEqual(4);
    });
  });

  describe('runtime substitution', () => {
    it('does not substitute when top-2 already differ', () => {
      // tool_gap has connectors then evaluators — distinct, so no swap.
      const [a, b] = getTopTwoNextSteps('tool_gap');
      expect(a.id).toBe('give-the-tool');
      expect(b.id).toBe('grade-tool-usage');
    });

    it('every clusterType has at least one ready action in its top-2', () => {
      // We never want the strip to show two unclickable buttons.
      for (const ct of CLUSTER_TYPES) {
        const top = getTopTwoNextSteps(ct);
        const anyReady = top.some(a => a.status === 'ready');
        expect({ ct, anyReady }).toEqual({ ct, anyReady: true });
      }
    });
  });
});
