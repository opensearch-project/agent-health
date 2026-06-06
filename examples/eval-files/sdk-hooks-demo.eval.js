/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK lifecycle hooks demo — shows beforeEach/afterEach, beforeAll/afterAll,
 * and the `provide()` mechanism for surfacing per-test provisioned values
 * to the body and the teardown hook.
 *
 * The example uses a temp directory as the "out-of-band resource" — the
 * exact thing connectors can't do today (no lifecycle, no teardown). Each
 * test gets its own directory; concurrent runs are isolated automatically.
 *
 * Run with:
 *   AH_PORT=4002 npx @opensearch-project/agent-health benchmark \
 *     -f evals/sdk-hooks-demo.eval.js -a demo
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  test,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
} = require('@opensearch-project/agent-health');

// ─────────────────────────────────────────────────────────────────────────────
// Suite-scoped: runs once before any test, once after them all.
// ─────────────────────────────────────────────────────────────────────────────

let suiteRoot;

beforeAll(() => {
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-hooks-demo-'));
});

afterAll(() => {
  if (suiteRoot && fs.existsSync(suiteRoot)) {
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-test: each test gets its own subdirectory, surfaced via `provide()`.
// `afterEach` reads the same key from `provisioned` to clean up, even when
// the body throws.
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(({ provide, testInfo }) => {
  const safe = testInfo.name.replace(/[^a-z0-9-]+/gi, '_');
  const dir = fs.mkdtempSync(path.join(suiteRoot, `${safe}-`));
  provide('workspaceDir', dir);
});

afterEach(({ provisioned }) => {
  const dir = provisioned.workspaceDir;
  if (typeof dir === 'string' && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — read the provisioned value via `fixtures.provisioned`. No prompt
// is set so the runner skips the agent and runs the body directly; the
// hooks still run because they don't depend on the agent step.
// ─────────────────────────────────────────────────────────────────────────────

test('hook-demo-uses-workspace', {
  description: 'beforeEach provisioned a fresh temp dir for this test',
  labels: ['category:Smoke', 'feature:hooks'],
}, ({ provisioned, testInfo }) => {
  expect(provisioned.workspaceDir).to.be.a('string');
  expect(fs.existsSync(provisioned.workspaceDir)).to.equal(true);

  // The dir's basename must include the test name, proving testInfo flowed
  // through `provide()` correctly.
  expect(path.basename(provisioned.workspaceDir)).to.include(
    testInfo.name.replace(/[^a-z0-9-]+/gi, '_')
  );

  // Write a file inside, just to show it's a real, writable workspace.
  fs.writeFileSync(path.join(provisioned.workspaceDir, 'marker'), 'hello');
});

test('hook-demo-isolation', {
  description: 'A second test gets its own isolated workspace',
  labels: ['category:Smoke', 'feature:hooks'],
}, ({ provisioned }) => {
  expect(provisioned.workspaceDir).to.be.a('string');
  // Concurrent tests would each see their own dir; this one in particular
  // must NOT see the marker file from the other test.
  expect(fs.existsSync(path.join(provisioned.workspaceDir, 'marker'))).to.equal(false);
});
