/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for uuid package (v14 is ESM-only, incompatible with Jest CJS transform).
 * Provides deterministic UUIDs for testing.
 */

let counter = 0;

export function v4(): string {
  counter++;
  return `00000000-0000-4000-8000-${counter.toString().padStart(12, '0')}`;
}

export function v1(): string {
  counter++;
  return `00000000-0000-1000-8000-${counter.toString().padStart(12, '0')}`;
}

export const NIL = '00000000-0000-0000-0000-000000000000';
export const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export function validate(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

export function version(uuid: string): number {
  return parseInt(uuid.charAt(14), 16);
}
