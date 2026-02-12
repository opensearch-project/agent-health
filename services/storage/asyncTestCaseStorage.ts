/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Async Test Case Storage
 *
 * Async wrapper around OpenSearch storage for test cases.
 * Provides a similar API to the synchronous localStorage-based storage.
 */

import { testCaseStorage as opensearchTestCases, StorageTestCase } from './opensearchClient';
import type { TestCase, TestCaseVersion, AgentContextItem, AgentToolDefinition, Difficulty } from '@/types';
import { buildLabels, parseLabels } from '@/lib/labels';

// Input type for creating a test case
export interface CreateTestCaseInput {
  /** Optional ID - if provided, will be used instead of generating a new one (useful for migration) */
  id?: string;
  name: string;
  description?: string;
  labels?: string[];  // Unified labels system
  /** @deprecated Use labels instead */
  category?: string;
  /** @deprecated Use labels instead */
  subcategory?: string;
  /** @deprecated Use labels instead */
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  initialPrompt: string;
  context: AgentContextItem[];
  tools?: AgentToolDefinition[];
  expectedPPL?: string;
  expectedOutcomes?: string[];  // NEW: Simple text descriptions of expected behavior
  expectedTrajectory?: {  // Now optional - for backwards compat
    step: number;
    description: string;
    requiredTools: string[];
  }[];
  followUpQuestions?: {
    trigger: 'results_available' | 'error' | 'always';
    question: string;
    businessValue: string;
  }[];
  tags?: string[];
  author?: string;
  isPromoted?: boolean;
}

// Input type for updating a test case
export interface UpdateTestCaseInput {
  name?: string;
  description?: string;
  labels?: string[];  // Unified labels system
  /** @deprecated Use labels instead */
  category?: string;
  /** @deprecated Use labels instead */
  subcategory?: string;
  /** @deprecated Use labels instead */
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  initialPrompt?: string;
  context?: AgentContextItem[];
  tools?: AgentToolDefinition[];
  expectedPPL?: string;
  expectedOutcomes?: string[];  // NEW: Simple text descriptions of expected behavior
  expectedTrajectory?: {
    step: number;
    description: string;
    requiredTools: string[];
  }[];
  followUpQuestions?: {
    trigger: 'results_available' | 'error' | 'always';
    question: string;
    businessValue: string;
  }[];
  tags?: string[];
  isPromoted?: boolean;
}

/**
 * Convert OpenSearch storage format to app TestCase format
 * Handles backward compatibility: if labels exist, use them; otherwise derive from legacy fields
 */
function toTestCase(stored: StorageTestCase): TestCase {
  // Build labels from storage or derive from legacy fields
  let labels = stored.labels || [];
  if (labels.length === 0 && (stored.category || stored.difficulty)) {
    labels = buildLabels({
      category: stored.category,
      subcategory: stored.subcategory,
      difficulty: stored.difficulty,
    });
  }

  // Parse labels for backward compat fields
  const parsed = parseLabels(labels);

  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    labels,
    // Backward compat - derived from labels or fallback to stored values
    category: parsed.category || stored.category || 'General',
    subcategory: parsed.subcategory || stored.subcategory,
    difficulty: (parsed.difficulty as Difficulty) || stored.difficulty || 'Medium',
    currentVersion: stored.version,
    versions: [], // Versions fetched separately if needed
    isPromoted: stored.tags?.includes('promoted') ?? false,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    initialPrompt: stored.initialPrompt,
    context: (stored.context || []) as AgentContextItem[],
    tools: stored.tools as AgentToolDefinition[] | undefined,
    expectedPPL: stored.expectedPPL,
    expectedOutcomes: stored.expectedOutcomes,
    expectedTrajectory: (stored.expectedTrajectory || []) as TestCase['expectedTrajectory'],
  };
}

/**
 * Convert app TestCase format to OpenSearch storage format
 * Writes labels as primary, legacy fields for backward compatibility
 */
