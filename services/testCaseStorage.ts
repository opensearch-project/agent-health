/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TestCase, TestCaseVersion, TestCaseFixture, AgentContextItem, AgentToolDefinition } from '@/types';
import { TEST_CASES } from '@/data/testCases';

// Storage keys
const TEST_CASES_KEY = 'test_cases';
const SEEDED_KEY = 'test_cases_seeded';
const MIGRATION_V1_KEY = 'test_cases_migration_v1'; // Set all predefined test cases to isPromoted=true

// Input type for creating a test case (without generated fields)
export interface CreateTestCaseInput {
  name: string;
  description: string;
  labels?: string[];
  category: string;
  subcategory?: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  initialPrompt: string;
  context: AgentContextItem[];
  fixture?: TestCaseFixture;
  tools?: AgentToolDefinition[];
  expectedPPL?: string;
  expectedTrajectory: {
    step: number;
    description: string;
    requiredTools: string[];
  }[];
  followUpQuestions?: {
    trigger: 'results_available' | 'error' | 'always';
    question: string;
    businessValue: string;
  }[];
  isPromoted?: boolean;
}

// Input type for updating a test case (creates new version)
export interface UpdateTestCaseInput {
  name?: string;
  description?: string;
  category?: string;
  subcategory?: string;
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  initialPrompt?: string;
  context?: AgentContextItem[];
  fixture?: TestCaseFixture;
  tools?: AgentToolDefinition[];
  expectedPPL?: string;
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
}

class TestCaseStorage {
  constructor() {
    this.seedIfNeeded();
    this.runMigrations();
  }

  /**
   * Seed localStorage with predefined test cases on first load
   */
  private seedIfNeeded(): void {
    const seeded = localStorage.getItem(SEEDED_KEY);
    if (!seeded) {
      // First time - seed with predefined test cases if localStorage is empty
      const existing = this.getAll();
      if (existing.length === 0) {
        this.saveAll(TEST_CASES);
      }
      localStorage.setItem(SEEDED_KEY, 'true');
    }
  }

  /**
   * Run data migrations for existing localStorage data
   */
  private runMigrations(): void {
    // Migration v1: Set isPromoted=true for all predefined test cases
    // This fixes data seeded before the default was changed to true
    const migrationV1Done = localStorage.getItem(MIGRATION_V1_KEY);
    if (!migrationV1Done) {
      const testCases = this.getAll();
      const predefinedIds = new Set(TEST_CASES.map(tc => tc.id));

      let changed = false;
      testCases.forEach(tc => {
        // Only update predefined test cases that were seeded with isPromoted=false
        if (predefinedIds.has(tc.id) && !tc.isPromoted) {
          tc.isPromoted = true;
          changed = true;
        }
      });

      if (changed) {
        this.saveAll(testCases);
      }
      localStorage.setItem(MIGRATION_V1_KEY, 'true');
    }
  }

  // ==================== Core CRUD Operations ====================

  /**
   * Get all user test cases from localStorage
   */
  getAll(): TestCase[] {
    try {
      const data = localStorage.getItem(TEST_CASES_KEY);
      if (!data) {
        return [];
      }
      return JSON.parse(data);
    } catch (error) {
      console.error('Error parsing test cases:', error);
      return [];
    }
  }

  /**
   * Get only promoted test cases (for Experiments)
   */
  getPromoted(): TestCase[] {
    return this.getAll().filter(tc => tc.isPromoted);
  }

  /**
   * Get a test case by ID
   */
  getById(id: string): TestCase | null {
    const testCases = this.getAll();
    return testCases.find(tc => tc.id === id) || null;
  }

  /**
   * Create a new test case
   */
  create(input: CreateTestCaseInput): TestCase {
    const now = new Date().toISOString();
    const id = this.generateId();

    // Create first version
    const version: TestCaseVersion = {
      version: 1,
      createdAt: now,
      initialPrompt: input.initialPrompt,
      context: input.context,
      fixture: input.fixture,
      tools: input.tools,
      expectedPPL: input.expectedPPL,
      expectedTrajectory: input.expectedTrajectory,
      followUpQuestions: input.followUpQuestions,
    };

    // Build labels from input or create default
    const labels = input.labels || [
      `difficulty:${input.difficulty}`,
      `category:${input.category}`,
      ...(input.subcategory ? [`subcategory:${input.subcategory}`] : []),
    ];

    // Create test case with version
    const testCase: TestCase = {
      id,
      name: input.name,
      description: input.description,
      labels,
      category: input.category,
      subcategory: input.subcategory,
      difficulty: input.difficulty,
      currentVersion: 1,
      versions: [version],
      isPromoted: input.isPromoted ?? false,
      createdAt: now,
      updatedAt: now,
      // Current version content (mirrors latest version)
      initialPrompt: input.initialPrompt,
      context: input.context,
      fixture: input.fixture,
      tools: input.tools,
      expectedPPL: input.expectedPPL,
      expectedTrajectory: input.expectedTrajectory,
      followUpQuestions: input.followUpQuestions,
    };

    // Save to storage
    const testCases = this.getAll();
    testCases.push(testCase);
    this.saveAll(testCases);

    return testCase;
  }

