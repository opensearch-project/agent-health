/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK demo with describe() grouping. Each describe() block declares a
 * benchmark; CLI auto-creates one benchmark per group and runs them.
 */

const { describe, test, expect } = require('@opensearch-project/agent-health');

describe('RCA Suite', () => {
  test('payment service is the root cause', {
    prompt: 'Diagnose why the payment service is failing.',
    context: [{ description: 'Error log', value: 'ERROR [payment-service] Connection refused to db-primary:5432' }],
    labels: ['category:RCA', 'difficulty:Medium'],
  }, async function ({ agent, judge }) {
    const result = await agent.run();
    expect(result.trajectory).to.have.length.greaterThan(0);
    expect(result).to.haveCompletedWithin(60_000);
    await judge(result, 'Mentions the payment service or its database connection failure');
  });

  test('budget cap', {
    prompt: 'Summarize the system in one paragraph.',
    labels: ['category:Budget', 'difficulty:Easy'],
  }, async function ({ agent, traces }) {
    const result = await agent.run();
    expect(result.agentOutput.length).to.be.greaterThan(0);
    expect(traces.totalTokens).to.be.lessThan(50_000);
  });
});

describe('Smoke', () => {
  test('says hello', {
    prompt: 'Say hello in one short sentence.',
    labels: ['category:Smoke', 'difficulty:Easy'],
  }, async function ({ agent }) {
    const result = await agent.run();
    expect(result.trajectory).to.have.length.greaterThan(0);
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);
    expect(result).to.haveCompletedWithin(30_000);
  });
});

// Tests outside any describe() — go to the file-default benchmark
test('orphan-deterministic', function () {
  expect(2 + 2).to.equal(4);
});
