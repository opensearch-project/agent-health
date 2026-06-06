/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest mock for typebox (ESM-only; Jest's CJS loader can't import it).
 * Returns plain JSON-schema-ish objects — enough for tool registration in
 * tests, which only store the schema and never validate against it.
 */
export const Type = {
  Object: (properties: Record<string, unknown> = {}) => ({ type: 'object', properties }),
  Optional: (schema: unknown) => schema,
  String: (opts: Record<string, unknown> = {}) => ({ type: 'string', ...opts }),
  Number: (opts: Record<string, unknown> = {}) => ({ type: 'number', ...opts }),
  Boolean: (opts: Record<string, unknown> = {}) => ({ type: 'boolean', ...opts }),
};
