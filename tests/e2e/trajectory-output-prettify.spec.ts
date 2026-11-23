/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Run inspector → Test Case Output → Processed: tool results that arrive as an
 * MCP-style content envelope (`[{type:'text', text:'<JSON string>'}]`) used to
 * render as one truncated line of escaped quotes, and `action` args as a single
 * truncated line. They now render through PrettyContent: a shape summary in
 * the collapsed preview, a Tree / Table / Raw toggle, a table for homogeneous
 * arrays (search hits), and the original string under Raw.
 *
 * The fixture is synthetic: a generic retrieval agent calling `search_index`
 * and getting 20 hits back.
 */
test.describe('trajectory output prettifies envelope tool results', () => {
  const reportId = `e2e-prettify-${Date.now()}`;

  const hits = Array.from({ length: 20 }, (_, i) => ({
    id: `doc-${i}`,
    title: `Camping mug ${i}`,
    brand: i % 2 === 0 ? 'NorthPeak' : 'TrailForge',
    price: 12.5 + i,
    inStock: i % 3 !== 0,
    score: (20 - i) / 2,
    description: `Stainless steel double-wall mug number ${i} for cold mornings at camp.`,
  }));
  const innerResult = {
    status: 'ok',
    index: 'products',
    total: 91,
    total_relation: 'eq',
    hit_count: 20,
    hits,
    rewrites: ['expanded color synonyms'],
  };
  const envelope = JSON.stringify([{ type: 'text', text: JSON.stringify(innerResult) }]);
  const toolArgs = {
    index: 'products',
    dsl: {
      size: 20,
      query: {
        bool: {
          must: [{ match: { title: { query: 'stainless steel camping mug', operator: 'and' } } }],
          should: [{ match: { description: 'double wall insulated' } }, { term: { color: 'grey' } }, { term: { color: 'gray' } }],
        },
      },
      _source: ['id', 'title', 'brand', 'price', 'description'],
    },
  };
  const argsContent = JSON.stringify(toolArgs);
  const rankedResponse = JSON.stringify({
    results: hits.slice(0, 5).map((h, i) => ({ rank: i + 1, id: h.id, title: h.title, score: h.score })),
  });

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/storage/runs', {
      data: {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentKey: 'retrieval-agent',
        modelId: 'claude-sonnet',
        testCaseId: 'e2e-prettify-tc',
        status: 'completed',
        metricsStatus: 'completed',
        passFailStatus: 'passed',
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'Found the right mugs.',
        trajectory: [
          { id: 's-user', timestamp: 1, type: 'user', content: 'Recommend a sturdy stainless steel camping mug.' },
          { id: 's-action', timestamp: 2, type: 'action', toolName: 'search_index', toolArgs, content: argsContent, latencyMs: 310 },
          { id: 's-result', timestamp: 3, type: 'tool_result', toolName: 'search_index', content: envelope, toolOutput: envelope },
          { id: 's-response', timestamp: 4, type: 'response', content: rankedResponse },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/runs/${encodeURIComponent(reportId)}`).catch(() => {});
  });

  test('tool result: summary preview, table of hits, tree, and Raw shows the original string', async ({ page }) => {
    await page.goto(`/runs/${reportId}`);

    const resultStep = page.locator('[data-testid="trajectory-step-tool_result"]');
    await expect(resultStep).toBeVisible({ timeout: 15000 });

    // Collapsed preview: a shape summary with the first keys — no escaped blob.
    const toggle = resultStep.getByRole('button', { name: /object · 7 keys/ });
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('status, index, total, total_relation, hit_count, hits');
    await expect(toggle).toContainText(`(${envelope.length} chars)`);
    await expect(toggle).not.toContainText('\\"');

    await toggle.click();

    // Summary header + unwrap note.
    await expect(page.getByTestId('pretty-s-result-summary')).toHaveText('object · 7 keys');
    await expect(page.getByTestId('pretty-s-result-unwrapped')).toContainText('content envelope');

    // Table is the default for a payload holding a homogeneous array.
    const table = page.getByTestId('pretty-s-result-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(20);
    await expect(table.locator('thead')).toContainText('inStock');
    await expect(table).toContainText('Camping mug 7');
    await expect(page.getByTestId('pretty-s-result-mode-table')).toHaveAttribute('aria-pressed', 'true');

    // Tree: the root object is readable, nested hits expand per node.
    await page.getByTestId('pretty-s-result-mode-tree').click();
    const tree = page.getByTestId('pretty-s-result-tree');
    await expect(tree).toBeVisible();
    await expect(tree).toContainText('hit_count');
    await expect(tree).toContainText('91');
    await tree.getByRole('button', { name: 'Expand 0' }).click();
    await expect(tree).toContainText('"doc-0"');

    // Keyboard: Enter on a node toggle collapses it again.
    await tree.getByRole('button', { name: 'Collapse 0' }).focus();
    await page.keyboard.press('Enter');
    await expect(tree).not.toContainText('"doc-0"');

    // Raw shows the original persisted string, untouched.
    await page.getByTestId('pretty-s-result-mode-raw').click();
    await expect(page.getByTestId('pretty-s-result-raw')).toHaveText(envelope);
  });

  test('action args render as a tree with the tool header; JSON response renders as a ranked table', async ({ page }) => {
    await page.goto(`/runs/${reportId}`);

    const actionStep = page.locator('[data-testid="trajectory-step-action"]');
    await expect(actionStep).toBeVisible({ timeout: 15000 });
    await expect(actionStep).toContainText('action · search_index');
    await expect(actionStep).toContainText('310ms');

    // Args are > 200 chars → collapsed with a summary preview, then a tree.
    const argsToggle = actionStep.getByRole('button', { name: /object · 2 keys · index, dsl/ });
    await expect(argsToggle).toBeVisible();
    await argsToggle.click();
    const argsTree = page.getByTestId('pretty-s-action-tree');
    await expect(argsTree).toBeVisible();
    await expect(argsTree).toContainText('"products"');
    await expect(argsTree.getByRole('button', { name: 'Collapse dsl' })).toBeVisible();
    await page.getByTestId('pretty-s-action-mode-raw').click();
    await expect(page.getByTestId('pretty-s-action-raw')).toHaveText(argsContent);

    // Ranked-list response (collapsed: summary preview) → expands to a table.
    const responseStep = page.locator('[data-testid="trajectory-step-response"]');
    await responseStep.getByRole('button', { name: /object · 1 key · results/ }).click();
    const responseTable = page.getByTestId('pretty-s-response-table');
    await expect(responseTable).toBeVisible();
    await expect(responseTable.locator('tbody tr')).toHaveCount(5);
    await expect(responseTable.locator('thead')).toContainText('rank');

    // The user prompt is untouched prose.
    await expect(page.locator('[data-testid="trajectory-step-user"]')).toContainText('Recommend a sturdy stainless steel camping mug.');
  });
});
