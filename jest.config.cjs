/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^@/lib/config$': '<rootDir>/__mocks__/@/lib/config.ts',
    // Mock packagePaths to avoid import.meta.url issues in Jest
    '^@/lib/packagePaths$': '<rootDir>/__mocks__/@/lib/packagePaths.ts',
    '^\.\./packagePaths\.js$': '<rootDir>/__mocks__/@/lib/packagePaths.ts',
    '^\.\./\.\./packagePaths\.js$': '<rootDir>/__mocks__/@/lib/packagePaths.ts',
    // Mock configService to avoid import.meta.url issues in Jest
    // Must catch: @/server/services/configService, ../services/configService.js, ../../services/configService.js
    '^@/server/services/configService$': '<rootDir>/__mocks__/@/server/services/configService.ts',
    '^\\.\\./services/configService\\.js$': '<rootDir>/__mocks__/@/server/services/configService.ts',
    '^\\.\\./\\.\\./services/configService\\.js$': '<rootDir>/__mocks__/@/server/services/configService.ts',
    // Mock observioAgent to avoid import.meta.url issues in Jest
    '^@/server/services/observioAgent$': '<rootDir>/__mocks__/@/server/services/observioAgent.ts',
    '^\\.\\./services/observioAgent\\.js$': '<rootDir>/__mocks__/@/server/services/observioAgent.ts',
    '^\\.\\./\\.\\./services/observioAgent\\.js$': '<rootDir>/__mocks__/@/server/services/observioAgent.ts',
    // Mock version utility to avoid import.meta.url issues in Jest
    '^@/server/utils/version$': '<rootDir>/__mocks__/@/server/utils/version.ts',
    '^\\.\\./utils/version$': '<rootDir>/__mocks__/@/server/utils/version.ts',
    '^\\.\\./utils/version\\.js$': '<rootDir>/__mocks__/@/server/utils/version.ts',
    // Mock piBinary to avoid import.meta.url issues in Jest
    '^@/server/services/piBinary$': '<rootDir>/__mocks__/@/server/services/piBinary.ts',
    '^\./piBinary$': '<rootDir>/__mocks__/@/server/services/piBinary.ts',
    '^\./piBinary\.js$': '<rootDir>/__mocks__/@/server/services/piBinary.ts',
    // Mock data files to avoid JSON import issues in tests
    '^@/data/testCases$': '<rootDir>/__mocks__/@/data/testCases.ts',
    '^@/data/mockComparisonData$': '<rootDir>/__mocks__/@/data/mockComparisonData.ts',
    // Handle .js extension in @/ imports (ESM compatibility for CLI commands)
    '^@/(.*)\\.js$': '<rootDir>/$1',
    '^@/(.*)$': '<rootDir>/$1',
    // Mock browser-only modules
    '^dagre$': '<rootDir>/__mocks__/dagre.ts',
    '^@xyflow/react$': '<rootDir>/__mocks__/xyflow-react.ts',
    // Mock OpenTelemetry incubating module (not installed by default)
    '^@opentelemetry/semantic-conventions/incubating$': '<rootDir>/__mocks__/@opentelemetry/semantic-conventions/incubating.ts',
    // Mock chai (chai@5 is ESM-only and Jest's CJS loader can't import
    // it; route to the chai@4 alias for tests via __mocks__/chai.ts)
    '^chai$': '<rootDir>/__mocks__/chai.ts',
    // Mock typebox (ESM-only; Jest CJS loader can't import it)
    '^typebox$': '<rootDir>/__mocks__/typebox.ts',
    // Mock uuid (v14 is ESM-only, incompatible with Jest CJS transform)
    '^uuid$': '<rootDir>/__mocks__/uuid.ts',
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
    'node_modules/(?!(chai|check-error|loupe|deep-eql|pathval|assertion-error)/)',
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
    // Component coverage is currently opt-in while the global baseline is
    // expanded incrementally. Include the run-visibility surfaces so their
    // focused DOM tests contribute to the combined project report.
    'components/evals3/BenchmarkRunsPage.tsx',
    'components/evals3/EvalRunsPage.tsx',
    'components/evals3/RunningRunIndicator.tsx',
    '!**/__tests__/**',
    '!**/*.test.ts',
    '!**/dist/**',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      // HONEST BASELINE (#339 coverage-repair). The previous 90/90/80/80 was
      // never actually met by `npm run test:unit` — the old CI piped jest
      // through `tee`, so the coverage-threshold failure (real unit coverage is
      // ~71% stmts / 61% branches, because integration-owned paths like
      // cli/commands, server/routes, server/adapters/{file,opensearch},
      // server/services/codingAgents and services/connectors/pi are covered by
      // the separate integration-tests job, not unit) was silently swallowed.
      // These thresholds are set just below the current real unit coverage so
      // CI enforces a no-regression ratchet that is honestly green. Raise them
      // incrementally as unit coverage improves (tracked as a follow-up).
      branches: 60,
      functions: 65,
      lines: 70,
      statements: 70,
    },
  },
};
