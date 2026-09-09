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

    it('should have 5 index mappings', () => {
      expect(Object.keys(INDEX_MAPPINGS).length).toBe(5);
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

    it('indexes the fixture envelope while keeping its payload opaque', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('test_cases'))!;
      const fixture = mappings[key].mappings.properties.fixture;

      expect(fixture.type).toBe('object');
      expect(fixture.properties.type).toEqual({ type: 'keyword' });
      expect(fixture.properties.ref).toEqual({ type: 'keyword' });
      expect(fixture.properties.integrity).toEqual({ type: 'keyword' });
      expect(fixture.properties.payload).toEqual({ type: 'object', enabled: false });
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

    it('should have disabled object mappings for results, testCaseSnapshots, and stats', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('experiments'))!;
      const runsProps = mappings[key].mappings.properties.runs.properties;

      expect(runsProps.results).toEqual({ type: 'object', enabled: false });
      expect(runsProps.testCaseSnapshots).toEqual({ type: 'object', enabled: false });
      expect(runsProps.stats).toEqual({ type: 'object', enabled: false });
      expect(runsProps.performanceMetrics).toEqual({ type: 'object', enabled: false });
    });

    it('should have explicit scalar field types in runs mapping', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('experiments'))!;
      const runsProps = mappings[key].mappings.properties.runs.properties;

      expect(runsProps.status.type).toBe('keyword');
      expect(runsProps.error.type).toBe('text');
      expect(runsProps.agentEndpoint.type).toBe('keyword');
      expect(runsProps.concurrency.type).toBe('long');
      expect(runsProps.benchmarkVersion.type).toBe('integer');
    });

    it('should have increased field limit setting', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('experiments'))!;

      expect(mappings[key].settings?.['index.mapping.total_fields.limit']).toBe(5000);
    });

    // Regression test for the 2026-08-26 incident: a 400-test-case
    // EvaluationRun crashed mid-run at 243/400 with "Limit of total fields
    // [5000] has been exceeded". EvaluationRun docs are top-level docs in
    // this index (see OpenSearchEvaluationRunOperations) with their own
    // `results` map keyed by testCaseId, distinct from the legacy nested
    // `runs.results` (already protected above). Without this top-level
    // mapping, OpenSearch dynamically mapped `results.<testCaseId>.*` as new
    // fields for every unique test case across every run ever created.
    it('should have a disabled object mapping for the top-level EvaluationRun results field', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('experiments'))!;
      const props = mappings[key].mappings.properties;

      expect(props.results).toEqual({ type: 'object', enabled: false });
    });

    it('should not disable docType/testCaseSnapshots at the top level (still queried via term queries)', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('experiments'))!;
      const props = mappings[key].mappings.properties;

      // These are deliberately left to dynamic mapping: OpenSearchEvaluationRunOperations.list()
      // filters on docType.keyword/benchmarkId.keyword/etc. and testCaseSnapshots.id.keyword (a
      // plain term query — testCaseSnapshots is a dynamically-inferred `object` array, NOT
      // `nested`, so they must stay real, queryable fields, not become part of an opaque
      // enabled:false blob.
      expect(props.docType).toBeUndefined();
      expect(props.testCaseSnapshots).toBeUndefined();
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

    // Regression coverage for the "code-QA benchmarks" field-count-limit
    // incident: custom/system evaluators emit dynamic metric names driven by
    // `evaluator.scoringConfig.metrics` (see asyncRunStorage.ts's
    // storedMetricsToApp()/toStorageFormat comments and
    // judgeResponseParser.ts's extractMetrics()). Without `dynamic: false`,
    // every distinct custom metric name across every run ever created in
    // `evals_runs` minted a new mapped field shared index-wide, eventually
    // exceeding `index.mapping.total_fields.limit`. Mirrors the #418 pattern
    // (EvaluationRun.results / testCaseSnapshots in evals_experiments) but
    // keeps the legacy four metric names typed + queryable (`dynamic: false`
    // with real `properties`), not fully opaqued (`enabled: false`) — no
    // OpenSearch query filters/sorts on `metrics.*` today (see PR
    // query-audit), so this is a defensive choice, not a requirement.
    it('should block dynamic growth of report-level metrics while keeping legacy metric names typed', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('runs'))!;
      const metricsMapping = mappings[key].mappings.properties.metrics;

      expect(metricsMapping.dynamic).toBe(false);
      expect(metricsMapping.properties.accuracy).toEqual({ type: 'float' });
      expect(metricsMapping.properties.faithfulness).toEqual({ type: 'float' });
      expect(metricsMapping.properties.latency_score).toEqual({ type: 'float' });
      expect(metricsMapping.properties.trajectory_alignment_score).toEqual({ type: 'float' });
    });

    // Same growth vector, per-matcher: `matcherResults[].judgeMetrics` is the
    // SDK judge()-call equivalent of the report-level `metrics` object above,
    // and `matcherResults` is itself `nested` — a code-QA benchmark test case
    // with many `judge()` claims x many custom evaluator dimensions
    // multiplies field growth fast (nested docs still count toward the
    // index-wide field-count budget).
    it('should block dynamic growth of matcherResults[].judgeMetrics while keeping legacy metric names typed', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('runs'))!;
      const matcherResultsMapping = mappings[key].mappings.properties.matcherResults;
      const judgeMetricsMapping = matcherResultsMapping.properties.judgeMetrics;

      expect(matcherResultsMapping.type).toBe('nested');
      expect(judgeMetricsMapping.dynamic).toBe(false);
      expect(judgeMetricsMapping.properties.accuracy).toEqual({ type: 'float' });
      expect(judgeMetricsMapping.properties.faithfulness).toEqual({ type: 'float' });
      expect(judgeMetricsMapping.properties.latency_score).toEqual({ type: 'float' });
      expect(judgeMetricsMapping.properties.trajectory_alignment_score).toEqual({ type: 'float' });
    });

    // The other free-form subtrees in this index (matcherResults.actual/
    // expected, trajectory, logs, rawEvents, improvementStrategies, spans)
    // were already opaqued via `enabled: false` prior to this change — assert
    // they stay that way so a future edit doesn't silently reopen one of
    // these growth vectors.
    it('should keep the pre-existing opaque object fields disabled', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('runs'))!;
      const props = mappings[key].mappings.properties;
      const matcherProps = props.matcherResults.properties;

      expect(props.trajectory).toEqual({ type: 'object', enabled: false });
      expect(props.logs).toEqual({ type: 'object', enabled: false });
      expect(props.rawEvents).toEqual({ type: 'object', enabled: false });
      expect(props.improvementStrategies).toEqual({ type: 'object', enabled: false });
      expect(props.spans).toEqual({ type: 'object', enabled: false });
      expect(matcherProps.actual).toEqual({ type: 'object', enabled: false });
      expect(matcherProps.expected).toEqual({ type: 'object', enabled: false });
    });

    // Query-audit regression: every field OpenSearchRunOperations.search()
    // filters/sorts on (server/adapters/opensearch/StorageModule.ts) must stay
    // real, explicitly-typed fields — none of them live under a `dynamic:
    // false` or `enabled: false` subtree.
    it('should keep every field used by OpenSearchRunOperations.search() explicitly mapped and queryable', () => {
      const mappings = getIndexMappings();
      const key = Object.keys(mappings).find((k) => k.includes('runs'))!;
      const props = mappings[key].mappings.properties;

      expect(props.experimentId).toEqual({ type: 'keyword' });
      expect(props.experimentRunId).toEqual({ type: 'keyword' });
      expect(props.testCaseId).toEqual({ type: 'keyword' });
      expect(props.agentId).toEqual({ type: 'keyword' });
      expect(props.modelId).toEqual({ type: 'keyword' });
      expect(props.status).toEqual({ type: 'keyword' });
      expect(props.passFailStatus).toEqual({ type: 'keyword' });
      expect(props.createdAt).toEqual({ type: 'date' });
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
