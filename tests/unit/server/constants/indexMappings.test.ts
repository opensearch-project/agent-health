/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getIndexMappings, INDEX_MAPPINGS } from '@/server/constants/indexMappings';

describe('indexMappings', () => {
  describe('getIndexMappings', () => {
    it('should return index mappings object', () => {
      const mappings = getIndexMappings();
      expect(mappings).toBeDefined();
      expect(typeof mappings).toBe('object');
    });

    it('should have test cases index mapping', () => {
      const mappings = getIndexMappings();
      const testCasesKey = Object.keys(mappings).find((k) => k.includes('test_cases'));
      expect(testCasesKey).toBeDefined();

      const testCasesMapping = mappings[testCasesKey!];
      expect(testCasesMapping.mappings).toBeDefined();
      expect(testCasesMapping.mappings.properties).toBeDefined();
      expect(testCasesMapping.mappings.properties.id.type).toBe('keyword');
      expect(testCasesMapping.mappings.properties.name.type).toBe('text');
      expect(testCasesMapping.mappings.properties.category.type).toBe('keyword');
    });

    it('should have benchmarks index mapping', () => {
      const mappings = getIndexMappings();
      // Note: index name is 'evals_experiments' for backwards compatibility
      const experimentsKey = Object.keys(mappings).find((k) => k.includes('experiments'));
      expect(experimentsKey).toBeDefined();

      const experimentsMapping = mappings[experimentsKey!];
      expect(experimentsMapping.mappings.properties.id.type).toBe('keyword');
      expect(experimentsMapping.mappings.properties.testCaseIds.type).toBe('keyword');
      expect(experimentsMapping.mappings.properties.runs.type).toBe('nested');
    });

    it('should have runs index mapping', () => {
      const mappings = getIndexMappings();
      const runsKey = Object.keys(mappings).find((k) => k.includes('runs'));
      expect(runsKey).toBeDefined();

      const runsMapping = mappings[runsKey!];
      expect(runsMapping.mappings.properties.experimentId.type).toBe('keyword');
      expect(runsMapping.mappings.properties.testCaseId.type).toBe('keyword');
      expect(runsMapping.mappings.properties.metrics).toBeDefined();
    });

    it('should have analytics index mapping', () => {
      const mappings = getIndexMappings();
      const analyticsKey = Object.keys(mappings).find((k) => k.includes('analytics'));
      expect(analyticsKey).toBeDefined();

      const analyticsMapping = mappings[analyticsKey!];
      expect(analyticsMapping.settings).toBeDefined();
      expect(analyticsMapping.settings?.number_of_shards).toBe(1);
      expect(analyticsMapping.mappings.dynamic_templates).toBeDefined();
    });
  });

  describe('INDEX_MAPPINGS constant', () => {
    it('should be defined', () => {
      expect(INDEX_MAPPINGS).toBeDefined();
    });

    it('should have 4 index mappings', () => {
      expect(Object.keys(INDEX_MAPPINGS).length).toBe(4);
    });

    it('should match getIndexMappings output', () => {
      const mappings = getIndexMappings();
      expect(JSON.stringify(INDEX_MAPPINGS)).toEqual(JSON.stringify(mappings));
    });
  });

  describe('Test Cases Index Schema', () => {
    it('should have version field as integer', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('test_cases'))!;
      expect(mappings[key].mappings.properties.version.type).toBe('integer');
    });

    it('should have disabled object fields for complex data', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('test_cases'))!;
      const props = mappings[key].mappings.properties;

      expect(props.tools.enabled).toBe(false);
      expect(props.messages.enabled).toBe(false);
      expect(props.context.enabled).toBe(false);
    });

    it('should have date fields for timestamps', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('test_cases'))!;
      const props = mappings[key].mappings.properties;

      expect(props.createdAt.type).toBe('date');
      expect(props.updatedAt.type).toBe('date');
    });
  });

  describe('Benchmarks Index Schema', () => {
    it('should have nested runs mapping', () => {
      const mappings = getIndexMappings();
      // Note: index name is 'evals_experiments' for backwards compatibility
      const key = Object.keys(mappings).find((k) => k.includes('experiments'))!;
      const runsMapping = mappings[key].mappings.properties.runs;

      expect(runsMapping.type).toBe('nested');
      expect(runsMapping.properties.id.type).toBe('keyword');
      expect(runsMapping.properties.agentId.type).toBe('keyword');
      expect(runsMapping.properties.modelId.type).toBe('keyword');
    });
  });

  describe('Runs Index Schema', () => {
    it('should have metrics with float types', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('runs'))!;
      const metricsProps = mappings[key].mappings.properties.metrics.properties;

      expect(metricsProps.accuracy.type).toBe('float');
      expect(metricsProps.faithfulness.type).toBe('float');
      expect(metricsProps.latency_score.type).toBe('float');
    });

    it('should have nested annotations', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('runs'))!;
      const annotationsMapping = mappings[key].mappings.properties.annotations;

      expect(annotationsMapping.type).toBe('nested');
      expect(annotationsMapping.properties.text.type).toBe('text');
    });
  });

  describe('Analytics Index Schema', () => {
    it('should have shard configuration', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('analytics'))!;

      expect(mappings[key].settings?.number_of_shards).toBe(1);
      expect(mappings[key].settings?.number_of_replicas).toBe(1);
    });

    it('should have dynamic template for metrics', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('analytics'))!;
      const templates = mappings[key].mappings.dynamic_templates;

      expect(templates).toBeDefined();
      expect(templates?.length).toBeGreaterThan(0);
      expect(templates?.[0].metrics_template).toBeDefined();
    });

    it('should have denormalized fields for analytics', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('analytics'))!;
      const props = mappings[key].mappings.properties;

      expect(props.experimentName).toBeDefined();
      expect(props.testCaseName).toBeDefined();
      expect(props.testCaseCategory.type).toBe('keyword');
      expect(props.testCaseDifficulty.type).toBe('keyword');
    });
  });
});