  /**
   * Update a test case (creates new version for content changes)
   */
  update(id: string, updates: UpdateTestCaseInput): TestCase | null {
    const testCases = this.getAll();
    const index = testCases.findIndex(tc => tc.id === id);

    if (index === -1) {
      return null;
    }

    const existing = testCases[index];
    const now = new Date().toISOString();

    // Check if content fields changed (requires new version)
    const contentFields: (keyof UpdateTestCaseInput)[] = [
      'initialPrompt',
      'context',
      'fixture',
      'tools',
      'expectedPPL',
      'expectedTrajectory',
      'followUpQuestions',
    ];

    const hasContentChanges = contentFields.some(field => {
      if (updates[field] === undefined) return false;
      return JSON.stringify(updates[field]) !== JSON.stringify(existing[field]);
    });

    if (hasContentChanges) {
      // Create new version
      const newVersionNumber = existing.currentVersion + 1;
      const newVersion: TestCaseVersion = {
        version: newVersionNumber,
        createdAt: now,
        initialPrompt: updates.initialPrompt ?? existing.initialPrompt,
        context: updates.context ?? existing.context,
        fixture: updates.fixture ?? existing.fixture,
        tools: updates.tools ?? existing.tools,
        expectedPPL: updates.expectedPPL ?? existing.expectedPPL,
        expectedTrajectory: updates.expectedTrajectory ?? existing.expectedTrajectory,
        followUpQuestions: updates.followUpQuestions ?? existing.followUpQuestions,
      };

      existing.versions.push(newVersion);
      existing.currentVersion = newVersionNumber;

      // Update current version content fields
      existing.initialPrompt = newVersion.initialPrompt;
      existing.context = newVersion.context;
      existing.fixture = newVersion.fixture;
      existing.tools = newVersion.tools;
      existing.expectedPPL = newVersion.expectedPPL;
      existing.expectedTrajectory = newVersion.expectedTrajectory;
      existing.followUpQuestions = newVersion.followUpQuestions;
    }

    // Update metadata fields (no versioning)
    if (updates.name !== undefined) existing.name = updates.name;
    if (updates.description !== undefined) existing.description = updates.description;
    if (updates.category !== undefined) existing.category = updates.category;
    if (updates.subcategory !== undefined) existing.subcategory = updates.subcategory;
    if (updates.difficulty !== undefined) existing.difficulty = updates.difficulty;

    existing.updatedAt = now;

    testCases[index] = existing;
    this.saveAll(testCases);

    return existing;
  }

  /**
   * Delete a test case
   */
  delete(id: string): boolean {
    const testCases = this.getAll();
    const index = testCases.findIndex(tc => tc.id === id);

    if (index === -1) {
      return false;
    }

    testCases.splice(index, 1);
    this.saveAll(testCases);
    return true;
  }

  /**
   * Set promoted status for a test case
   */
  setPromoted(id: string, isPromoted: boolean): boolean {
    const testCases = this.getAll();
    const testCase = testCases.find(tc => tc.id === id);

    if (!testCase) {
      return false;
    }

    testCase.isPromoted = isPromoted;
    testCase.updatedAt = new Date().toISOString();
    this.saveAll(testCases);
    return true;
  }

  // ==================== Version Operations ====================

  /**
   * Get a specific version of a test case
   */
  getVersion(testCaseId: string, version: number): TestCaseVersion | null {
    const testCase = this.getById(testCaseId);
    if (!testCase) return null;
    return testCase.versions.find(v => v.version === version) || null;
  }

  /**
   * Get all versions of a test case
   */
  getVersions(testCaseId: string): TestCaseVersion[] {
    const testCase = this.getById(testCaseId);
    if (!testCase) return [];
    return [...testCase.versions].sort((a, b) => b.version - a.version);
  }

  // ==================== Utility Methods ====================

  /**
   * Generate a unique ID
   */
  generateId(): string {
    return `tc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get unique categories from all test cases
   */
  getCategories(): string[] {
    const testCases = this.getAll();
    const categories = new Set<string>();
    testCases.forEach(tc => categories.add(tc.category));
    return Array.from(categories).sort();
  }

  /**
   * Get test cases count
   */
  getCount(): number {
    return this.getAll().length;
  }

  /**
   * Get promoted count
   */
  getPromotedCount(): number {
    return this.getPromoted().length;
  }

  // ==================== Private Helpers ====================

  private saveAll(testCases: TestCase[]): void {
    try {
      localStorage.setItem(TEST_CASES_KEY, JSON.stringify(testCases));
    } catch (error) {
      console.error('Error saving test cases:', error);
      throw new Error(`Failed to save test cases: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// Export singleton instance
export const testCaseStorage = new TestCaseStorage();