function toStorageFormat(testCase: CreateTestCaseInput | UpdateTestCaseInput): Partial<StorageTestCase> {
  const tags = testCase.tags || [];
  if ((testCase as CreateTestCaseInput).isPromoted && !tags.includes('promoted')) {
    tags.push('promoted');
  }

  // Use provided labels or build from legacy fields
  let labels = testCase.labels;
  if (!labels && (testCase.category || testCase.difficulty)) {
    labels = buildLabels({
      category: testCase.category,
      subcategory: testCase.subcategory,
      difficulty: testCase.difficulty,
    });
  }

  return {
    name: testCase.name!,
    description: testCase.description,
    initialPrompt: testCase.initialPrompt!,
    tools: testCase.tools,
    messages: [],
    context: testCase.context,
    forwardedProps: {},
    expectedPPL: testCase.expectedPPL,
    expectedOutcomes: testCase.expectedOutcomes,
    expectedTrajectory: testCase.expectedTrajectory,
    labels,
    // Legacy fields - kept for backward compatibility
    category: testCase.category,
    subcategory: testCase.subcategory,
    difficulty: testCase.difficulty,
    tags,
    author: (testCase as CreateTestCaseInput).author,
  };
}

/** Paginated response from getAll with summary/pagination options */
export interface TestCasePage {
  testCases: TestCase[];
  total: number;
  after?: string | null;
  hasMore?: boolean;
}

class AsyncTestCaseStorage {
  // ==================== Core CRUD Operations ====================

  /**
   * Get all test cases (latest versions), sorted by updatedAt descending
   * @param options.summary - true to fetch lightweight summary (no context/expectedOutcomes)
   * @param options.size - page size for pagination
   * @param options.after - cursor token for next page
   */
  async getAll(options: { summary?: boolean; size: number; after?: string }): Promise<TestCasePage>;
  async getAll(options?: { summary?: boolean; size?: number; after?: string }): Promise<TestCase[]>;
  async getAll(options?: { summary?: boolean; size?: number; after?: string }): Promise<TestCase[] | TestCasePage> {
    const isPaginated = options?.size !== undefined;
    const result = await opensearchTestCases.getAll({
      fields: options?.summary ? 'summary' : undefined,
      size: options?.size,
      after: options?.after,
    });
    const testCases = result.testCases.map(toTestCase);
    // Sort by updatedAt descending (most recent first)
    const sorted = testCases.sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()
    );

