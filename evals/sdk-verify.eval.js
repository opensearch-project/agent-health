/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK final demo — unique describe names to avoid colliding with prior
 * runs in the dev environment. Same shape as sdk-describe-demo.eval.js.
 */

const { describe, test, expect } = require('@opensearch-project/agent-health');

describe('SDK Verify RCA 0521a', () => {
  test('rca payment service', {
    prompt: 'Diagnose why the payment service is failing.',
    context: [{ description: 'Error log', value: 'ERROR [payment-service] Connection refused to db-primary:5432' }],
    labels: ['category:RCA', 'difficulty:Medium'],
  }, async function ({ agent, judge }) {
    const result = await agent.run();
    expect(result.trajectory).to.have.length.greaterThan(0);
    expect(result).to.haveCompletedWithin(60_000);
    await judge(result, 'Mentions the payment service or its database connection failure');
  });
});

describe('SDK Verify Smoke 0521a', () => {
  test('smoke says hello', {
    prompt: 'Say hello in one short sentence.',
    labels: ['category:Smoke', 'difficulty:Easy'],
  }, async function ({ agent }) {
    const result = await agent.run();
    expect(result.trajectory).to.have.length.greaterThan(0);
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);
    expect(result).to.haveCompletedWithin(30_000);
  });
});

test('orphan-deterministic 0521a', function () {
  expect(2 + 2).to.equal(4);
});
