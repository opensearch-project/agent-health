/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest setup file — polyfills for jsdom test environment.
 *
 * jsdom does not provide TextEncoder/TextDecoder, but libraries like
 * react-router-dom v7 require them. Node.js has them globally, so we
 * only need to polyfill when they're missing (i.e., in jsdom).
 */

// Force NODE_ENV=test even when a parent process (CI wrapper, agent harness,
// supervisord, etc.) pre-set it to something else. Jest only defaults
// NODE_ENV to 'test' when unset; if a parent already exported NODE_ENV=
// production, Jest respects that, and `react/index.js` then loads
// `cjs/react.production.js`, which does NOT export `act` (act is a
// development-only API in React 19). `@testing-library/react`'s
// act-compat.js then falls through to `react-dom/test-utils.act`, which
// itself reads the now-undefined `React.act` and throws
// `TypeError: React.act is not a function`. Pinning NODE_ENV='test' here
// guarantees the React dev build is selected for every worker.
process.env.NODE_ENV = 'test';

const { TextEncoder, TextDecoder } = require('util');

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}
