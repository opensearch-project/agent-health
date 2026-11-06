/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test-side `--require` preload: makes the CURRENT Node binary report a
 * different `process.versions.node`, so the real bin/cli.js guard can be
 * exercised against out-of-range versions on machines (CI) that only have the
 * matrix Node installed. Production code is untouched — the shim reads
 * `process.versions.node` exactly as it always does.
 *
 * Usage: node --require ./fakeNodeVersion.cjs bin/cli.js …
 * with AH_TEST_FAKE_NODE_VERSION=20.19.0 in the environment.
 */

'use strict';

const fake = process.env.AH_TEST_FAKE_NODE_VERSION;
if (fake) {
  // `process.versions.node` is non-writable but configurable.
  Object.defineProperty(process.versions, 'node', { value: fake, enumerable: true, configurable: true });
}
