/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Synthetic code-SDK eval file used by
 * tests/integration/server/routes/storage/testCasesDefinitionCapture.integration.test.ts
 * and tests/e2e/sdk-test-definition-view.spec.ts.
 *
 * Three tests registered from a data table (the shape that made the
 * whole-file view useless: "the test" is a loop body, not a literal
 * `test(...)` call you can point at). Nothing here refers to any real
 * agent, benchmark, or dataset.
 */

const { test } = require('@opensearch-project/agent-health');

const CASES = [
  {
    name: 'synthetic-case-one',
    prompt: 'Synthetic prompt number one',
    outcomes: ['Outcome one is satisfied'],
    marker: 'ONE',
  },
  {
    name: 'synthetic-case-two',
    prompt: 'Synthetic prompt number two',
    outcomes: ['Outcome two is satisfied', 'Outcome two is fast'],
    marker: 'TWO',
  },
  {
    name: 'synthetic-case-three',
    prompt: 'Synthetic prompt number three',
    outcomes: ['Outcome three is satisfied'],
    marker: 'THREE',
  },
];

for (const c of CASES) {
  test(
    c.name,
    {
      prompt: c.prompt,
      description: `Synthetic description for ${c.marker}`,
      expectedOutcomes: c.outcomes,
      labels: ['category:Synthetic', 'difficulty:Easy', `marker:${c.marker}`],
      timeout: 30000,
    },
    async ({ result }) => {
      // shared-loop-body-marker
      if (!result) throw new Error(`no result for ${c.name}`);
    }
  );
}

test('synthetic-case-standalone', { prompt: 'Standalone synthetic prompt' }, async ({ result }) => {
  // standalone-body-marker
  if (!result || !result.trajectory) throw new Error('standalone: missing trajectory');
});
