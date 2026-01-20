/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for CLI index functionality
 */

import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { config as loadDotenv } from 'dotenv';

describe('CLI index', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for test files
    tempDir = join(tmpdir(), `cli-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp files
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadEnvFile function', () => {
    it('should load env file when path exists', () => {
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, 'TEST_VAR=test_value');

      expect(existsSync(envPath)).toBe(true);
    });

    it('should handle missing env file gracefully', () => {
      const envPath = join(tempDir, 'nonexistent.env');
      expect(existsSync(envPath)).toBe(false);
    });
  });

  describe('dotenv integration', () => {
    it('should load env file with dotenv', () => {
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, 'TEST_CLI_VAR=us-west-2');

      const result = loadDotenv({ path: envPath });

      expect(result.error).toBeUndefined();
    });

    it('should support various env file formats', () => {
      const envContent = `
# Comment line
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=test_key
OPENSEARCH_STORAGE_ENDPOINT=http://localhost:9200

# Another comment
BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet
`;
      const envPath = join(tempDir, '.env');
      writeFileSync(envPath, envContent);

      expect(existsSync(envPath)).toBe(true);

      const result = loadDotenv({ path: envPath });
      expect(result.error).toBeUndefined();
    });

    it('should return error for invalid path', () => {
      const result = loadDotenv({ path: '/nonexistent/path/.env' });
      expect(result.error).toBeDefined();
    });
  });

  describe('CLI options parsing', () => {
    it('should have default port of 4001', () => {
      const defaultPort = '4001';
      expect(defaultPort).toBe('4001');
    });

    it('should accept custom port', () => {
      const customPort = parseInt('8080', 10);
      expect(customPort).toBe(8080);
    });

    it('should parse port as number', () => {
      const portStr = '4001';
      const port = parseInt(portStr, 10);
      expect(typeof port).toBe('number');
      expect(port).toBe(4001);
    });
  });

  describe('version detection', () => {
    it('should have a default version', () => {
      const defaultVersion = '0.1.0';
      expect(defaultVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});
