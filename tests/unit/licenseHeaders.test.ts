/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * License Header Validation Tests
 *
 * Ensures all source files comply with OpenSearch licensing requirements:
 * 1. All source files must have SPDX license headers
 * 2. Files with shebangs must have shebang on line 1
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.resolve(__dirname, '../..');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.css'];
const EXCLUDED_DIRS = ['node_modules', 'dist', 'build', 'coverage', '.git', 'server/dist', 'cli/dist', 'lib/dist'];

const SPDX_IDENTIFIER = 'SPDX-License-Identifier: Apache-2.0';
const COPYRIGHT_NOTICE = 'Copyright OpenSearch Contributors';

/**
 * Recursively find all source files
 */
function findSourceFiles(dir: string, files: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(ROOT_DIR, fullPath);

    // Skip excluded directories
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.some((excluded) => relativePath.startsWith(excluded))) {
        findSourceFiles(fullPath, files);
      }
      continue;
    }

    // Check if it's a source file
    const ext = path.extname(entry.name);
    if (SOURCE_EXTENSIONS.includes(ext)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Check if file content starts with a shebang
 */
function hasShebang(content: string): boolean {
  return content.startsWith('#!');
}

/**
 * Check if shebang is on line 1
 */
function isShebangOnLine1(content: string): boolean {
  const lines = content.split('\n');
  return lines[0].startsWith('#!');
}

/**
 * Check if file has SPDX license header
 */
function hasSpdxHeader(content: string): boolean {
  // Check first 500 chars for the header (should be near top)
  const header = content.slice(0, 500);
  return header.includes(SPDX_IDENTIFIER) && header.includes(COPYRIGHT_NOTICE);
}

/**
 * Find shebang position in file
 */
function findShebangLine(content: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#!')) {
      return i + 1; // 1-indexed
    }
  }
  return -1;
}

describe('License Header Validation', () => {
  let sourceFiles: string[];

  beforeAll(() => {
    sourceFiles = findSourceFiles(ROOT_DIR);
  });

  it('should find source files to validate', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    console.log(`Found ${sourceFiles.length} source files to validate`);
  });

  it('all source files should have SPDX license headers', () => {
    const filesWithoutHeaders: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (!hasSpdxHeader(content)) {
        filesWithoutHeaders.push(path.relative(ROOT_DIR, file));
      }
    }

    if (filesWithoutHeaders.length > 0) {
      console.error('Files missing SPDX license headers:');
      filesWithoutHeaders.forEach((f) => console.error(`  - ${f}`));
    }

    expect(filesWithoutHeaders).toEqual([]);
  });

  it('files with shebangs should have shebang on line 1', () => {
    const filesWithMisplacedShebang: { file: string; line: number }[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');

      // Only check files that have a shebang somewhere
      if (hasShebang(content) || content.includes('#!')) {
        const shebangLine = findShebangLine(content);
        if (shebangLine > 1) {
          filesWithMisplacedShebang.push({
            file: path.relative(ROOT_DIR, file),
            line: shebangLine,
          });
        }
      }
    }

    if (filesWithMisplacedShebang.length > 0) {
      console.error('Files with shebang not on line 1:');
      filesWithMisplacedShebang.forEach(({ file, line }) =>
        console.error(`  - ${file} (shebang on line ${line})`)
      );
    }

    expect(filesWithMisplacedShebang).toEqual([]);
  });

  it('shell scripts should have license headers after shebang', () => {
    const shellFiles = sourceFiles.filter((f) => f.endsWith('.sh'));
    const filesWithIssues: string[] = [];

    for (const file of shellFiles) {
      const content = fs.readFileSync(file, 'utf-8');

      // Shell files should have shebang on line 1
      if (!isShebangOnLine1(content)) {
        filesWithIssues.push(`${path.relative(ROOT_DIR, file)} - missing shebang on line 1`);
        continue;
      }

      // And should have license header
      if (!content.includes(SPDX_IDENTIFIER)) {
        filesWithIssues.push(`${path.relative(ROOT_DIR, file)} - missing SPDX header`);
      }
    }

    if (filesWithIssues.length > 0) {
      console.error('Shell script issues:');
      filesWithIssues.forEach((issue) => console.error(`  - ${issue}`));
    }

    expect(filesWithIssues).toEqual([]);
  });
});
