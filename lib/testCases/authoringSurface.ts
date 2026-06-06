/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single source of truth for the SDK's **test-authoring surface** — the
 * exact set of names a `.eval.{js,ts,mjs}` file gets when it imports
 * `@opensearch-project/agent-health` (RFC 004 §4.7, #232).
 *
 * Why this exists: the loader binds two ways. `.ts`/`.mjs` files are
 * `import()`-ed and resolve the real package exports; `.js` (CJS) files are
 * executed in a synthetic context where `require('@opensearch-project/...')`
 * is intercepted and handed a hand-built object. Historically that object was
 * a hardcoded subset that silently drifted from the real package exports — so
 * a new export (e.g. `defineEvaluator`) worked in `.ts` files but was
 * `undefined` in `.js` files. Centralizing the surface here, and having BOTH
 * the loader's CJS injection and the package index reference it, kills the
 * drift: add a name once and every loader path sees it.
 */

import {
  test,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from './define.js';
import { judge } from './judge.js';
import { defineEvaluator, evaluate } from './evaluators.js';
import { expect } from '../matchers/expect.js';

/**
 * Build the authoring-surface object handed to code-imported eval files.
 * Must mirror the public `@opensearch-project/agent-health` package exports
 * that a test body uses (the runtime registrars + matchers), so `.js` and
 * `.ts`/`.mjs` files behave identically.
 */
export function getAuthoringSurface(): Record<string, unknown> {
  return {
    // Registrars (file-scoped singletons — registrations land in the
    // loader's per-file registry).
    test,
    describe,
    beforeAll,
    afterAll,
    beforeEach,
    afterEach,
    // Judge + custom evaluators.
    judge,
    defineEvaluator,
    evaluate,
    // Matcher API.
    expect,
  };
}

/** The stable list of authoring-surface export names (for drift tests). */
export const AUTHORING_SURFACE_NAMES = Object.keys(getAuthoringSurface()).sort();
