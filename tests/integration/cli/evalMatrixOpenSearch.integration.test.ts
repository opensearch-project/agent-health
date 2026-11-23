/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-storage eval matrix × OpenSearch: TypeScript evals through the real
 * packaged CLI against a server on FILE storage whose traces come from a REAL
 * OpenSearch node — a throw-away Data Prepper `otel-v1-apm-span-*` index the
 * agent's spans are bulk-indexed into (tests/helpers/openSearchSpanIndex.ts).
 * See tests/integration/cli/evalMatrix/evalMatrixSuite.ts for the matrix.
 *
 * Node: `TEST_OPENSEARCH_ENDPOINT` locally (opt-in — the suite writes
 * synthetic spans), or the CI service container on localhost:9200 when the job
 * declares `AH_TEST_REQUIRE_OPENSEARCH=1`; with neither the suite skips and
 * says why. A declared node that is down is a FAILURE, never a skip.
 */

import { describeEvalMatrix } from './evalMatrix/evalMatrixSuite';
import { rawOpenSearchOptInHint, resolveMatrixOpenSearchEndpoint } from '../../helpers/openSearchSpanIndex';

const endpoint = resolveMatrixOpenSearchEndpoint();

if (!endpoint) {
  // eslint-disable-next-line no-console
  console.warn(rawOpenSearchOptInHint('CLI eval matrix × OpenSearch'));
  describe.skip('CLI eval matrix — file storage × OpenSearch observability (.eval.ts)', () => { it('skipped: no disposable OpenSearch endpoint (TEST_OPENSEARCH_ENDPOINT / AH_TEST_REQUIRE_OPENSEARCH)', () => {}); });
} else {
  describeEvalMatrix('CLI eval matrix — file storage × OpenSearch observability (.eval.ts)', { source: 'opensearch', openSearchEndpoint: endpoint });
}
