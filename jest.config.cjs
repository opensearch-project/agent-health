/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^@/lib/config$': '<rootDir>/__mocks__/@/lib/config.ts',
    // Mock configService to avoid import.meta.url issues in Jest
    // Must catch: @/server/services/configService, ../services/configService.js, ../../services/configService.js
    '^@/server/services/configService$': '<rootDir>/__mocks__/@/server/services/configService.ts',
    '^\\.\\./services/configService\\.js$': '<rootDir>/__mocks__/@/server/services/configService.ts',
    '^\\.\\./\\.\\./services/configService\\.js$': '<rootDir>/__mocks__/@/server/services/configService.ts',
    // Mock version utility to avoid import.meta.url issues in Jest
    '^@/server/utils/version$': '<rootDir>/__mocks__/@/server/utils/version.ts',
    '^\\.\\./utils/version$': '<rootDir>/__mocks__/@/server/utils/version.ts',
    '^\\.\\./utils/version\\.js$': '<rootDir>/__mocks__/@/server/utils/version.ts',
    // Mock data files to avoid JSON import issues in tests
    '^@/data/testCases$': '<rootDir>/__mocks__/@/data/testCases.ts',
    '^@/data/mockComparisonData$': '<rootDir>/__mocks__/@/data/mockComparisonData.ts',
    '^@/(.*)$': '<rootDir>/$1',
    // Mock browser-only modules
    '^dagre$': '<rootDir>/__mocks__/dagre.ts',
    '^@xyflow/react$': '<rootDir>/__mocks__/xyflow-react.ts',
    // Mock OpenTelemetry incubating module (not installed by default)
    '^@opentelemetry/semantic-conventions/incubating$': '<rootDir>/__mocks__/@opentelemetry/semantic-conventions/incubating.ts',
    // Handle .js imports resolving to .ts files (ESM compatibility)
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
    }],
  },
  // Skip node_modules except for specific packages that need transformation
  transformIgnorePatterns: [
    'node_modules/(?!(your-esm-packages)/)',
  ],
  // Increase timeout for integration tests
  testTimeout: 30000,
  // Verbose output
  verbose: true,
  // Force exit after tests complete (for integration tests with SSE streams)
  forceExit: true,
  // Coverage configuration
  collectCoverageFrom: [
    'services/**/*.ts',
    'server/**/*.ts',
    'lib/**/*.ts',
    'cli/**/*.ts',
    'types/**/*.ts',
    '!**/__tests__/**',
    '!**/*.test.ts',
    '!**/dist/**',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      // Enforce 90% coverage for production quality
      branches: 80,
      functions: 80,
      lines: 90,
      statements: 90,
    },
  },
};
