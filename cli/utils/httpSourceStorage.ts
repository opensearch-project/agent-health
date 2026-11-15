/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `SourceStorage` surface (services/sourceResolver.ts) over the server's
 * storage REST API — what lets `resolveTestCaseSources` run INSIDE the CLI
 * process (#612): `code-import` / `file-import` / `directory-import` read the
 * caller's files from the caller's cwd, while the stored test cases and
 * benchmarks they reference or create live behind the project server.
 *
 * Reads: `GET /api/storage/benchmarks/:id`, `GET /api/storage/test-cases(/:id)`.
 * Writes: `POST /api/storage/test-cases` (JSON definitions) and
 * `POST /api/storage/test-cases/bulk` (code-SDK upsert) — the same routes the
 * CLI's legacy import path has always used.
 */

import type { Benchmark, TestCase } from '@/types/index.js';
import type { SourceStorage } from '@/services/sourceResolver.js';
import type { TestCaseListOptions, TestCaseSearchFilters, PaginationOptions } from '@/server/adapters/types.js';

export class StorageApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'StorageApiError';
  }
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!res.ok && res.status !== 404) {
    throw new StorageApiError(res.status, body?.error ?? `${init?.method ?? 'GET'} ${url} failed with HTTP ${res.status}`);
  }
  return { status: res.status, body: body as T };
}

/** Apply the adapters' `search` semantics client-side (both match ANY of the given labels). */
export function filterTestCases(items: TestCase[], filters: TestCaseSearchFilters): TestCase[] {
  let filtered = items;
  if (filters.labels?.length) filtered = filtered.filter((tc) => filters.labels!.some((label) => tc.labels?.includes(label)));
  if (filters.category) filtered = filtered.filter((tc) => tc.category === filters.category);
  if (filters.difficulty) filtered = filtered.filter((tc) => tc.difficulty === filters.difficulty);
  if (filters.isPromoted !== undefined) filtered = filtered.filter((tc) => tc.isPromoted === filters.isPromoted);
  if (filters.textSearch) {
    const q = filters.textSearch.toLowerCase();
    filtered = filtered.filter((tc) =>
      tc.name?.toLowerCase().includes(q) || tc.description?.toLowerCase().includes(q) || tc.initialPrompt?.toLowerCase().includes(q));
  }
  return filtered;
}

function paginate<T>(items: T[], options?: PaginationOptions): { items: T[]; total: number } {
  const from = options?.from ?? 0;
  const size = options?.size ?? items.length;
  return { items: items.slice(from, from + size), total: items.length };
}

export function createHttpSourceStorage(serverUrl: string, fetchImpl: typeof fetch = fetch): SourceStorage {
  const base = serverUrl.replace(/\/$/, '');
  const json = { 'Content-Type': 'application/json' };

  const listAll = async (): Promise<TestCase[]> => {
    // `includeSample=false`: the bundled demo cases are never import matches.
    const { body } = await requestJson<{ testCases?: TestCase[] }>(fetchImpl, `${base}/api/storage/test-cases?includeSample=false`);
    return body?.testCases ?? [];
  };

  return {
    benchmarks: {
      async getById(id: string): Promise<Benchmark | null> {
        const { status, body } = await requestJson<Benchmark>(fetchImpl, `${base}/api/storage/benchmarks/${encodeURIComponent(id)}`);
        return status === 404 ? null : body;
      },
    },
    testCases: {
      async getById(id: string): Promise<TestCase | null> {
        const { status, body } = await requestJson<TestCase>(fetchImpl, `${base}/api/storage/test-cases/${encodeURIComponent(id)}`);
        return status === 404 ? null : body;
      },
      async getAll(options?: TestCaseListOptions): Promise<{ items: TestCase[]; total: number }> {
        return paginate(await listAll(), options);
      },
      async search(filters: TestCaseSearchFilters, options?: PaginationOptions): Promise<{ items: TestCase[]; total: number }> {
        return paginate(filterTestCases(await listAll(), filters), options);
      },
      async create(testCase: Partial<TestCase>): Promise<TestCase> {
        const { body } = await requestJson<TestCase>(fetchImpl, `${base}/api/storage/test-cases`, { method: 'POST', headers: json, body: JSON.stringify(testCase) });
        return body;
      },
      async bulkUpsert(testCases: Partial<TestCase>[]): Promise<{ created: number; updated: number; unchanged: number; testCases: TestCase[] }> {
        const { body } = await requestJson<{ created: number; updated?: number; unchanged?: number; testCases: TestCase[] }>(
          fetchImpl, `${base}/api/storage/test-cases/bulk`, { method: 'POST', headers: json, body: JSON.stringify({ testCases }) },
        );
        return { created: body.created, updated: body.updated ?? 0, unchanged: body.unchanged ?? 0, testCases: body.testCases };
      },
    },
  };
}
