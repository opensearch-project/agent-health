/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@opensearch-project/agent-health/metrics` is intercepted by the loader the
 * same way the package root is, so a .eval.ts / .eval.js file computes
 * Hit@k / Recall@k / MRR with the SAME functions the deterministic evaluator
 * engine uses — and gets exactly the registry's exports.
 */

import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';
import * as metrics from '@/lib/metrics/index';

describe('loader — @opensearch-project/agent-health/metrics subpath', () => {
  beforeEach(() => clearRegistry());

  it.each(['.eval.ts', '.eval.js'])('a file importing the metrics subpath (%s) gets the registry and its values match a direct call', async ext => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-loader-metrics-'));
    const path = join(dir, `ranked${ext}`);
    const src = ext === '.eval.ts'
      ? `
        import { test } from '@opensearch-project/agent-health';
        import { rankedHit, rankedRecall, mrr, computeMetric } from '@opensearch-project/agent-health/metrics';
        const gold: string[] = ['g1', 'g2'];
        const ranked: string[] = ['x', 'g2', 'g1'];
        (globalThis as any).__metricsProbe = {
          hit1: rankedHit({ gold, ranked, k: 1 }),
          hit3: rankedHit({ gold, ranked, k: 3 }),
          recall2: rankedRecall({ gold, ranked, k: 2 }),
          mrr: mrr({ gold, ranked }),
          viaRegistry: computeMetric({ type: 'ranked-recall', k: 3 }, { gold, ranked }),
          unevaluable: mrr({ gold: [], ranked }),
        };
        test('ranked', () => {});
      `
      : `
        const { test } = require('@opensearch-project/agent-health');
        const { rankedHit, rankedRecall, mrr, computeMetric } = require('@opensearch-project/agent-health/metrics');
        const gold = ['g1', 'g2'];
        const ranked = ['x', 'g2', 'g1'];
        globalThis.__metricsProbe = {
          hit1: rankedHit({ gold, ranked, k: 1 }),
          hit3: rankedHit({ gold, ranked, k: 3 }),
          recall2: rankedRecall({ gold, ranked, k: 2 }),
          mrr: mrr({ gold, ranked }),
          viaRegistry: computeMetric({ type: 'ranked-recall', k: 3 }, { gold, ranked }),
          unevaluable: mrr({ gold: [], ranked }),
        };
        test('ranked', () => {});
      `;
    writeFileSync(path, src, 'utf8');
    delete (globalThis as any).__metricsProbe;

    const result = await loadTestCasesFromModule(path);
    expect(result.testCases.map(tc => tc.name)).toEqual(['ranked']);

    const probe = (globalThis as any).__metricsProbe;
    expect(probe).toEqual({
      hit1: 0,
      hit3: 1,
      recall2: 0.5,
      mrr: 0.5,
      viaRegistry: 1,
      unevaluable: null,
    });
    // Same implementation as the engine's registry, not a copy.
    expect(probe.mrr).toBe(metrics.mrr({ gold: ['g1', 'g2'], ranked: ['x', 'g2', 'g1'] }));
  });
});