    if (isPaginated) {
      return {
        testCases: sorted,
        total: result.total,
        after: result.after,
        hasMore: result.hasMore,
      };
    }
    return sorted;
  }

  /**
   * Get only promoted test cases (for Experiments)
   */
  async getPromoted(): Promise<TestCase[]> {
    const all = await this.getAll();
    return all.filter(tc => tc.isPromoted);
  }

  /**
   * Get test cases by specific IDs (for efficient filtered fetching)
   * Used when you only need test cases for a specific benchmark
   */
  async getByIds(ids: string[]): Promise<TestCase[]> {
    if (ids.length === 0) return [];

    const stored = await opensearchTestCases.getByIds(ids);
    const testCases = stored.map(toTestCase);
    // Maintain order of requested IDs
    const idOrder = new Map(ids.map((id, index) => [id, index]));
    return testCases.sort((a, b) =>
      (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity)
    );
  }

  /**
   * Get a test case by ID (latest version)
   */
  async getById(id: string): Promise<TestCase | null> {
    const stored = await opensearchTestCases.getById(id);
    return stored ? toTestCase(stored) : null;
  }

  /**
   * Create a new test case
   */
  async create(input: CreateTestCaseInput): Promise<TestCase> {
    const storageData = toStorageFormat(input);
    const created = await opensearchTestCases.create(storageData as Omit<StorageTestCase, 'id' | 'version' | 'createdAt' | 'updatedAt'>);
    return toTestCase(created);
  }

  /**
   * Update a test case (creates new version automatically in OpenSearch)
   */
  async update(id: string, updates: UpdateTestCaseInput): Promise<TestCase | null> {
    // First get current to merge with updates
    const current = await opensearchTestCases.getById(id);
    if (!current) {
      return null;
    }

    const merged: Partial<StorageTestCase> = {
      ...current,
      ...toStorageFormat(updates),
    };

    // Remove fields that shouldn't be sent
    delete (merged as Record<string, unknown>).id;
    delete (merged as Record<string, unknown>).version;
    delete (merged as Record<string, unknown>).createdAt;
    delete (merged as Record<string, unknown>).updatedAt;

    const updated = await opensearchTestCases.update(id, merged);
    return toTestCase(updated);
  }

  /**
   * Delete a test case (all versions)
   */
  async delete(id: string): Promise<boolean> {
    const result = await opensearchTestCases.delete(id);
    return result.deleted > 0;
  }

  /**
   * Set promoted status for a test case
   */
  async setPromoted(id: string, isPromoted: boolean): Promise<boolean> {
    const current = await opensearchTestCases.getById(id);
    if (!current) {
      return false;
    }

    const tags = current.tags || [];
    if (isPromoted && !tags.includes('promoted')) {
      tags.push('promoted');
    } else if (!isPromoted) {
      const idx = tags.indexOf('promoted');
      if (idx > -1) tags.splice(idx, 1);
    }

    await opensearchTestCases.update(id, { ...current, tags });
    return true;
  }

  // ==================== Version Operations ====================

  /**
   * Get all versions of a test case
   */
  async getVersions(testCaseId: string): Promise<TestCaseVersion[]> {
    const stored = await opensearchTestCases.getVersions(testCaseId);
    return stored.map(s => ({
      version: s.version,
      createdAt: s.createdAt,
      initialPrompt: s.initialPrompt,
      context: (s.context || []) as AgentContextItem[],
      tools: s.tools as AgentToolDefinition[] | undefined,
      expectedPPL: s.expectedPPL,
      expectedOutcomes: s.expectedOutcomes,  // NEW
      expectedTrajectory: (s.expectedTrajectory || []) as TestCaseVersion['expectedTrajectory'],
    }));
  }

  /**
   * Get a specific version of a test case
   */
  async getVersion(testCaseId: string, version: number): Promise<TestCaseVersion | null> {
    const stored = await opensearchTestCases.getVersion(testCaseId, version);
    if (!stored) return null;

    return {
      version: stored.version,
      createdAt: stored.createdAt,
      initialPrompt: stored.initialPrompt,
      context: (stored.context || []) as AgentContextItem[],
      tools: stored.tools as AgentToolDefinition[] | undefined,
      expectedPPL: stored.expectedPPL,
      expectedOutcomes: stored.expectedOutcomes,  // NEW
      expectedTrajectory: (stored.expectedTrajectory || []) as TestCaseVersion['expectedTrajectory'],
    };
  }

  // ==================== Utility Methods ====================

  /**
   * Generate a unique ID
   */
  generateId(): string {
    return `tc-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Get unique categories from all test cases
   * @deprecated Use getLabels() instead
   */
  async getCategories(): Promise<string[]> {
    const testCases = await this.getAll();
    const categories = new Set<string>();
    testCases.forEach(tc => categories.add(tc.category));
    return Array.from(categories).sort();
  }

  /**
   * Get all unique labels from all test cases
   */
  async getLabels(): Promise<string[]> {
    const testCases = await this.getAll();
    const labels = new Set<string>();
    testCases.forEach(tc => tc.labels?.forEach(l => labels.add(l)));
    return Array.from(labels).sort();
  }

  /**
   * Get test cases count
   */
  async getCount(): Promise<number> {
    const testCases = await this.getAll();
    return testCases.length;
  }

  /**
   * Get promoted count
   */
  async getPromotedCount(): Promise<number> {
    const promoted = await this.getPromoted();
    return promoted.length;
  }

  /**
   * Bulk create test cases (for migration)
   */
  async bulkCreate(testCases: CreateTestCaseInput[]): Promise<{ created: number; errors: boolean }> {
    const storageData = testCases.map(tc => toStorageFormat(tc));
    return opensearchTestCases.bulkCreate(storageData);
  }
}

// Export singleton instance
export const asyncTestCaseStorage = new AsyncTestCaseStorage();
