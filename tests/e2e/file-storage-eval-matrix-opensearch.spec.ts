/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-storage eval matrix × OpenSearch, in the browser: the run the real CLI
 * started on a FILE-storage server reading traces from a REAL OpenSearch node
 * (a throw-away Data Prepper span index) is viewed and re-run in the UI.
 * See tests/e2e/helpers/fileStorageEvalMatrixUi.ts.
 *
 * Node: `TEST_OPENSEARCH_ENDPOINT` locally (opt-in), or the CI service container
 * on localhost:9200 when the job declares `AH_TEST_REQUIRE_OPENSEARCH=1` (the
 * e2e job provisions one); with neither the spec skips and says why. A declared
 * node that is down fails.
 */

import { test } from './fixtures/test-fixtures';
import { describeFileStorageEvalMatrixUi } from './helpers/fileStorageEvalMatrixUi';
import { rawOpenSearchOptInHint, resolveMatrixOpenSearchEndpoint } from '../helpers/openSearchSpanIndex';

const endpoint = resolveMatrixOpenSearchEndpoint();

if (!endpoint) {
  // eslint-disable-next-line no-console
  console.warn(rawOpenSearchOptInHint('file storage × OpenSearch (e2e)'));
  test.skip(true, 'no disposable OpenSearch endpoint (TEST_OPENSEARCH_ENDPOINT / AH_TEST_REQUIRE_OPENSEARCH)');
} else {
  describeFileStorageEvalMatrixUi('file storage × OpenSearch: CLI run in the inspector, Traces tab, Re-run', { source: 'opensearch', openSearchEndpoint: endpoint });
}
