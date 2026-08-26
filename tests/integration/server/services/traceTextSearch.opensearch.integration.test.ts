/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: trace text-search against a REAL OpenSearch cluster using
 * the Data Prepper `otel-v1-apm-span-*` span schema.
 *
 * This is the only level that catches the field-name bug the search fix
 * addresses: in that schema `session.id` is stored as `span.attributes.session@id`
 * (`@` for dots), NOT the `attributes.session.id[.keyword]` the query used to
 * assume — so a bare-UUID substring search returned zero. File-mode tests
 * can't catch it (they match on plain attribute values, no field names), and
 * the unit test only asserts the query body. Here we seed a real span and
 * confirm `fetchTraces({ textSearch })` finds it.
 *
 * Cluster: connects directly to http://localhost:9200 (no security), the same
 * ephemeral OpenSearch the CI integration job runs. Each assertion bails out
 * (passes trivially, with a console warning) when the cluster is unreachable,
 * so local runs without a cluster (and file-mode CI) stay green. To run locally:
 *
 *   docker run -d --rm -p 9200:9200 -e discovery.type=single-node \
 *     -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
 *     opensearchproject/opensearch:2.17.0
 *   npm run test:integration -- traceTextSearch.opensearch
 */

import { Client } from '@opensearch-project/opensearch';
import { fetchTraces } from '@/server/services/tracesService';

const ENDPOINT = process.env.TEST_OPENSEARCH_ENDPOINT || 'http://localhost:9200';
const INDEX = `otel-v1-apm-span-inttest-${Date.now()}`;
const FULL_SESSION_ID = '2026-07-07T10-35-42-608Z_019f3c25-de90-71ea-9b20-709e4efcc621';
const BARE_UUID = '019f3c25-de90-71ea-9b20-709e4efcc621';

// Data Prepper apm-span docs key attributes as `span.attributes.<name>` with
// `@` replacing dots in the attribute name. Reproduce that leaf exactly, as
// keyword (so a substring wildcard is meaningful — a `text` field would tokenize
// the UUID on `-` and defeat the whole point).
const SESSION_FIELD = 'span.attributes.session@id';

async function clusterUp(client: Client): Promise<boolean> {
  try {
    await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
    return true;
  } catch {
    return false;
  }
}

describe('trace text-search against real OpenSearch (Data Prepper span schema)', () => {
  let client: Client;
  let available = false;

  beforeAll(async () => {
    client = new Client({ node: ENDPOINT, ssl: { rejectUnauthorized: false } });
    available = await clusterUp(client);
    if (!available) {
      // No cluster reachable — degrade gracefully rather than failing the
      // whole suite. (Earlier revision of this file tried making this throw
      // when `process.env.CI` was set, reasoning that ci.yml's dedicated
      // `integration-tests` job provisions and health-checks a real
      // OpenSearch service container before any test runs. That's true for
      // THAT job, but GitHub Actions sets `CI=true` for every job, including
      // `release-rehearsal` ("npm test exactly as the Release Workflow runs
      // it"), which runs the full suite on a plain runner with no OpenSearch
      // service at all — so the CI-only throw broke that job outright.
      // There's no env var this file can see that reliably means "a cluster
      // was specifically promised for this job" without ci.yml adding one,
      // so: skip-with-warning unconditionally, as before.)
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping real-cluster trace search tests`);
      return;
    }

    await client.indices.create({
      index: INDEX,
      body: {
        mappings: {
          properties: {
            traceId: { type: 'keyword' },
            serviceName: { type: 'keyword' },
            name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
            startTime: { type: 'date' },
            endTime: { type: 'date' },
            durationInNanos: { type: 'long' },
            kind: { type: 'keyword' },
            // Nested path span.attributes.{session@id} — the leaf is keyword.
            span: { properties: { attributes: { properties: { 'session@id': { type: 'keyword' } } } } },
          },
        },
      },
    });

    const now = Date.now();
    const doc = (name: string) => ({
      traceId: 'trace-inttest-1',
      spanId: `span-${name}-${Math.random().toString(16).slice(2)}`,
      serviceName: 'pi-agent',
      name,
      kind: 'SPAN_KIND_INTERNAL',
      startTime: new Date(now - 5000).toISOString(),
      endTime: new Date(now).toISOString(),
      durationInNanos: 5_000_000_000,
      // Dotted key expands to span.attributes.{session@id} on index.
      [SESSION_FIELD]: FULL_SESSION_ID,
    });

    await client.bulk({
      index: INDEX,
      refresh: true,
      body: [
        { index: {} }, doc('chat us.anthropic.claude-opus-4'),
        { index: {} }, doc('execute_tool bash'),
      ],
    });
  }, 60000);

  afterAll(async () => {
    if (available) {
      await client.indices.delete({ index: INDEX }).catch(() => {});
    }
    await client.close().catch(() => {});
  });

  // `available` is only known once `beforeAll` resolves, but Jest collects
  // `it`/`it.skip` synchronously while this `describe` body runs — BEFORE
  // `beforeAll` has executed. Deciding `it` vs `it.skip` up front (e.g.
  // `(available ? it : it.skip)('...', ...)`) would always see the
  // `available = false` initial value and skip unconditionally, even with a
  // live cluster reachable. So: always register a real `it`, and bail out
  // at runtime once `available` has its real value.
  function itIfAvailable(name: string, fn: () => Promise<void>, timeout: number) {
    it(name, async () => {
      if (!available) {
        // eslint-disable-next-line no-console
        console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping "${name}"`);
        return;
      }
      await fn();
    }, timeout);
  }

  itIfAvailable('finds spans by the BARE UUID substring (the original failing case)', async () => {
    const now = Date.now();
    const res = await fetchTraces(
      { textSearch: BARE_UUID, startTime: now - 3600_000, endTime: now + 60_000, size: 10 },
      client,
      INDEX,
    );
    expect(res.spans.length).toBe(2);
    for (const s of res.spans) {
      expect((s as any).attributes['session.id']).toBe(FULL_SESSION_ID);
    }
  }, 30000);

  itIfAvailable('finds spans by the full timestamped session.id', async () => {
    const now = Date.now();
    const res = await fetchTraces(
      { textSearch: FULL_SESSION_ID, startTime: now - 3600_000, endTime: now + 60_000, size: 10 },
      client,
      INDEX,
    );
    expect(res.spans.length).toBe(2);
  }, 30000);

  itIfAvailable('a dashed query does not error out (query_string would have)', async () => {
    const now = Date.now();
    // No throw = the wildcard path handled reserved chars as literals.
    const res = await fetchTraces(
      { textSearch: 'no-such-2026-07-07T00-00', startTime: now - 3600_000, endTime: now + 60_000, size: 10 },
      client,
      INDEX,
    );
    expect(res.spans.length).toBe(0);
  }, 30000);

  itIfAvailable('still matches on serviceName substring', async () => {
    const now = Date.now();
    const res = await fetchTraces(
      { textSearch: 'pi-age', startTime: now - 3600_000, endTime: now + 60_000, size: 10 },
      client,
      INDEX,
    );
    expect(res.spans.length).toBe(2);
  }, 30000);

  itIfAvailable('exact sessionId param matches span.attributes.session@id (Strategy D / run-report path)', async () => {
    const res = await fetchTraces({ sessionId: FULL_SESSION_ID, size: 10 }, client, INDEX);
    expect(res.spans.length).toBe(2);
    for (const s of res.spans) {
      expect((s as any).attributes['session.id']).toBe(FULL_SESSION_ID);
    }
  }, 30000);
});
