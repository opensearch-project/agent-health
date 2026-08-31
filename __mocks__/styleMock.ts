/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CSS mock for Jest — components that `import '*.css'` directly (e.g.
 * `@xyflow/react/dist/style.css` in TraceFlowComparison.tsx) can't be
 * unit-tested otherwise: Jest has no CSS transform and a raw stylesheet
 * import throws a syntax error long before any test code runs. Maps every
 * CSS import to this no-op module (see jest.config.cjs moduleNameMapper).
 */
export {};
